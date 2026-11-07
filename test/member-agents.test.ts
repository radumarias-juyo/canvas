import type { EntryRecord } from "@earendil-works/pi-durable";
import { describe, expect, it } from "vitest";
import { CHAT_AGENT_KIND, checkAgent, type AgentDefinition, type ChatAgentReplyData, type ChatTurnData } from "../shared/agents.ts";
import { CHAT_MESSAGE_KIND } from "../shared/protocol.ts";
import type { McpToolInfo } from "../worker/agent/mcp.ts";
import { AgentTurns, operationId, type Caller, type TurnHost, type TurnResult } from "../worker/agents/controller.ts";
import { ChatRoster, type RosterEntry } from "../worker/agents/roster.ts";
import type { RoomLink, RoomRef, SeatBatch, SeatLink, SeatResult, SeatTurn } from "../worker/agents/seats/link.ts";
import { memberAgentName, seatChatId } from "../worker/agents/seats/names.ts";
import { addRefusal, mayRemove, mayShare, seatedEntry, type ChatRules } from "../worker/agents/seats/rules.ts";
import { AgentSeats, type SeatHost } from "../worker/agents/seats/seat.ts";
import { allowedTools, askLine, askOf, forksFor, messageAskKey, sharedServer, turnSources } from "../worker/agents/turns.ts";
import { memorySql } from "./fakes.ts";

const T0 = 1_000_000;
const RADU = { uid: "radu", name: "Radu" };
const ANA = { uid: "ana", name: "Ana" };
const MIA = { uid: "mia", name: "Mia" };
const ROOM: RoomRef = { ownerUid: RADU.uid, chatId: "room1" };

/** The deployment's MCP tools, by agent tool name: a database anyone may read, and a calendar each user signs in to. */
const MCP = new Map<string, McpToolInfo>([
  ["db_query", { server: "db", readOnly: true }],
  ["db_insert", { server: "db", readOnly: false }],
  ["calendar_events", { server: "calendar", readOnly: true }],
]);
const SIGNS_IN = (server: string) => server === "calendar";
const APP_TOOLS = ["artifact_read", "files_read", "artifact_write"];
const ALL_TOOLS = [...APP_TOOLS, ...MCP.keys()];

type Deferred<T> = { promise: Promise<T>; resolve: (value: T) => void };
function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => (resolve = yes));
  return { promise, resolve };
}
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
async function settle(): Promise<void> {
  for (let n = 0; n < 12; n++) await tick();
}

function definition(id: string, name: string, over: Partial<AgentDefinition> = {}): AgentDefinition {
  return {
    id,
    name,
    avatar: name.slice(0, 2),
    color: "teal",
    job: `Does ${name} work.`,
    instructions: `You are ${name}.`,
    autonomy: 1,
    origin: "user",
    enabled: true,
    version: 1,
    createdAt: T0,
    updatedAt: T0,
    ...over,
  };
}

/** A tool result in a session, as turnEntries returns it: `details` with records, from an MCP tool or an app's. */
function result(toolName: string, records: { id: string; title: string }[]): EntryRecord {
  const server = MCP.get(toolName)?.server ?? "app";
  const details = { items: records.map((record) => ({ server, ...record })) };
  const message = { role: "toolResult", toolCallId: "c", toolName, content: [], details, isError: false, timestamp: T0 };
  return { id: 0, conversationId: 0, kind: "pi.tool-result", model: [message] } as unknown as EntryRecord;
}

/**
 * pi's sessions in one object, as both sides use them: writes and inputs by session, a fork that remembers its parent,
 * and each run's end a promise the test settles by session and operation.
 */
class Sessions {
  readonly writes: { session: string; text: string; requestId: string }[] = [];
  readonly submits: { session: string; input: string; operationId: string; data: ChatTurnData }[] = [];
  readonly configured: { session: string; byOwner: boolean }[] = [];
  readonly aborts: string[] = [];
  readonly forks = new Map<string, string>();
  /** Per session and turn, what turnEntries returns. */
  readonly entries = new Map<string, EntryRecord[]>();
  readonly #runs = new Map<string, Deferred<TurnResult>>();
  #made = 0;

  constructor(readonly prefix: string) {}

