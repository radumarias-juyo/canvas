import type { EntryRecord } from "@earendil-works/pi-durable";
import { describe, expect, it } from "vitest";
import type { AgentDefinition, ChatTurnData, StepInput } from "../shared/agents.ts";
import type { GuardrailRule, PendingActionView } from "../shared/limits.ts";
import { placeNote } from "../shared/memory.ts";
import type { ToolInfo } from "../shared/protocol.ts";
import { ChatActions, type NewAction } from "../worker/agents/limits/actions.ts";
import { approvalFeed } from "../worker/agents/limits/feed.ts";
import { WriteGate, type GateHost } from "../worker/agents/limits/gate.ts";
import { seatLevel } from "../worker/agents/limits/levels.ts";
import type { TurnResult } from "../worker/agents/controller.ts";
import type { RosterEntry } from "../worker/agents/roster.ts";
import { SeatActions } from "../worker/agents/seats/actions.ts";
import type { RoomLink, RoomRef, SeatTurn } from "../worker/agents/seats/link.ts";
import type { ChatRules } from "../worker/agents/seats/rules.ts";
import { AgentSeats, type SeatHost } from "../worker/agents/seats/seat.ts";
import { CallHeld, McpHub, type McpConnection, type RawToolResult } from "../worker/mcp/hub.ts";
import { memorySql } from "./fakes.ts";

const T0 = Date.UTC(2026, 10, 7, 9, 0);
const RADU = { uid: "radu", name: "Radu" };
const ANA = { uid: "ana", name: "Ana" };
const MIA = { uid: "mia", name: "Mia" };
/** The room: Radu's shared chat, where Ana's agent "planner" has its seat (in Ana's own object). */
const ROOM: RoomRef = { ownerUid: RADU.uid, chatId: "room1" };

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
async function settle(): Promise<void> {
  for (let n = 0; n < 12; n++) await tick();
}

/** Ana's agent, with a rule of hers: a discount over 10 waits for her approval. */
const PLANNER: AgentDefinition = {
  id: "p",
  name: "planner",
  avatar: "pl",
  color: "teal",
  job: "Plans.",
  instructions: "You plan.",
  autonomy: 1,
  origin: "user",
  enabled: true,
  version: 1,
  createdAt: T0,
  updatedAt: T0,
  guardrails: [{ id: "g1", server: "crm", tool: "update_deal", kind: "max", arg: "discount", value: 10, effect: "approve" } as GuardrailRule],
};

/** Ana's object: its seats, and pi's sessions there (each submit recorded; runs never end unless the test ends them). */
class AnasObject implements SeatHost {
  readonly uid = ANA.uid;
  readonly seats: AgentSeats;
  readonly submits: { session: string; data: ChatTurnData }[] = [];
  readonly configured: { session: string; writes: boolean }[] = [];
  #made = 0;
  constructor() {
    this.seats = new AgentSeats(memorySql(), this);
  }
  async definition() {
    return PLANNER;
  }
  room(): RoomLink {
    return { log: async () => ({ from: 0, through: -1, text: "", turn: 0 }), ended: async () => true, action: async () => {} };
  }
  async create() {
    return `s${++this.#made}`;
  }
  async fork(session: string) {
    return `${session}-fork${++this.#made}`;
  }
  async write() {}
  async configure(session: string, _agent: AgentDefinition, turn: SeatTurn) {
    // As ChatAgent's seat host sets the turn's tools up: tools that change data only at the level the gate lets through.
    this.configured.push({ session, writes: seatLevel(turn).level === 4 });
  }
  async submit(session: string, _input: string, _op: string, data: ChatTurnData) {
    this.submits.push({ session, data });
  }
  wait(): Promise<TurnResult> {
    return new Promise(() => {});
  }
  async abort() {}
  async turnEntries(): Promise<readonly EntryRecord[]> {
    return [];
  }
  async sources() {
    return { items: [], sources: [] };
  }
  waitUntil() {}
  later() {}
  /** The session a turn was put into. */
  sessionOf(turn: number): string {
    const found = this.submits.find((submit) => submit.data.turn === turn);
    if (!found) throw new Error(`turn ${turn} was not submitted`);
    return found.session;
  }
}

const seatTurn = (id: number, calledBy: SeatTurn["calledBy"], byOwner: boolean, kind: SeatTurn["kind"] = "group"): SeatTurn => ({
  turn: id,
  calledBy,
  hop: 0,
  ask: `[${calledBy.name} · person]: go`,
  input: "Your turn",
  ownerName: ANA.name,
  kind,
  byOwner,
});

/** A server with a tool that changes data, recording the calls that reach it. */
function crm() {
  const calls: { name: string; args: unknown }[] = [];
  const tools: ToolInfo[] = [{ name: "update_deal", description: "", inputSchema: { type: "object", properties: { discount: { type: "number" } } } }];
  const connection: McpConnection = {
    listTools: async () => tools,
    callTool: async (name, args): Promise<RawToolResult> => {
      calls.push({ name, args });
      return { content: [{ type: "text", text: '{"ok":true}' }] };
    },
    close: async () => {},
  };
  return { calls, connector: async () => connection };
}

