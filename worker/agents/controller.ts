import type { EntryRecord } from "@earendil-works/pi-durable";
import { MAX_HOPS, type AgentDefinition, type ChatAgentReplyData, type ChatTurnData } from "../../shared/agents.ts";
import { AGENT_NAME } from "../../shared/mentions.ts";
import { errorMessage, serial } from "../../shared/util.ts";
import type { AgentTurn, ChatRoster, RosterEntry, TurnRequest } from "./roster.ts";
import type { SeatBatch, SeatLink, SeatResult } from "./seats/link.ts";
import { askOf, CatchUp, entryAskKey, handOffs, itemsIn, MAX_ASK_CHARS, publishedIn, turnAskKey, turnInput } from "./turns.ts";

/**
 * What a turn left in its session for its reply to show: the pages it published, the records its results held, the
 * private servers it called (a fork's), and whether its owner reviews it before it is posted.
 */
export type Outputs = Required<Pick<ChatAgentReplyData, "published" | "items" | "sources">> & { review?: boolean };
const NO_OUTPUTS: Outputs = { published: [], items: [], sources: [] };

/** How one operation in an agent's session ended, as PiHarness.wait says. */
export interface TurnResult {
  status: "done" | "unanswered";
  text?: string;
  reason?: string;
}

/** What the turn controller needs from the chat object it runs in: pi's sessions, the log, and the owner's directory. */
export interface TurnHost {
  readonly roster: ChatRoster;
  /** The owner's current definition of an agent; null when it is gone. */
  definition(entry: RosterEntry): Promise<AgentDefinition | null>;
  /** Set an agent's session up for a turn: its model and effort, its instructions, and the tools the turn may use. */
  configure(entry: RosterEntry, agent: AgentDefinition, turn: AgentTurn): Promise<void>;
  /** The chat's log (the root conversation) after entry `after`, a page at a time, newest first. */
  logSince(after: number): AsyncIterable<readonly EntryRecord[]>;
  /** A passive write into a session: context, no run. `requestId` keeps a retry from placing it twice. */
  write(session: string, text: string, requestId: string): Promise<void>;
  /** The turn's input into its session, which starts its run. */
  submit(session: string, input: string, operationId: string, data: ChatTurnData): Promise<void>;
  /** Wait for an operation of a session to settle. */
  wait(session: string, operationId: string): Promise<TurnResult>;
  /** Stop what a session runs, and what waits in its inbox. */
  abort(session: string): Promise<void>;
  /** The session's entries from the turn's input on (its chat.turn entry), oldest first: where its outputs are found. */
  turnEntries(session: string, turn: number): Promise<readonly EntryRecord[]>;
  /** Post an agent's reply to the log, placed once however often it is posted. */
  post(reply: ChatAgentReplyData): Promise<void>;
  /** Write an agent's reply as context pi reads, placed once however often (not when pi is handed a turn for it). */
  tellPi(reply: ChatAgentReplyData): Promise<void>;
  /** Give pi a turn an agent named it for (`data.turn`, that agent's turn): placed once however often it is handed. */
  handToPi(input: string, data: ChatTurnData): Promise<void>;
  /** The roster's view changed (an agent started or ended a turn, or was dropped): tell everyone. */
  changed(): void;
  /**
   * Whether a turn its owner asked for may reach a server outside the agent's shared list (forksFor): it then runs in a
   * fork of the agent's session. Without it, no turn forks.
   */
  forks?(entry: RosterEntry, agent: AgentDefinition, turn: AgentTurn): Promise<boolean>;
  /** A new session that sees `session`'s history so far. */
  fork?(session: string): Promise<string>;
  /**
   * What a forked turn's reply shows of its sources (turnSources), from its session's entries: only the shared servers'
   * records, the private servers it called, and whether its owner reviews it first. Without it: every record, no sources.
   */
  sources?(entry: RosterEntry, entries: readonly EntryRecord[]): Promise<Pick<Outputs, "items" | "sources" | "review">>;
  /** The seat of an agent that runs in its owner's own object (a member's: `entry.seat`). */
  seat?(entry: RosterEntry): SeatLink;
  /** Whether `uid` may give this agent another turn now (a per-person rate limit). Without it, always. */
  mayCall?(entry: RosterEntry, uid: string): Promise<boolean>;
  /** A reply of an agent of `ownerUid`'s is held for them to review, or no longer is: tell them. */
  drafted?(ownerUid: string): void;
  /** Keep the object alive for work that outlives the call that started it. */
  waitUntil(promise: Promise<unknown>): void;
}