  create(): string {
    return `${this.prefix}-s${++this.#made}`;
  }
  fork(from: string): string {
    const fork = `${this.prefix}-fork${++this.#made}`;
    this.forks.set(fork, from);
    return fork;
  }
  write(session: string, text: string, requestId: string): void {
    // Placed once per request id, as pi does.
    if (!this.writes.some((write) => write.session === session && write.requestId === requestId)) this.writes.push({ session, text, requestId });
  }
  submit(session: string, input: string, op: string, data: ChatTurnData): void {
    if (!this.submits.some((submit) => submit.session === session && submit.operationId === op))
      this.submits.push({ session, input, operationId: op, data });
  }
  run(session: string, op: string): Deferred<TurnResult> {
    const key = `${session}|${op}`;
    let run = this.#runs.get(key);
    if (!run) this.#runs.set(key, (run = deferred()));
    return run;
  }
  /** The session a turn was submitted in. */
  sessionOf(turn: number): string {
    const found = this.submits.find((submit) => submit.data.turn === turn);
    if (!found) throw new Error(`turn ${turn} was not submitted`);
    return found.session;
  }
  finish(turn: number, text: string, entries: EntryRecord[] = []): void {
    const session = this.sessionOf(turn);
    this.entries.set(`${session}|${turn}`, entries);
    this.run(session, operationId(turn)).resolve({ status: "done", text });
  }
  /** Every write into `session` and the sessions forked from it, as one text. */
  textOf(session: string): string {
    return this.writes
      .filter((write) => write.session === session)
      .map((write) => write.text)
      .join("\n");
  }
}

/** The member's own object: their definitions, their sessions, and the seats of their agents in other people's chats. */
class MemberObject implements SeatHost {
  readonly sessions: Sessions;
  readonly definitions = new Map<string, AgentDefinition>();
  readonly kept: Promise<unknown>[] = [];
  readonly seats: AgentSeats;
  /** The rooms by their owner's uid and chat id, as RPC reaches them. */
  readonly rooms = new Map<string, Room>();
  pulls = 0;

  constructor(readonly uid: string) {
    this.sessions = new Sessions(uid);
    this.seats = new AgentSeats(memorySql(), this);
  }

  async definition(agentId: string) {
    return this.definitions.get(agentId) ?? null;
  }
  room(ref: RoomRef, agentId: string): RoomLink {
    const room = this.rooms.get(`${ref.ownerUid}:${ref.chatId}`)!;
    return {
      log: async (after, turn) => {
        this.pulls++;
        return room.seatLog(this.uid, agentId, after, turn);
      },
      ended: (turn, ended) => room.seatEnded(this.uid, agentId, turn, ended),
    };
  }
  async create() {
    return this.sessions.create();
  }
  async fork(session: string) {
    return this.sessions.fork(session);
  }
  async write(session: string, text: string, requestId: string) {
    this.sessions.write(session, text, requestId);
  }
  async forks(agent: AgentDefinition) {
    const shared = sharedServer(agent, SIGNS_IN);
    return forksFor(allowedTools(ALL_TOOLS, MCP, agent, true, SIGNS_IN), MCP, shared);
  }
  async configure(session: string, _agent: AgentDefinition, turn: SeatTurn) {
    this.sessions.configured.push({ session, byOwner: turn.byOwner });
  }
  async submit(session: string, input: string, op: string, data: ChatTurnData) {
    this.sessions.submit(session, input, op, data);
  }
  wait(session: string, op: string) {
    return this.sessions.run(session, op).promise;
  }
  async abort(session: string) {
    this.sessions.aborts.push(session);
  }
  async turnEntries(session: string, turn: number) {
    return this.sessions.entries.get(`${session}|${turn}`) ?? [];
  }
  async sources(agent: AgentDefinition, entries: readonly EntryRecord[]) {
    return turnSources(entries, MCP, sharedServer(agent, SIGNS_IN));
  }
  waitUntil(promise: Promise<unknown>) {
    this.kept.push(promise);
  }
}

/**
 * The chat's object (the room): its roster and turns, the log, its owner's agents in its own sessions, and the seats of
 * members' agents reached as their objects' methods (the RPC the chat object makes).
 */
class Room implements TurnHost {
  readonly roster = new ChatRoster(memorySql(), () => T0);
  readonly sessions = new Sessions("room");
  readonly log: EntryRecord[] = [];
  readonly definitions = new Map<string, AgentDefinition>();
  readonly members = new Set<string>([ANA.uid, MIA.uid]);
  readonly objects = new Map<string, MemberObject>();
  readonly posts: ChatAgentReplyData[] = [];
  /** Whose drafts the controller said changed. */
  readonly told: string[] = [];
  readonly kept: Promise<unknown>[] = [];
  /** Who may give a turn now, per asker (the rate limit). */
  limited = new Set<string>();
  readonly turns = new AgentTurns(this);
  #next = 1;

  get rules(): ChatRules {
    return { ownerUid: RADU.uid, isInChat: (uid) => uid === RADU.uid || this.members.has(uid), hasAccount: () => true };
  }