/**
 * Ana's object as the write gate guards it: its hub asks the gate, whose caller is what ChatAgent.#callerOf makes of a
 * session (only a seat's turn here), and whose held actions are kept as ChatAgent.#holdAction keeps them.
 */
function guarded() {
  const ana = new AnasObject();
  const server = crm();
  const hub = new McpHub([{ name: "crm", url: "https://example.invalid/mcp" }], server.connector, () => T0);
  const actions = new ChatActions(
    memorySql(),
    () => "seat-p",
    () => T0,
  );
  const held: PendingActionView[] = [];
  const host: GateHost = {
    now: () => T0,
    caller: async (context, call) => {
      const found = context.kind === "session" ? await ana.seats.caller(context.session, call, () => ana.definition()) : null;
      if (!found) throw new Error("this session has no turn that may change anything.");
      return found;
    },
    userRules: async () => [],
    agent: async () => PLANNER,
    readValue: async () => undefined,
    callsSince: async () => 0,
    dayStart: (at) => at,
    log: () => {},
    hold: async (action: NewAction) => {
      const view = actions.add({ ...action, origin: { ...action.origin, apart: true } });
      held.push(view);
      return view;
    },
  };
  hub.guard(new WriteGate(host));
  const write = (session: string, input: StepInput) => hub.call("crm", "update_deal", input, { kind: "session", session });
  return { ana, server, actions, held, write };
}

/** The verdict a call that did not run came with. */
async function stopped(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    if (error instanceof CallHeld) return error.verdict;
    throw error;
  }
  throw new Error("the call ran");
}

describe("Seat turns through the write gate", () => {
  it("lets the member's own turn change data at its level, within their agent's rules", async () => {
    const { ana, server, held, write } = guarded();
    await ana.seats.give(ROOM, "p", seatTurn(1, ANA, true));
    await settle();
    const fork = ana.sessionOf(1);
    expect(fork).not.toBe("s1");
    await write(fork, { discount: 5 });
    expect(server.calls).toEqual([{ name: "update_deal", args: { discount: 5 } }]);
    // Her agent's rule asks for her approval: held, for the room the turn is in, apart (only she sees the call).
    const verdict = await stopped(write(fork, { discount: 20 }));
    expect(verdict).toMatchObject({ outcome: "held" });
    expect(held).toEqual([expect.objectContaining({ kind: "approval", chatId: ROOM.chatId, seat: true, status: "pending" })]);
    expect(server.calls).toHaveLength(1);
    // Its tools were set up to match: it may change data.
    expect(ana.configured).toEqual([{ session: fork, writes: true }]);
  });

  it("refuses writes on anyone else's turn of the same seat, and from a session with no seat's turn", async () => {
    const { ana, server, held, write } = guarded();
    // Mia asks Ana's agent; and Radu says that it is Ana's, which the seat checks against who asked.
    await ana.seats.give(ROOM, "p", seatTurn(1, MIA, false));
    await ana.seats.give(ROOM, "p", seatTurn(2, RADU, true));
    await settle();
    for (const turn of [1, 2]) {
      expect(await stopped(write(ana.sessionOf(turn), { discount: 5 }))).toMatchObject({ outcome: "refused" });
    }
    expect(await stopped(write("nobody's", { discount: 5 }))).toMatchObject({ outcome: "refused", message: expect.stringContaining("no turn") });
    expect([server.calls, held]).toEqual([[], []]);
    // Offered no tool that changes data in the first place.
    expect(ana.configured.map((one) => one.writes)).toEqual([false, false]);
  });

  it("goes as far as the turn allows: the owner's own message runs, their routed turn proposes, anyone else's reads", () => {
    const turn = (calledBy: SeatTurn["calledBy"], byOwner: boolean, unattended?: true) => ({ calledBy, byOwner, ...(unattended && { unattended }) });
    expect(seatLevel(turn(ANA, true)).level).toBe(4);
    expect(seatLevel(turn({ ...ANA, routed: true }, true)).level).toBe(2);
    expect(seatLevel(turn({ ...ANA, drafts: true }, true)).level).toBe(2);
    expect(seatLevel(turn(MIA, false)).level).toBe(1);
    expect(seatLevel(turn({ ...RADU, drafts: true }, false)).level).toBe(1);
    expect(seatLevel(turn(ANA, true, true)).level).toBe(1);
  });

  it("refuses a seat's call for an agent that is gone or off, or on a server it may not use", async () => {
    const ana = new AnasObject();
    await ana.seats.give(ROOM, "p", seatTurn(1, ANA, true));
    await settle();
    const fork = ana.sessionOf(1);
    const callerWith = (agent: AgentDefinition | null) => ana.seats.caller(fork, { server: "crm" }, async () => agent);
    await expect(callerWith(PLANNER)).resolves.toMatchObject({ level: 4, origin: { session: fork, seat: { ...ROOM, agentId: "p" } } });
    await expect(callerWith(null)).rejects.toThrow("gone");
    await expect(callerWith({ ...PLANNER, enabled: false })).rejects.toThrow("off");
    await expect(callerWith({ ...PLANNER, servers: ["db"] })).rejects.toThrow("not one of the servers");
  });

  it("runs anyone's Yes to an offer in a fork of the seat's session, so only its posted reply reaches it", async () => {
    const ana = new AnasObject();
    // Radu says Yes to the planner's offer: draftTools reads every server of Ana's agent, her own ones too.
    await ana.seats.give(ROOM, "p", seatTurn(1, { ...RADU, drafts: true }, false));
    await settle();
    const fork = ana.sessionOf(1);
    expect(fork).toMatch(/^s1-fork/);
    // It is not Ana's turn for all that: her memory notes do not take its words as hers, and it changes nothing.
    expect(ana.seats.memoryAgent(fork)).toMatchObject({ byOwner: false });
    expect(seatLevel(ana.seats.turnIn(fork)!.turn).level).toBe(1);
  });
});