/**
 * Who gives agents turns, as `call` takes it: their request, less the agent; `hop` is 0 unless said. A person's message
 * gives a turn to each agent it calls, whoever's they are: whether its owner asked, and how its ask is labelled ("your
 * owner"), may then differ per agent.
 */
export type Caller = Omit<TurnRequest, "agentId" | "hop" | "byOwner" | "ask"> & {
  hop?: number;
  byOwner: boolean | ((entry: RosterEntry) => boolean);
  ask: string | ((byOwner: boolean) => string);
};

/**
 * The chat's turn controller for the agents of its roster (not pi, whose turns are pi's own inbox). Each agent takes
 * one turn at a time from a queue in the chat's SQLite: before a turn, its session reads what was said since its last
 * one and is set up for whoever asked; its final answer is posted to the log, and the agents it names get the next
 * turns, within MAX_HOPS hand-offs per chain. A turn survives a restart: `resume` waits on running turns again, and
 * delivers the replies of ended ones not delivered yet.
 */
export class AgentTurns {
  readonly #host: TurnHost;
  /** Per agent, its turns started one at a time, so two never start at once. */
  readonly #pumps = new Map<string, () => Promise<void>>();
  /** The turns this object waits on, so a resume does not wait on one twice. */
  readonly #waiting = new Set<number>();

  constructor(host: TurnHost) {
    this.#host = host;
  }

  /** Queue a turn for each agent, in order, and start them. */
  call(agentIds: readonly string[], caller: Caller): AgentTurn[] {
    // The turns one message gives share one chain, so its hand-offs stay within MAX_HOPS however many agents it names:
    // without one of their own, the first turn starts it for the rest.
    let root = caller.root;
    const turns = agentIds.flatMap((agentId) => {
      const entry = this.#host.roster.get(agentId);
      if (!entry) return [];
      const byOwner = typeof caller.byOwner === "function" ? caller.byOwner(entry) : caller.byOwner;
      const ask = typeof caller.ask === "function" ? caller.ask(byOwner) : caller.ask;
      const turn = this.#host.roster.enqueue({ ...caller, agentId, byOwner, ask, hop: caller.hop ?? 0, root });
      root ??= turn.id;
      return [turn];
    });
    if (turns.length) this.#host.changed();
    for (const turn of turns) this.pump(turn.agentId);
    return turns;
  }

