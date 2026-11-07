// A member's agent in someone else's chat runs here, in its owner's own object, as a seat: one pi session per room
// (the chat it is in) with its owner's sign-ins, files, skills and budget. The room sends it the log's lines and its
// turns by RPC, and this object posts each turn's reply back by RPC (worker/agents/seats/link.ts). Nothing of its
// sessions leaves it but the replies, and what the app recorded of their calls.

import type { EntryRecord } from "@earendil-works/pi-durable";
import type { AgentDefinition, ChatTurnData } from "../../../shared/agents.ts";
import { errorMessage } from "../../../shared/util.ts";
import type { Sql } from "../../members.ts";
import { operationId, outputsOf, type Outputs, type TurnResult } from "../controller.ts";
import type { RoomLink, RoomRef, SeatBatch, SeatResult, SeatTurn } from "./link.ts";

/** What a seat needs of the object it is in: its owner's definitions, pi's sessions there, and its rooms. */
export interface SeatHost {
  /** Whose object this is: the agents seated here are theirs. */
  readonly uid: string;
  /** The owner's definition of one of their agents; null when it is gone. */
  definition(agentId: string): Promise<AgentDefinition | null>;
  /** The room a seat is for, to pull a gap from and post replies to. */
  room(ref: RoomRef, agentId: string): RoomLink;
  /** A new session for a seat. */
  create(): Promise<string>;
  /** A new session that sees `session`'s history so far (a new one when it has none); for a turn that may read a private server. */
  fork(session: string): Promise<string>;
  /** A passive write into a session: context, no run. `requestId` keeps a retry from placing it twice. */
  write(session: string, text: string, requestId: string): Promise<void>;
  /** Whether a turn its owner asked for may reach a server outside the agent's shared list (forksFor). */
  forks(agent: AgentDefinition, turn: SeatTurn): Promise<boolean>;
  /** Set a session up for a turn: the agent's model, effort and instructions, and the tools this turn may use. */
  configure(session: string, agent: AgentDefinition, turn: SeatTurn): Promise<void>;
  submit(session: string, input: string, operationId: string, data: ChatTurnData): Promise<void>;
  wait(session: string, operationId: string): Promise<TurnResult>;
  abort(session: string): Promise<void>;
  /** The session's entries from turn `turn`'s input on, oldest first. */
  turnEntries(session: string, turn: number): Promise<readonly EntryRecord[]>;
  /**
   * What a fork's reply shows of its sources: the shared servers' records, the private servers it called (turnSources),
   * and whether its owner reviews it first.
   */
  sources(agent: AgentDefinition, entries: readonly EntryRecord[]): Promise<Pick<Outputs, "items" | "sources" | "review">>;
  waitUntil(promise: Promise<unknown>): void;
}

type SeatRow = { room_owner: string; room_chat: string; agent_id: string; session: string; delivered: number };
type SeatTurnRow = {
  room_owner: string;
  room_chat: string;
  agent_id: string;
  turn: number;
  session: string;
  forked: number;
  status: "running" | "ended";
  result: string | null;
};

/** How long a seat waits before it posts a turn's result again, after each failed post (#report); then the next wake. */
const REPORT_RETRIES = [1_000, 5_000, 30_000];

const refOf = (row: Pick<SeatRow, "room_owner" | "room_chat">): RoomRef => ({ ownerUid: row.room_owner, chatId: row.room_chat });

/**
 * The seats in one person's object: per room and agent, a pi session and the newest log entry it took (`delivered`);
 * per turn, where it runs and, once it ended, its result until the room took it (an outbox: a restart of either side
 * posts it again, and the room places it once).
 */
export class AgentSeats {
  readonly #sql: Sql;
  readonly #host: SeatHost;
  /** The turns this object waits on, so a wake does not wait on one twice. */
  readonly #waiting = new Set<string>();

  constructor(sql: Sql, host: SeatHost) {
    this.#sql = sql;
    this.#host = host;
    sql.exec(`
      CREATE TABLE IF NOT EXISTS agent_seats (
        room_owner TEXT NOT NULL, room_chat TEXT NOT NULL, agent_id TEXT NOT NULL, session TEXT NOT NULL, delivered INTEGER NOT NULL DEFAULT -1,
        created_at INTEGER NOT NULL, PRIMARY KEY (room_owner, room_chat, agent_id)
      );
      CREATE TABLE IF NOT EXISTS agent_seat_turns (
        room_owner TEXT NOT NULL, room_chat TEXT NOT NULL, agent_id TEXT NOT NULL, turn INTEGER NOT NULL, session TEXT NOT NULL,
        forked INTEGER NOT NULL, status TEXT NOT NULL, result TEXT, PRIMARY KEY (room_owner, room_chat, turn)
      );
    `);
  }