describe("A seat's held action", () => {
  const rules = (inChat: readonly string[]): ChatRules => ({ ownerUid: RADU.uid, isInChat: (uid) => inChat.includes(uid), hasAccount: () => true });
  const entry: RosterEntry = {
    agentId: "p",
    ownerUid: ANA.uid,
    name: "planner-ana",
    session: "",
    avatar: "pl",
    color: "teal",
    job: "Plans.",
    mirrored: -1,
    off: false,
    shared: false,
    muted: false,
    seat: "seat-p",
  } as RosterEntry;

  async function heldOne() {
    const { ana, held, write } = guarded();
    await ana.seats.give(ROOM, "p", seatTurn(1, ANA, true));
    await settle();
    await stopped(write(ana.sessionOf(1), { discount: 20 }));
    return held[0];
  }

  it("has its card in the room, for its agent's owner alone, who alone decides it", async () => {
    const view = await heldOne();
    const room = new SeatActions(memorySql());
    expect(room.put(ROOM.chatId, ANA.uid, "p", view)).toBe(true);
    expect(room.of(ANA.uid)).toEqual([{ ...view, seat: true }]);
    expect([room.of(MIA.uid), room.of(RADU.uid)]).toEqual([[], []]);
    const entryOf = (agentId: string) => (agentId === "p" ? entry : null);
    expect(room.decider(rules([ANA.uid, MIA.uid]), entryOf, ANA.uid, view.id)).toBe(entry);
    // Not the chat's owner, nor another member: not their call, nor their sign-ins.
    expect(room.decider(rules([ANA.uid, MIA.uid]), entryOf, RADU.uid, view.id)).toMatchObject({ status: 403 });
    expect(room.decider(rules([ANA.uid, MIA.uid]), entryOf, MIA.uid, view.id)).toMatchObject({ status: 403 });
    // Nor Ana once she left the chat, or her agent did.
    expect(room.decider(rules([MIA.uid]), entryOf, ANA.uid, view.id)).toMatchObject({ status: 404 });
    expect(room.decider(rules([ANA.uid]), () => null, ANA.uid, view.id)).toMatchObject({ status: 404 });
    // Another member's seat cannot take its card over, nor one for another chat be put here.
    expect(room.put(ROOM.chatId, MIA.uid, "m", { ...view, status: "declined" })).toBe(false);
    expect(room.put("other", ANA.uid, "p", { ...view, id: "00000000000000aa" })).toBe(false);
    expect(room.of(ANA.uid)).toHaveLength(1);
    // Once it ended, the card goes (its outcome reaches the agent's session and her feed).
    expect(room.put(ROOM.chatId, ANA.uid, "p", { ...view, status: "done" })).toBe(true);
    expect(room.of(ANA.uid)).toEqual([]);
  });

  it("is in the member's Needs you as the room's: it opens the shared chat", async () => {
    const view = await heldOne();
    const item = approvalFeed(view, "Launch plan", "group");
    expect(item).toMatchObject({ open: { to: "chat", chatId: ROOM.chatId }, action: { chatId: ROOM.chatId, id: view.id }, chat: { id: ROOM.chatId } });
  });
});

describe("A seat reads as its room's kind", () => {
  it("keeps nothing a seat's turn says once the room is off the record, and fails closed on a room it never heard of", async () => {
    const ana = new AnasObject();
    expect(ana.seats.roomKind(ROOM)).toBe("off_record");
    await ana.seats.give(ROOM, "p", seatTurn(1, ANA, true, "group"));
    await settle();
    const fork = ana.sessionOf(1);
    const writer = () => {
      const agent = ana.seats.memoryAgent(fork)!;
      return { chatId: agent.room!.chatId, kinds: [agent.room!.kind], alone: false, agentId: agent.agentId, byOwner: agent.byOwner, learnedBy: agent.name };
    };
    expect(placeNote(writer(), "chat", "preference")).not.toHaveProperty("error");
    // Radu makes his chat off the record while the turn runs (SeatLink.kind).
    ana.seats.setKind(ROOM, "off_record");
    expect(ana.seats.roomKind(ROOM)).toBe("off_record");
    expect(placeNote(writer(), "chat", "preference")).toEqual({ error: expect.stringContaining("off the record") });
  });
});