  /** Start an agent's next turn when it has none running. Never throws: a failed start fails that turn. */
  pump(agentId: string): Promise<void> {
    let pump = this.#pumps.get(agentId);
    if (!pump) {
      pump = serial(() => this.#startNext(agentId).catch((error: unknown) => console.error("agent turn:", errorMessage(error))));
      this.#pumps.set(agentId, pump);
    }
    const started = pump();
    this.#host.waitUntil(started);
    return started;
  }

  async #startNext(agentId: string): Promise<void> {
    const roster = this.#host.roster;
    let entry = roster.get(agentId);
    if (!entry) return;
    const started = roster.startNext(agentId);
    if (!started) return;
    let turn: AgentTurn = started;
    this.#host.changed();
    // A person's Stop, or the agent leaving the roster, can end the turn at any await: it then goes no further.
    const live = () => roster.turn(started.id)?.status === "running";
    try {
      const agent = await this.#host.definition(entry);
      if (!live()) return;
      if (!agent) {
        // Its owner deleted it: it leaves the roster, and what waited for it with it.
        roster.remove(agentId);
        this.#host.changed();
        return;
      }
      const refreshed = roster.refresh(agentId, { name: agent.name, avatar: agent.avatar, color: agent.color, job: agent.job, off: !agent.enabled });
      if (!refreshed) return;
      entry = refreshed.entry;
      if (refreshed.changed) this.#host.changed();
      if (!agent.enabled) {
        await this.#ended(entry, turn, { status: "unanswered", reason: `its owner turned @${entry.name} off` });
        return;
      }
      const asker = turn.calledBy.uid;
      if (asker !== undefined && this.#host.mayCall && !(await this.#host.mayCall(entry, asker))) {
        await this.#ended(entry, turn, { status: "unanswered", reason: `@${entry.name} was asked too often just now; try again in a minute` });
        return;
      }
      if (!live()) return;
      if (entry.seat !== undefined) {
        // Its owner's own object runs it: the turn ends when the seat says so (seatEnded).
        await this.#giveSeat(entry, turn);
        if (!live())
          await this.#host.seat!(entry)
            .abort(turn.id)
            .catch((error: unknown) => console.error("agent stop:", errorMessage(error)));
        return;
      }
      const forks = turn.byOwner && this.#host.forks && this.#host.fork ? await this.#host.forks(entry, agent, turn) : false;
      if (forks) {
        // A fork sees the agent's session as it is when made: the catch-up goes in first.
        await this.#catchUp(entry, turn.id);
        const session = await this.#host.fork!(entry.session);
        if (!live()) return;
        roster.setSession(turn.id, session);
        turn = { ...turn, session };
        await this.#host.configure(entry, agent, turn);
      } else await Promise.all([this.#catchUp(entry, turn.id), this.#host.configure(entry, agent, turn)]);
      if (!live()) return;
      await this.#host.submit(sessionOf(entry, turn), turnInput(turn), operationId(turn.id), {
        turn: turn.id,
        calledBy: turn.calledBy,
        hop: turn.hop,
      });
      roster.markSubmitted(turn.id);
      if (!live()) {
        // Stopped while its input went in: the stop's abort may have come first, so the run it started stops too.
        await this.#host.abort(sessionOf(entry, turn)).catch((error: unknown) => console.error("agent stop:", errorMessage(error)));
        return;
      }
    } catch (error) {
      await this.#ended(entry, turn, { status: "unanswered", reason: errorMessage(error) });
      return;
    }
    this.#host.waitUntil(this.#await(entry, { ...turn, submitted: true }));
  }

  /**
   * Give a seat its turn: first what was said since it last read (its seat fills a gap itself), then the turn's input.
   * The seat ends it by calling `seatEnded`.
   */
  async #giveSeat(entry: RosterEntry, turn: AgentTurn): Promise<void> {
    const seat = this.#host.seat!(entry);
    const batch = await this.batchFor(entry, entry.mirrored, turn.id);
    if (batch.through > entry.mirrored) this.#host.roster.setMirrored(entry.agentId, await seat.deliver(batch));
    if (this.#host.roster.turn(turn.id)?.status !== "running") return;
    await seat.give({ turn: turn.id, calledBy: turn.calledBy, hop: turn.hop, input: turnInput(turn), byOwner: turn.byOwner });
    this.#host.roster.markSubmitted(turn.id);
  }