  member(uid: string): MemberObject {
    let object = this.objects.get(uid);
    if (!object) {
      object = new MemberObject(uid);
      object.rooms.set(`${ROOM.ownerUid}:${ROOM.chatId}`, this);
      this.objects.set(uid, object);
    }
    return object;
  }

  /** Bring an agent in: the owner's runs here, a member's as a seat in their own object. */
  add(owner: { uid: string; name: string }, name: string, over: Partial<AgentDefinition> = {}): RosterEntry {
    const id = `${owner.uid}${name}`.padEnd(16, "0").slice(0, 16);
    const agent = definition(id, name, over);
    const mine = owner.uid === RADU.uid;
    if (mine) this.definitions.set(id, agent);
    else this.member(owner.uid).definitions.set(id, agent);
    const handle = mine ? name : memberAgentName(name, owner.name, (taken) => this.roster.byName(taken) !== null)!;
    const refused = this.roster.add({
      agentId: id,
      ownerUid: owner.uid,
      name: handle,
      session: mine ? this.sessions.create() : "",
      avatar: agent.avatar,
      color: agent.color,
      job: agent.job,
      ...(!mine && { seat: seatChatId(id) }),
    });
    if (refused) throw new Error(refused.error);
    return this.roster.get(id)!;
  }

  /** A person's message in the log, and the caller the chat object builds for the agents it calls. */
  say(who: { uid: string; name: string }, text: string): Caller {
    const sentAt = T0 + this.#next;
    this.append({ kind: CHAT_MESSAGE_KIND, data: { uid: who.uid, name: who.name, text, sentAt } });
    return {
      calledBy: { name: who.name, uid: who.uid },
      ask: (own) => askOf({ name: who.name, kind: "person", owner: own }, text),
      askKey: messageAskKey({ uid: who.uid, sentAt }),
      byOwner: (entry) => entry.ownerUid === who.uid,
    };
  }