  #seat(ref: RoomRef, agentId: string): SeatRow | undefined {
    return this.#sql
      .exec("SELECT * FROM agent_seats WHERE room_owner = ? AND room_chat = ? AND agent_id = ?", ref.ownerUid, ref.chatId, agentId)
      .toArray()[0] as SeatRow | undefined;
  }

  #turn(ref: RoomRef, turn: number): SeatTurnRow | undefined {
    return this.#sql
      .exec("SELECT * FROM agent_seat_turns WHERE room_owner = ? AND room_chat = ? AND turn = ?", ref.ownerUid, ref.chatId, turn)
      .toArray()[0] as SeatTurnRow | undefined;
  }

  /** The owner's agent, on: only such an agent of theirs takes a seat or a turn. */
  async #agent(agentId: string): Promise<AgentDefinition> {
    const agent = await this.#host.definition(agentId);
    if (!agent) throw new Error("This agent was deleted.");
    if (!agent.enabled) throw new Error(`Its owner turned @${agent.name} off.`);
    return agent;
  }

  /** A room's seat for an agent, made at its first delivery: a session of its own. `checked` when the agent was just read. */
  async #ensure(ref: RoomRef, agentId: string, checked = false): Promise<SeatRow> {
    const found = this.#seat(ref, agentId);
    if (found) return found;
    if (!checked) await this.#agent(agentId);
    const session = await this.#host.create();
    // Made meanwhile by another delivery: that one is the seat, and this session stays unused.
    this.#sql.exec(
      "INSERT INTO agent_seats (room_owner, room_chat, agent_id, session, created_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT DO NOTHING",
      ref.ownerUid,
      ref.chatId,
      agentId,
      session,
      Date.now(),
    );
    return this.#seat(ref, agentId)!;
  }

  /**
   * Lines of the room's log, placed once: a batch through what the seat has is a duplicate, and one that does not start
   * right after it (a gap, or an overlap) is replaced by the range the seat pulls from the room. The newest log entry
   * the seat has taken.
   */
  async deliver(ref: RoomRef, agentId: string, batch: SeatBatch): Promise<number> {
    const seat = await this.#ensure(ref, agentId);
    if (batch.through <= seat.delivered) return seat.delivered;
    const placed = batch.from === seat.delivered + 1 ? batch : await this.#host.room(ref, agentId).log(seat.delivered, batch.turn);
    if (placed.through <= seat.delivered) return seat.delivered;
    if (placed.text) await this.#host.write(seat.session, placed.text, `mirror:${placed.through}`);
    this.#sql.exec(
      "UPDATE agent_seats SET delivered = MAX(delivered, ?) WHERE room_owner = ? AND room_chat = ? AND agent_id = ?",
      placed.through,
      ref.ownerUid,
      ref.chatId,
      agentId,
    );
    return Math.max(seat.delivered, placed.through);
  }

  /**
   * Give the agent its turn: in the seat's session, or for a turn its owner asked for that may reach a private server,
   * in a fork of it, so the private results stay out of the session other people's questions reach. The turn's tools
   * follow who asked, as this object checks it again: only its owner, directly. The lines of the log said before it
   * (`batch`) go in first. Returns once its input is in, with the newest log entry the seat has taken; the reply goes
   * to the room when it ends. A turn given again is placed once.
   */
  async give(ref: RoomRef, agentId: string, turn: SeatTurn, batch: SeatBatch | null = null): Promise<number> {
    if (this.#turn(ref, turn.turn)) return this.delivered(ref, agentId);
    const agent = await this.#agent(agentId);
    const seat = await this.#ensure(ref, agentId, true);
    const delivered = batch ? await this.deliver(ref, agentId, batch) : seat.delivered;
    const checked: SeatTurn = { ...turn, byOwner: turn.byOwner && turn.hop === 0 && turn.calledBy.uid === this.#host.uid && !turn.calledBy.agentId };
    const forked = checked.byOwner && (await this.#host.forks(agent, checked));
    const session = forked ? await this.#host.fork(seat.session) : seat.session;
    // Given meanwhile by a retry: that one runs.
    if (this.#turn(ref, turn.turn)) return delivered;
    this.#sql.exec(
      "INSERT INTO agent_seat_turns (room_owner, room_chat, agent_id, turn, session, forked, status) VALUES (?, ?, ?, ?, ?, ?, 'running')",
      ref.ownerUid,
      ref.chatId,
      agentId,
      turn.turn,
      session,
      forked ? 1 : 0,
    );
    try {
      await this.#host.configure(session, agent, checked);
      await this.#host.submit(session, turn.input, operationId(turn.turn), { turn: turn.turn, calledBy: turn.calledBy, hop: turn.hop });
    } catch (error) {
      this.#end(ref, turn.turn, { status: "unanswered", reason: errorMessage(error), published: [], items: [], sources: [] });
      this.#host.waitUntil(this.#report(ref, turn.turn));
      return delivered;
    }
    this.#host.waitUntil(this.#await(this.#turn(ref, turn.turn)!));
    return delivered;
  }

  /** Wait for a turn's run to end, keep its result, and post it to the room. */
  async #await(row: SeatTurnRow): Promise<void> {
    const ref = refOf(row);
    const key = `${row.room_owner}:${row.room_chat}:${row.turn}`;
    if (this.#waiting.has(key)) return;
    this.#waiting.add(key);
    try {
      let result: TurnResult;
      try {
        result = await this.#host.wait(row.session, operationId(row.turn));
      } catch (error) {
        result = { status: "unanswered", reason: errorMessage(error) };
        await this.#host.abort(row.session).catch((abortError: unknown) => console.error("agent seat, stop:", errorMessage(abortError)));
      }
      this.#end(ref, row.turn, { ...result, ...(await this.#outputs(row)) });
      await this.#report(ref, row.turn);
    } finally {
      this.#waiting.delete(key);
    }
  }

  /** What a turn left in its session: the pages it published, and its records, only the shared servers' for a fork. */
  async #outputs(row: SeatTurnRow): Promise<Outputs> {
    try {
      const entries = await this.#host.turnEntries(row.session, row.turn);
      return await outputsOf(entries, row.forked === 1, async () => {
        const agent = await this.#host.definition(row.agent_id);
        return agent ? this.#host.sources(agent, entries) : { items: [], sources: [] };
      });
    } catch (error) {
      console.error("agent seat, outputs:", errorMessage(error));
      return { published: [], items: [], sources: [], ...(row.forked && { forked: true }) };
    }
  }

  /** A turn ended, with its result: kept until the room takes it. Only once. */
  #end(ref: RoomRef, turn: number, result: SeatResult): void {
    this.#sql.exec(
      "UPDATE agent_seat_turns SET status = 'ended', result = ? WHERE room_owner = ? AND room_chat = ? AND turn = ? AND status = 'running'",
      JSON.stringify(result),
      ref.ownerUid,
      ref.chatId,
      turn,
    );
  }

  /**
   * Post an ended turn's result to its room, and let it go once the room took it. A failed post is tried again a few
   * times (the room's turn runs until it hears, and its agent's next turns wait on it), then kept for the next wake.
   */
  async #report(ref: RoomRef, turn: number): Promise<void> {
    for (let attempt = 0; ; attempt++) {
      const row = this.#turn(ref, turn);
      if (row?.status !== "ended" || !row.result) return;
      try {
        if (await this.#host.room(ref, row.agent_id).ended(turn, JSON.parse(row.result) as SeatResult)) {
          this.#sql.exec("DELETE FROM agent_seat_turns WHERE room_owner = ? AND room_chat = ? AND turn = ?", ref.ownerUid, ref.chatId, turn);
        }
        return;
      } catch (error) {
        console.error("agent seat, reply:", errorMessage(error));
        const delay = REPORT_RETRIES[attempt];
        if (delay === undefined) return;
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
  }

  /** Stop a turn the room stopped; its result, the stop's, still goes back. */
  async abort(ref: RoomRef, turn: number): Promise<void> {
    const row = this.#turn(ref, turn);
    if (row?.status === "running") await this.#host.abort(row.session);
  }

  /**
   * After this object or the room restarted: post the results the room has not taken, and wait again on the turns that
   * run. Only `ref`'s, or every room's.
   */
  wake(ref?: RoomRef): void {
    const rows = (
      ref
        ? this.#sql.exec("SELECT * FROM agent_seat_turns WHERE room_owner = ? AND room_chat = ?", ref.ownerUid, ref.chatId)
        : this.#sql.exec("SELECT * FROM agent_seat_turns")
    ).toArray() as SeatTurnRow[];
    for (const row of rows) {
      this.#host.waitUntil(row.status === "ended" ? this.#report(refOf(row), row.turn) : this.#await(row));
    }
  }

  /** The agent left the room (removed, or its owner left): its seat goes, and what it runs there stops. */
  async drop(ref: RoomRef, agentId: string): Promise<void> {
    const where = "room_owner = ? AND room_chat = ? AND agent_id = ?";
    const running = this.#sql
      .exec(`SELECT * FROM agent_seat_turns WHERE ${where} AND status = 'running'`, ref.ownerUid, ref.chatId, agentId)
      .toArray() as SeatTurnRow[];
    this.#sql.exec(`DELETE FROM agent_seat_turns WHERE ${where}`, ref.ownerUid, ref.chatId, agentId);
    this.#sql.exec(`DELETE FROM agent_seats WHERE ${where}`, ref.ownerUid, ref.chatId, agentId);
    await Promise.all(
      running.map((row) => this.#host.abort(row.session).catch((error: unknown) => console.error("agent seat, stop:", errorMessage(error)))),
    );
  }

  /** The newest log entry a room's seat took; -1 before any. */
  delivered(ref: RoomRef, agentId: string): number {
    return this.#seat(ref, agentId)?.delivered ?? -1;
  }
}