  /**
   * What an agent's session has to read of the log after entry `after`, for turn `turn` (CatchUp): read newest first,
   * and only as far back as the catch-up keeps. A seat pulls it to fill a gap.
   */
  async batchFor(entry: RosterEntry, after: number, turn: number): Promise<SeatBatch> {
    const catchUp = new CatchUp(entry.agentId, entry.ownerUid, this.#host.roster.askKeys(entry.agentId, turn));
    for await (const page of this.#host.logSince(after)) if (!catchUp.add(page)) break;
    const { text, through } = catchUp.result();
    return { from: after + 1, through: Math.max(through, after), text, turn };
  }

  /** Send an agent's session what was said in the log since its last turn, as one passive write. */
  async #catchUp(entry: RosterEntry, turn: number): Promise<void> {
    const { text, through } = await this.batchFor(entry, entry.mirrored, turn);
    if (through <= entry.mirrored) return;
    if (text) await this.#host.write(entry.session, text, `mirror:${entry.agentId}:${through}`);
    this.#host.roster.setMirrored(entry.agentId, through);
  }

  /**
   * A seat's turn ended (the seat calls this through its room): it ends here as a turn of this object's does. True once
   * taken, also when it was already or is gone, so the seat lets it go.
   */
  async seatEnded(agentId: string, id: number, result: SeatResult): Promise<boolean> {
    const roster = this.#host.roster;
    const entry = roster.get(agentId);
    const turn = roster.turn(id);
    if (!entry || entry.seat === undefined || turn?.agentId !== agentId) return true;
    const { published, items, sources, review, forked, ...ended } = result;
    await this.#ended(entry, turn, ended, { published, items, sources, ...(review && { review }) }, forked === true);
    return true;
  }

  /** Wait for a turn's run to end, then end it. */
  async #await(entry: RosterEntry, turn: AgentTurn): Promise<void> {
    if (this.#waiting.has(turn.id)) return;
    this.#waiting.add(turn.id);
    try {
      let result: TurnResult;
      try {
        result = await this.#host.wait(sessionOf(entry, turn), operationId(turn.id));
      } catch (error) {
        result = { status: "unanswered", reason: errorMessage(error) };
        // The run may still be going: stop it before the next turn sets the session up for someone else's tools.
        await this.#host.abort(sessionOf(entry, turn)).catch((abortError: unknown) => console.error("agent stop:", errorMessage(abortError)));
      }
      await this.#ended(entry, turn, result);
    } finally {
      this.#waiting.delete(turn.id);
    }
  }

  /**
   * A turn ended: it ends in the roster with its reply to deliver, and its hand-offs are queued, with no await in
   * between, so a restart never loses them or queues them twice; the reply is delivered after. Only once: a turn that
   * ended already (a second wait on it, a Stop meanwhile) delivers nothing.
   *
   * A reply built on a private server, of an agent whose owner reviews those, is held for them (`held`): it hands off
   * and is delivered only once they post it (`post`).
   */
  async #ended(entry: RosterEntry, turn: AgentTurn, result: TurnResult, outputs?: Outputs, seatForked = false): Promise<void> {
    const roster = this.#host.roster;
    const now = roster.turn(turn.id);
    let delivering: Promise<void> | undefined;
    if (now?.status === "running" || now?.status === "queued") {
      const done = result.status === "done";
      const text = (result.text ?? "").trim();
      const forked = seatForked || now.session !== undefined;
      // Only a turn whose input went in has outputs in its session.
      const { published, items, sources, review } = outputs ?? (now.submitted ? await this.#outputs(entry, now) : NO_OUTPUTS);
      const current = roster.get(entry.agentId) ?? entry;
      const reply: ChatAgentReplyData = {
        agentId: entry.agentId,
        name: current.name,
        avatar: current.avatar,
        color: current.color,
        ownerUid: current.ownerUid,
        text,
        calledBy: turn.calledBy,
        turn: turn.id,
        hop: turn.hop,
        startedAt: now.startedAt ?? now.createdAt,
        endedAt: roster.now(),
        ...(!done && { failed: result.reason ?? "it ended without an answer" }),
        ...(published.length && { published }),
        ...(items.length && { items }),
        ...(forked && { forked: true as const }),
        ...(sources.length && { sources }),
      };
      if (done && text && review && sources.length) {
        // Its owner sees it first: nothing of it reaches the chat, pi or other agents until they post it.
        if (roster.end(turn.id, "done", { reply, toPi: false, held: true })) this.#host.drafted?.(current.ownerUid);
      } else if (roster.end(turn.id, done ? "done" : "failed", { reply, toPi: false })) {
        delivering = this.#release(turn.id, reply, done);
      }
    }
    this.#host.changed();
    this.pump(entry.agentId);
    await delivering;
  }

  /**
   * An ended turn's reply goes to the chat: the agents it names get the next turns, within what its chain may still
   * make, and it is delivered. The turn ended in the roster just before, with no await in between, so a restart never
   * loses its hand-offs or queues them twice.
   */
  #release(id: number, reply: ChatAgentReplyData, done: boolean): Promise<void> {
    const roster = this.#host.roster;
    const turn = roster.turn(id)!;
    const left = MAX_HOPS - roster.handOffsFrom(turn.root);
    const next = done && left > 0 ? handOffs(reply.text, reply.agentId, turn.hop, roster.list()).slice(0, left) : [];
    roster.release(id, reply, next.includes(AGENT_NAME));
    const agents = next.filter((agentId) => agentId !== AGENT_NAME);
    // A hand-off can only read, whoever started the chain: agents cannot give each other permission.
    const ask = askOf({ name: reply.name, kind: "agent" }, reply.text, MAX_ASK_CHARS);
    const calledBy = { name: reply.name, agentId: reply.agentId };
    if (agents.length) this.call(agents, { calledBy, ask, askKey: turnAskKey(id), byOwner: false, hop: turn.hop + 1, root: turn.root });
    return this.#deliver(id);
  }