  append(fields: { kind: string; data?: object }): EntryRecord {
    const entry = { id: this.#next++, conversationId: 0, ...fields } as unknown as EntryRecord;
    this.log.push(entry);
    return entry;
  }

  // TurnHost
  async definition(entry: RosterEntry) {
    return entry.ownerUid === RADU.uid
      ? (this.definitions.get(entry.agentId) ?? null)
      : (this.member(entry.ownerUid).definitions.get(entry.agentId) ?? null);
  }
  async configure(entry: RosterEntry, _agent: AgentDefinition, turn: { session?: string; byOwner: boolean }) {
    this.sessions.configured.push({ session: turn.session ?? entry.session, byOwner: turn.byOwner });
  }
  async *logSince(after: number) {
    yield this.log.filter((entry) => (entry.id as number) > after).reverse();
  }
  async write(session: string, text: string, requestId: string) {
    this.sessions.write(session, text, requestId);
  }
  async submit(session: string, input: string, op: string, data: ChatTurnData) {
    this.sessions.submit(session, input, op, data);
  }
  wait(session: string, op: string) {
    return this.sessions.run(session, op).promise;
  }
  async abort(session: string) {
    this.sessions.aborts.push(session);
  }
  async turnEntries(session: string, turn: number) {
    return this.sessions.entries.get(`${session}|${turn}`) ?? [];
  }
  async post(reply: ChatAgentReplyData) {
    if (this.posts.some((post) => post.turn === reply.turn)) return;
    this.posts.push(reply);
    this.append({ kind: CHAT_AGENT_KIND, data: reply });
  }
  async tellPi() {}
  async handToPi() {}
  changed() {}
  waitUntil(promise: Promise<unknown>) {
    this.kept.push(promise);
  }
  async forks(_entry: RosterEntry, agent: AgentDefinition) {
    return forksFor(allowedTools(ALL_TOOLS, MCP, agent, true, SIGNS_IN), MCP, sharedServer(agent, SIGNS_IN));
  }
  async fork(session: string) {
    return this.sessions.fork(session);
  }
  async sources(entry: RosterEntry, entries: readonly EntryRecord[]) {
    const agent = (await this.definition(entry))!;
    return { ...turnSources(entries, MCP, sharedServer(agent, SIGNS_IN)), ...(agent.reviewBeforePosting && { review: true }) };
  }
  seat(entry: RosterEntry): SeatLink {
    const object = this.member(entry.ownerUid);
    return {
      deliver: (batch) => object.seats.deliver(ROOM, entry.agentId, batch),
      give: (turn) => object.seats.give(ROOM, entry.agentId, { ...turn, ownerName: entry.ownerUid }),
      abort: (turn) => object.seats.abort(ROOM, turn),
      wake: async () => object.seats.wake(ROOM),
    };
  }
  async mayCall(_entry: RosterEntry, uid: string) {
    return !this.limited.has(uid);
  }
  drafted(uid: string) {
    this.told.push(uid);
  }

  // What the chat object answers a seat's call with (ChatAgent.seatLog, seatEnded).
  async seatLog(uid: string, agentId: string, after: number, turn: number): Promise<SeatBatch> {
    const entry = seatedEntry(this.rules, this.roster.get(agentId), uid);
    if (!entry) throw new Error("This agent is not in the chat.");
    return this.turns.batchFor(entry, after, turn);
  }
  async seatEnded(uid: string, agentId: string, turn: number, ended: SeatResult): Promise<boolean> {
    if (!seatedEntry(this.rules, this.roster.get(agentId), uid)) return true;
    return this.turns.seatEnded(agentId, turn, ended);
  }
}
const room = () => new Room();

describe("Member agents: who may do what", () => {
  const rules: ChatRules = {
    ownerUid: RADU.uid,
    isInChat: (uid) => [RADU.uid, ANA.uid, "radu~2"].includes(uid),
    hasAccount: (uid) => uid !== "radu~2",
  };
  const anas: Pick<RosterEntry, "ownerUid"> = { ownerUid: ANA.uid };

  it("refuses someone not in the chat everywhere: adding, removing, sharing, and a seat's calls", () => {
    expect(addRefusal(rules, MIA.uid)).toBe("You are not in this chat.");
    expect(mayRemove(rules, MIA.uid, { ownerUid: MIA.uid })).toBe(false);
    expect(mayShare(rules, MIA.uid, { ownerUid: MIA.uid })).toBe(false);
    const seated = { agentId: "x", ownerUid: MIA.uid, seat: "seat-x" } as RosterEntry;
    expect(seatedEntry(rules, seated, MIA.uid)).toBeNull();
  });

  it("lets a member bring and remove their own agents; the chat's owner removes anyone's; only an agent's owner shares it", () => {
    expect(addRefusal(rules, ANA.uid)).toBeNull();
    expect(addRefusal(rules, "radu~2")).toBe("Add agents as the chat's owner.");
    expect(mayRemove(rules, ANA.uid, anas)).toBe(true);
    expect(mayRemove(rules, RADU.uid, anas)).toBe(true);
    expect(mayRemove(rules, ANA.uid, { ownerUid: RADU.uid })).toBe(false);
    expect(mayShare(rules, ANA.uid, anas)).toBe(true);
    expect(mayShare(rules, RADU.uid, anas)).toBe(false);
  });

  it("takes a seat's call only for the member's own seated agent", () => {
    const seated = { agentId: "x", ownerUid: ANA.uid, seat: "seat-x" } as RosterEntry;
    expect(seatedEntry(rules, seated, ANA.uid)).toBe(seated);
    expect(seatedEntry(rules, seated, RADU.uid)).toBeNull();
    expect(seatedEntry(rules, { ...seated, seat: undefined }, ANA.uid)).toBeNull();
    expect(seatedEntry(rules, null, ANA.uid)).toBeNull();
  });

  it("names a member's agent apart when its name is taken: planner-ana, then a number", () => {
    const taken = new Set(["planner"]);
    expect(memberAgentName("research", "Ana", (name) => taken.has(name))).toBe("research");
    expect(memberAgentName("planner", "Ana Popescu", (name) => taken.has(name))).toBe("planner-ana");
    taken.add("planner-ana");
    expect(memberAgentName("planner", "Ana", (name) => taken.has(name))).toBe("planner-2");
    expect(memberAgentName("planner", "Ștefan", (name) => taken.has(name))).toBe("planner-stefan");
    expect(memberAgentName("planner", "李", (name) => taken.has(name))).toBe("planner-2");
  });
});

describe("Member agents: tools follow who asks", () => {
  const planner = definition("p", "planner", { servers: ["db", "calendar"] });

  it("gives its owner every server, and anyone else only the shared ones, read-only", () => {
    expect(allowedTools(ALL_TOOLS, MCP, planner, true, SIGNS_IN)).toEqual([...APP_TOOLS, "db_query", "db_insert", "calendar_events"]);
    // Another member's question can't use the calendar, which signs in each user.
    expect(allowedTools(ALL_TOOLS, MCP, planner, false, SIGNS_IN)).toEqual(["artifact_read", "db_query"]);
  });

  it("forks a turn its owner gives that may reach a server outside the shared list, and no other", () => {
    expect(forksFor(allowedTools(ALL_TOOLS, MCP, planner, true, SIGNS_IN), MCP, sharedServer(planner, SIGNS_IN))).toBe(true);
    const sharesAll = { ...planner, sharedServers: ["db", "calendar"] };
    expect(forksFor(allowedTools(ALL_TOOLS, MCP, sharesAll, true, SIGNS_IN), MCP, sharedServer(sharesAll, SIGNS_IN))).toBe(false);
    const dbOnly = definition("d", "db", { servers: ["db"] });
    expect(forksFor(allowedTools(ALL_TOOLS, MCP, dbOnly, true, SIGNS_IN), MCP, sharedServer(dbOnly, SIGNS_IN))).toBe(false);
  });

  it("keeps a private turn's records of the shared servers only, and names the private servers it called", () => {
    const entries = [result("db_query", [{ id: "r1", title: "Row 1" }]), result("calendar_events", [{ id: "e1", title: "West launch" }])];
    const { items, sources } = turnSources(entries, MCP, sharedServer(planner, SIGNS_IN));
    expect(sources).toEqual(["calendar"]);
    expect(items.map((item) => item.id)).not.toContain("e1");
  });

  it("checks review before posting as a yes or no, and keeps it only when on", () => {
    const base = { name: "planner", job: "Plans.", instructions: "Plan." };
    expect(checkAgent({ ...base, reviewBeforePosting: true }).reviewBeforePosting).toBe(true);
    expect(checkAgent({ ...base, reviewBeforePosting: false })).not.toHaveProperty("reviewBeforePosting");
    expect(() => checkAgent({ ...base, reviewBeforePosting: "yes" })).toThrow(/true or false/);
  });
});

describe("Member agents: a seat in the member's own object", () => {
  it("runs a member's agent there, with its owner's tools only when they ask, and posts its reply back to the room", async () => {
    const chat = room();
    const planner = chat.add(ANA, "planner", { servers: ["db"] });
    expect(planner).toMatchObject({ ownerUid: ANA.uid, seat: seatChatId(planner.agentId), session: "" });
    chat.say(MIA, "Lunch at noon?");
    const [byRadu] = chat.turns.call([planner.agentId], chat.say(RADU, "@planner what do we know?"));
    await settle();
    const ana = chat.member(ANA.uid);
    // The room ran nothing of it: the seat's session in Ana's object got the catch-up and the turn.
    expect(chat.sessions.submits).toEqual([]);
    const [seatSession] = ana.sessions.submits.map((submit) => submit.session);
    expect(ana.sessions.textOf(seatSession)).toContain("[Mia · person]: Lunch at noon?");
    // Radu is the chat's owner, not the agent's: the turn only reads, and is labelled as anyone's.
    expect(ana.sessions.configured).toEqual([{ session: seatSession, byOwner: false }]);
    expect(ana.sessions.submits[0].input).not.toContain("your owner");

    ana.sessions.finish(byRadu.id, "We know the Q3 numbers.", [result("db_query", [{ id: "r1", title: "Q3" }])]);
    await settle();
    expect(chat.posts).toEqual([
      expect.objectContaining({ agentId: planner.agentId, ownerUid: ANA.uid, text: "We know the Q3 numbers.", turn: byRadu.id }),
    ]);
    expect(chat.posts[0]).not.toHaveProperty("forked");
    expect(chat.roster.turn(byRadu.id)?.status).toBe("done");

    // Ana asks her own agent: it may use all her servers.
    const [byAna] = chat.turns.call([planner.agentId], chat.say(ANA, "@planner and mine?"));
    await settle();
    expect(ana.sessions.configured.at(-1)).toEqual({ session: seatSession, byOwner: true });
    expect(ana.sessions.submits.at(-1)!.input).toContain("your owner");
    ana.sessions.finish(byAna.id, "Yours too.");
    await settle();
    expect(chat.posts.map((post) => post.turn)).toEqual([byRadu.id, byAna.id]);
  });

  it("checks who asked again in the seat: a turn said to be its owner's from someone else only reads", async () => {
    const ana = new MemberObject(ANA.uid);
    ana.definitions.set("p", definition("p", "planner"));
    const chat = room();
    ana.rooms.set(`${ROOM.ownerUid}:${ROOM.chatId}`, chat);
    const turn = (uid: string, over: Partial<SeatTurn> = {}): SeatTurn => ({
      turn: 7,
      calledBy: { name: uid, uid },
      hop: 0,
      input: "Your turn",
      ownerName: "Ana",
      byOwner: true,
      ...over,
    });
    await ana.seats.give(ROOM, "p", turn(RADU.uid));
    await ana.seats.give(ROOM, "p", turn(ANA.uid, { turn: 8, hop: 1 }));
    await ana.seats.give(ROOM, "p", turn(ANA.uid, { turn: 9 }));
    expect(ana.sessions.configured.map((configured) => configured.byOwner)).toEqual([false, false, true]);
  });

  it("refuses a turn for an agent its owner deleted or turned off, and reports it as unanswered", async () => {
    const chat = room();
    const planner = chat.add(ANA, "planner");
    chat.member(ANA.uid).definitions.set(planner.agentId, definition(planner.agentId, "planner", { enabled: false }));
    chat.turns.call([planner.agentId], chat.say(ANA, "@planner hi"));
    await settle();
    expect(chat.posts).toEqual([expect.objectContaining({ failed: expect.stringContaining("turned @planner off") })]);
  });

  it("places a duplicate delivery once", async () => {
    const ana = new MemberObject(ANA.uid);
    ana.definitions.set("p", definition("p", "planner"));
    const batch: SeatBatch = { from: 0, through: 4, text: "What was said…", turn: 1 };
    expect(await ana.seats.deliver(ROOM, "p", batch)).toBe(4);
    expect(await ana.seats.deliver(ROOM, "p", batch)).toBe(4);
    expect(await ana.seats.deliver(ROOM, "p", { ...batch, from: 2, through: 3 })).toBe(4);
    expect(ana.sessions.writes).toHaveLength(1);
    expect(ana.seats.delivered(ROOM, "p")).toBe(4);
  });

  it("fills a gap by pulling the range from the room, and an overlap too", async () => {
    const chat = room();
    const planner = chat.add(ANA, "planner");
    const ana = chat.member(ANA.uid);
    chat.say(MIA, "one");
    chat.say(MIA, "two");
    chat.say(MIA, "three");
    // The room believes the seat has read through entry 2 (a delivery it thought went in), but the seat has nothing.
    expect(await ana.seats.deliver(ROOM, planner.agentId, { from: 3, through: 3, text: "[Mia · person]: three", turn: 1 })).toBe(3);
    expect(ana.pulls).toBe(1);
    const [write] = ana.sessions.writes;
    expect(write.text).toContain("one");
    expect(write.text).toContain("three");
    // An overlap (it has through 3; the batch starts at 2) pulls only what comes after.
    chat.say(MIA, "four");
    expect(await ana.seats.deliver(ROOM, planner.agentId, { from: 2, through: 4, text: "two, three, four", turn: 1 })).toBe(4);
    expect(ana.pulls).toBe(2);
    expect(ana.sessions.writes[1].text).toContain("four");
    expect(ana.sessions.writes[1].text).not.toContain("three");
  });

  it("refuses a pull from someone whose agent is not seated in the chat", async () => {
    const chat = room();
    const planner = chat.add(ANA, "planner");
    await expect(chat.seatLog(MIA.uid, planner.agentId, -1, 1)).rejects.toThrow(/not in the chat/);
    chat.members.delete(ANA.uid);
    await expect(chat.seatLog(ANA.uid, planner.agentId, -1, 1)).rejects.toThrow(/not in the chat/);
    // A reply from a seat no longer in the chat is let go, and posts nothing.
    expect(await chat.seatEnded(ANA.uid, planner.agentId, 1, { status: "done", text: "hi", published: [], items: [], sources: [] })).toBe(true);
    expect(chat.posts).toEqual([]);
  });

  it("posts a seat's reply once though the seat sends it again after a restart", async () => {
    const chat = room();
    const planner = chat.add(ANA, "planner");
    const [turn] = chat.turns.call([planner.agentId], chat.say(ANA, "@planner hi"));
    await settle();
    const ana = chat.member(ANA.uid);
    ana.sessions.finish(turn.id, "Hello.");
    await settle();
    const ended: SeatResult = { status: "done", text: "Hello.", published: [], items: [], sources: [] };
    expect(await chat.seatEnded(ANA.uid, planner.agentId, turn.id, ended)).toBe(true);
    expect(chat.posts).toHaveLength(1);
  });

  it("keeps a reply the room could not take, and posts it on the next wake; a turn given twice runs once", async () => {
    const chat = room();
    const planner = chat.add(ANA, "planner");
    const [turn] = chat.turns.call([planner.agentId], chat.say(ANA, "@planner hi"));
    await settle();
    const ana = chat.member(ANA.uid);
    const given = ana.sessions.submits[0];
    await ana.seats.give(ROOM, planner.agentId, {
      turn: turn.id,
      calledBy: given.data.calledBy,
      hop: 0,
      input: given.input,
      ownerName: "Ana",
      byOwner: true,
    });
    expect(ana.sessions.submits).toHaveLength(1);
    // The room is down when the turn ends.
    const ended = chat.seatEnded.bind(chat);
    chat.seatEnded = () => Promise.reject(new Error("room restarting"));
    ana.sessions.finish(turn.id, "Hello.");
    await settle();
    expect(chat.posts).toEqual([]);
    chat.seatEnded = ended;
    ana.seats.wake(ROOM);
    await settle();
    expect(chat.posts).toEqual([expect.objectContaining({ turn: turn.id, text: "Hello." })]);
    // Taken: a later wake sends nothing again.
    ana.seats.wake();
    await settle();
    expect(chat.posts).toHaveLength(1);
  });

  it("stops a seat's turn there, and drops the seat when the agent leaves", async () => {
    const chat = room();
    const planner = chat.add(ANA, "planner");
    chat.turns.call([planner.agentId], chat.say(ANA, "@planner hi"));
    await settle();
    const ana = chat.member(ANA.uid);
    const [seatSession] = ana.sessions.submits.map((submit) => submit.session);
    expect(await chat.turns.stop(planner.agentId)).toBe(true);
    expect(ana.sessions.aborts).toEqual([seatSession]);
    await ana.seats.drop(ROOM, planner.agentId);
    expect(ana.seats.delivered(ROOM, planner.agentId)).toBe(-1);
  });

  it("ends a turn at once, saying so, when the asker is over the rate limit", async () => {
    const chat = room();
    const planner = chat.add(ANA, "planner");
    chat.limited.add(MIA.uid);
    chat.turns.call([planner.agentId], chat.say(MIA, "@planner again"));
    await settle();
    expect(chat.posts).toEqual([expect.objectContaining({ failed: expect.stringContaining("asked too often") })]);
    expect(chat.member(ANA.uid).sessions.submits).toEqual([]);
  });

  it("removes a person's agents with them, keeping their past replies", async () => {
    const chat = room();
    const planner = chat.add(ANA, "planner");
    const research = chat.add(RADU, "research");
    expect(chat.roster.ownedBy(ANA.uid).map((entry) => entry.agentId)).toEqual([planner.agentId]);
    chat.roster.remove(planner.agentId);
    expect(chat.roster.list().map((entry) => entry.agentId)).toEqual([research.agentId]);
  });

  it("names a second planner apart, and keeps that name when its definition is read again", () => {
    const chat = room();
    chat.add(RADU, "planner");
    const anas = chat.add(ANA, "planner");
    expect(anas.name).toBe("planner-ana");
    const refreshed = chat.roster.refresh(anas.agentId, { name: "planner", avatar: "pl", color: "teal", job: "Plans.", off: false });
    expect(refreshed?.entry.name).toBe("planner-ana");
  });
});

describe("Member agents: private turns run apart", () => {
  it("runs the owner's turn that may reach a private server in a fork; only the posted reply reaches the shared session", async () => {
    const chat = room();
    const planner = chat.add(RADU, "planner", { servers: ["db", "calendar"] });
    chat.say(MIA, "When is the West launch?");
    const [mine] = chat.turns.call([planner.agentId], chat.say(RADU, "@planner check my calendar"));
    await settle();
    const fork = chat.sessions.sessionOf(mine.id);
    expect(chat.sessions.forks.get(fork)).toBe(planner.session);
    // The catch-up went into the shared session before the fork was made, so the fork sees it.
    expect(chat.sessions.textOf(planner.session)).toContain("When is the West launch?");
    expect(chat.roster.turn(mine.id)?.session).toBe(fork);
    // Only its owner follows a fork live.
    expect(chat.roster.runningSessions()).toEqual([{ agentId: planner.agentId, session: fork, turn: mine.id, only: RADU.uid }]);

    chat.sessions.finish(mine.id, "The West launch is in week 41.", [
      result("calendar_events", [{ id: "e1", title: "Board dinner (private)" }]),
      result("db_query", [{ id: "r1", title: "West signups" }]),
    ]);
    await settle();
    const [posted] = chat.posts;
    expect(posted).toMatchObject({ forked: true, sources: ["calendar"], text: "The West launch is in week 41." });
    expect(posted.items?.map((item) => item.id)).toEqual(["r1"]);

    // Mia asks next: her turn runs in the shared session, which has the posted reply and none of the private results.
    const [hers] = chat.turns.call([planner.agentId], chat.say(MIA, "@planner what did the calendar say earlier?"));
    await settle();
    expect(chat.sessions.sessionOf(hers.id)).toBe(planner.session);
    expect(chat.sessions.configured.at(-1)).toEqual({ session: planner.session, byOwner: false });
    const shared = chat.sessions.textOf(planner.session);
    expect(shared).toContain("(your reply, as posted): The West launch is in week 41.");
    expect(shared).not.toContain("Board dinner");
  });

  it("does the same in a member's seat: the fork is in their object, and the reply carries their source chip", async () => {
    const chat = room();
    const planner = chat.add(ANA, "planner", { servers: ["db", "calendar"] });
    const [turn] = chat.turns.call([planner.agentId], chat.say(ANA, "@planner my calendar?"));
    await settle();
    const ana = chat.member(ANA.uid);
    const fork = ana.sessions.sessionOf(turn.id);
    expect(ana.sessions.forks.has(fork)).toBe(true);
    ana.sessions.finish(turn.id, "Week 41.", [result("calendar_events", [{ id: "e1", title: "Private" }])]);
    await settle();
    expect(chat.posts).toEqual([expect.objectContaining({ forked: true, sources: ["calendar"], ownerUid: ANA.uid })]);
    expect(chat.posts[0].items ?? []).toEqual([]);
  });

  it("holds a reply built on a private server for its owner to review, then posts it as they edited it", async () => {
    const chat = room();
    const planner = chat.add(RADU, "planner", { servers: ["db", "calendar"], reviewBeforePosting: true });
    const [turn] = chat.turns.call([planner.agentId], chat.say(RADU, "@planner calendar, then ask @planner"));
    await settle();
    chat.sessions.finish(turn.id, "Board dinner on Friday; West launch in week 41.", [result("calendar_events", [{ id: "e1", title: "x" }])]);
    await settle();
    expect(chat.posts).toEqual([]);
    expect(chat.told).toEqual([RADU.uid]);
    expect(chat.roster.held(RADU.uid)).toEqual([expect.objectContaining({ turn: turn.id, agentId: planner.agentId })]);
    // Nobody else's.
    expect(chat.roster.held(ANA.uid)).toEqual([]);
    expect(await chat.turns.post(ANA.uid, turn.id, {})).toEqual({ error: expect.stringContaining("No such draft") });

    expect(await chat.turns.post(RADU.uid, turn.id, { text: "The West launch is in week 41." })).toBeNull();
    expect(chat.posts).toEqual([expect.objectContaining({ text: "The West launch is in week 41.", postedBy: RADU.uid, sources: ["calendar"] })]);
    expect(chat.roster.held(RADU.uid)).toEqual([]);
    // Posted once.
    expect(await chat.turns.post(RADU.uid, turn.id, {})).toEqual({ error: expect.stringContaining("No such draft") });
    expect(chat.posts).toHaveLength(1);
  });

  it("never posts a discarded draft, and posts a private reply at once when review is off or it read no private server", async () => {
    const chat = room();
    const planner = chat.add(RADU, "planner", { servers: ["db", "calendar"], reviewBeforePosting: true });
    const [first] = chat.turns.call([planner.agentId], chat.say(RADU, "@planner one"));
    await settle();
    chat.sessions.finish(first.id, "Private.", [result("calendar_events", [{ id: "e1", title: "x" }])]);
    await settle();
    expect(await chat.turns.post(RADU.uid, first.id, "discard")).toBeNull();
    expect(chat.posts).toEqual([]);
    expect(chat.roster.held()).toEqual([]);

    const [second] = chat.turns.call([planner.agentId], chat.say(RADU, "@planner two"));
    await settle();
    chat.sessions.finish(second.id, "Only the database.", [result("db_query", [{ id: "r1", title: "Row" }])]);
    await settle();
    expect(chat.posts).toEqual([expect.objectContaining({ turn: second.id, forked: true })]);
    expect(chat.posts[0]).not.toHaveProperty("sources");
  });

  it("lets a removed agent's drafts go with it", async () => {
    const chat = room();
    const planner = chat.add(RADU, "planner", { servers: ["calendar"], reviewBeforePosting: true });
    const [turn] = chat.turns.call([planner.agentId], chat.say(RADU, "@planner one"));
    await settle();
    chat.sessions.finish(turn.id, "Private.", [result("calendar_events", [])]);
    await settle();
    expect(chat.roster.held()).toHaveLength(1);
    chat.roster.remove(planner.agentId);
    expect(chat.roster.held()).toEqual([]);
  });

  it("reads its own forked reply in a catch-up, and skips its own other replies", () => {
    const reply = (forked: boolean) =>
      ({
        id: 9,
        conversationId: 0,
        kind: CHAT_AGENT_KIND,
        data: { agentId: "p", name: "planner", text: "Week 41.", ...(forked && { forked: true }) },
      }) as unknown as EntryRecord;
    expect(askLine(reply(true), "p", RADU.uid)).toBe("[planner · agent] (your reply, as posted): Week 41.");
    expect(askLine(reply(false), "p", RADU.uid)).toBeUndefined();
    expect(askLine(reply(true), "other", RADU.uid)).toBe("[planner · agent]: Week 41.");
  });
});