  /**
   * (the agent's owner) Post a reply held for review to the chat, as they may have edited it (`text`), or discard it.
   * Refused for anyone else's agent, or a reply no longer held.
   */
  async post(uid: string, id: number, action: { text?: string } | "discard"): Promise<{ error: string } | null> {
    const roster = this.#host.roster;
    const held = roster.held(uid).find((reply) => reply.turn === id);
    if (!held) return { error: "No such draft: it was posted or discarded already." };
    if (action === "discard") {
      roster.discard(id);
      this.#host.drafted?.(uid);
      return null;
    }
    const text = action.text === undefined ? held.reply.text : action.text.trim();
    if (!text) return { error: "A reply needs some text; discard it instead." };
    const current = roster.get(held.agentId);
    const reply: ChatAgentReplyData = {
      ...held.reply,
      ...(current && { name: current.name, avatar: current.avatar, color: current.color }),
      text,
      postedBy: uid,
      endedAt: roster.now(),
    };
    // Its owner made it theirs: it hands off and is delivered as any other reply. Only once: with no await since it was
    // read, a second post finds it no longer held.
    const delivering = this.#release(id, reply, true);
    this.#host.drafted?.(uid);
    this.#host.changed();
    await delivering;
    return null;
  }

  /**
   * What a turn left in its session: the artifacts it published, and the records its tool results held. A fork's shows
   * only the shared servers' records, and the private servers it called (TurnHost.sources). None when it cannot be read.
   */
  async #outputs(entry: RosterEntry, turn: AgentTurn): Promise<Outputs> {
    try {
      const entries = await this.#host.turnEntries(sessionOf(entry, turn), turn.id);
      const published = publishedIn(entries);
      if (turn.session !== undefined && this.#host.sources) return { published, ...(await this.#host.sources(entry, entries)) };
      return { published, items: itemsIn(entries), sources: [] };
    } catch (error) {
      console.error("agent turn, outputs:", errorMessage(error));
      return NO_OUTPUTS;
    }
  }

  /**
   * Deliver an ended turn's reply: to the log, then to pi when it named pi. Delivering one twice places it once. A
   * failure is logged, and the reply is let go as delivered.
   */
  async #deliver(id: number): Promise<void> {
    const roster = this.#host.roster;
    const outbox = roster.outbox(id);
    const turn = roster.turn(id);
    if (!outbox || !turn) return;
    const { reply } = outbox;
    try {
      await this.#host.post(reply);
      // Read again: a Stop meanwhile hands pi nothing, and pi reads the reply as context instead. A turn handed to pi
      // carries the reply in its input.
      if (roster.outbox(id)?.toPi) {
        const calledBy = { name: reply.name, agentId: reply.agentId };
        const handed = { calledBy, hop: turn.hop + 1, ask: askOf({ name: reply.name, kind: "agent" }, reply.text, MAX_ASK_CHARS) };
        await this.#host.handToPi(turnInput(handed), { turn: id, calledBy, hop: handed.hop, root: turn.root });
      } else await this.#host.tellPi(reply);
    } catch (error) {
      console.error("agent reply:", errorMessage(error));
    }
    roster.markDelivered(id);
  }

  /**
   * After the object restarted: deliver the replies not delivered yet, wait again on the turns it was running, and
   * start the agents that have turns waiting. Cheap when there are none, as on most wakes.
   */
  resume(): void {
    const roster = this.#host.roster;
    if (!roster.hasWork()) return;
    // A turn whose input never went in (the object stopped while it was set up) starts again, from the queue.
    roster.requeueUnsubmitted();
    for (const id of roster.undelivered()) this.#host.waitUntil(this.#deliver(id));
    const seats = new Set<string>();
    for (const turn of roster.allRunning()) {
      const entry = roster.get(turn.agentId);
      if (!entry) continue;
      // A seat's turn ends when the seat says so: have it send what it may have sent while this object was down.
      if (entry.seat !== undefined) seats.add(entry.agentId);
      else if (!this.#waiting.has(turn.id)) this.#host.waitUntil(this.#await(entry, turn));
    }
    for (const agentId of seats) {
      const entry = roster.get(agentId)!;
      this.#host.waitUntil(
        this.#host.seat!(entry)
          .wake()
          .catch((error: unknown) => console.error("agent seat:", errorMessage(error))),
      );
    }
    for (const agentId of roster.waitingAgents()) this.pump(agentId);
  }

  /** Stop every agent's turns, or one agent's: running ones are aborted, waiting ones dropped. True when one was stopped. */
  async stop(agentId?: string): Promise<boolean> {
    return this.#stopped(this.#host.roster.stopAll(agentId));
  }

  /** Someone left the chat: their turns stop, and those their messages handed on (ChatRoster.stopFor). True when one did. */
  async leave(uid: string): Promise<boolean> {
    return this.#stopped(this.#host.roster.stopFor(uid));
  }

  /** Abort the sessions of the turns just stopped that had started, and tell everyone. */
  async #stopped(stopped: readonly AgentTurn[]): Promise<boolean> {
    const roster = this.#host.roster;
    const started = stopped.filter((turn) => turn.startedAt !== undefined);
    const sessions = new Set<string>();
    const aborts: Promise<void>[] = [];
    for (const turn of started) {
      const entry = roster.get(turn.agentId);
      if (entry?.seat !== undefined) aborts.push(this.#host.seat!(entry).abort(turn.id));
      else if (entry) sessions.add(sessionOf(entry, turn));
    }
    aborts.push(...[...sessions].map((session) => this.#host.abort(session)));
    await Promise.all(aborts.map((abort) => abort.catch((error: unknown) => console.error("agent stop:", errorMessage(error)))));
    if (stopped.length) this.#host.changed();
    return stopped.length > 0;
  }

  /**
   * pi replied (entry `entry` of the log, `text`): the agents it names get turns, as hand-offs within the chain pi's turn
   * was in (`root` and `hop` when another agent handed pi that turn; none when a person asked it).
   */
  fromPi(text: string, entry: number, chain: { hop: number; root?: number } = { hop: 0 }): void {
    const roster = this.#host.roster;
    const left = chain.root === undefined ? MAX_HOPS : MAX_HOPS - roster.handOffsFrom(chain.root);
    const agents = left > 0 ? handOffs(text, AGENT_NAME, chain.hop, roster.list()).slice(0, left) : [];
    if (!agents.length) return;
    this.call(agents, {
      calledBy: { name: AGENT_NAME, agentId: AGENT_NAME },
      ask: askOf({ name: AGENT_NAME, kind: "agent" }, text),
      askKey: entryAskKey(entry),
      byOwner: false,
      hop: chain.hop + 1,
      ...(chain.root !== undefined && { root: chain.root }),
    });
  }
}

/** The session a turn runs in: its own (a fork), else its agent's. */
export function sessionOf(entry: Pick<RosterEntry, "session">, turn: Pick<AgentTurn, "session">): string {
  return turn.session ?? entry.session;
}

/** A turn's operation id in its agent's session: submitting it twice places it once. */
export function operationId(turn: number): string {
  return `turn:${turn}`;
}
