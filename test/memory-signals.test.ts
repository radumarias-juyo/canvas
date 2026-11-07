import { describe, expect, it } from "vitest";
import type { ChatKind } from "../shared/chat-kinds.ts";
import { checkSignal, keepsSignals, looksLikeCorrection, MAX_SIGNALS_A_DAY, questionKey, SIGNAL_DAYS, type AgentSignal } from "../shared/signals.ts";
import { AGENT_NAME } from "../shared/mentions.ts";
import { ChatSignals, REEDIT_MS } from "../worker/memory/chat-signals.ts";
import { SignalStore } from "../worker/memory/signals.ts";
import { memoryKv, memorySql } from "./fakes.ts";

const T0 = 1_800_000_000_000;
const DAY = 86_400_000;
const OWNER = "owner-uid";
const MEMBER = "member-uid";
const RESEARCH = "a".repeat(16);
const SEAT = "b".repeat(16);

function signal(overrides: Partial<AgentSignal> = {}): AgentSignal {
  return { agentId: RESEARCH, chatId: "c1", chatOwner: OWNER, chatKind: "group", alone: false, signal: "replied", actor: "none", at: T0, ...overrides };
}

describe("signals in the owner's directory", () => {
  it("keeps a chat's signals and reads them back by agent and time", () => {
    let now = T0;
    const store = new SignalStore(memorySql(), () => now);
    expect(store.record([signal({ turn: 3 }), signal({ signal: "corrected", actor: "member", seq: 12, at: T0 + 1 })])).toBe(2);
    now = T0 + 10;
    expect(store.between(RESEARCH, T0, T0 + 10).map((s) => s.signal)).toEqual(["corrected", "replied"]);
    expect(store.between(RESEARCH, T0, T0 + 10)[0]).toMatchObject({ seq: 12, actor: "member", chatKind: "group" });
    expect(store.active(RESEARCH, T0, T0 + 10)).toBe(true);
    expect(store.active(RESEARCH, T0 + 2, T0 + 10)).toBe(false);
    expect(store.active(SEAT, T0, T0 + 10)).toBe(false);
  });

  it("never keeps a signal from a chat off the record, as the chat says it or as the owner's row of it says", () => {
    const store = new SignalStore(memorySql(), () => T0);
    expect(store.record([signal({ chatKind: "off_record" })])).toBe(0);
    // The chat says group, but the owner's sidebar already heard it went off the record: the strictest wins.
    const kinds: Record<string, ChatKind> = { c1: "off_record" };
    expect(store.record([signal()], (chatId) => kinds[chatId] ?? null)).toBe(0);
    expect(store.list()).toEqual([]);
    expect(keepsSignals("off_record")).toBe(false);
    expect(keepsSignals(null)).toBe(false);
    expect(keepsSignals("private", "group")).toBe(true);
  });

  it("refuses anything that is not a signal, and a detail on anything but a reaction", () => {
    const store = new SignalStore(memorySql(), () => T0);
    expect(store.record([{ ...signal(), signal: "something" }, { ...signal(), chatKind: "secret" }, null, "x", signal({ detail: "free text" })])).toBe(0);
    expect(store.record([signal({ signal: "reaction", detail: "free text" })])).toBe(0);
    expect(store.record([signal({ signal: "reaction", detail: "🎉", seq: 4 })])).toBe(1);
    // Only a signal's own fields reach the row.
    expect(checkSignal({ ...signal(), text: "what someone said" })).not.toHaveProperty("text");
  });

  it("keeps at most a day's worth per agent, and lets old days go", () => {
    let now = T0;
    const store = new SignalStore(memorySql(), () => now);
    const many = Array.from({ length: MAX_SIGNALS_A_DAY + 5 }, (_, i) => signal({ at: T0 - i }));
    expect(store.record(many)).toBe(MAX_SIGNALS_A_DAY);
    expect(store.record([signal({ agentId: SEAT })])).toBe(1);
    now = T0 + (SIGNAL_DAYS + 1) * DAY;
    store.record([signal({ agentId: SEAT, at: now })]);
    expect(store.list()).toHaveLength(1);
  });

  it("forgets a chat's and an agent's signals", () => {
    const store = new SignalStore(memorySql(), () => T0);
    store.record([signal(), signal({ chatId: "c2" }), signal({ agentId: SEAT, chatId: "c2" })]);
    store.forgetChat("c1");
    expect(store.list().map((s) => s.chatId)).toEqual(["c2", "c2"]);
    store.forgetAgent(SEAT);
    expect(store.list()).toHaveLength(1);
  });
});

/** A chat object's signals, with the directories it sends to. */
function chat(kind: ChatKind = "group", alone = false) {
  const sent: Record<string, AgentSignal[]> = {};
  const waiting: Promise<unknown>[] = [];
  let chatKind = kind;
  let now = T0;
  const kv = memoryKv();
  const signals = new ChatSignals({
    chatId: "room",
    chatOwner: OWNER,
    kind: () => chatKind,
    alone: () => alone,
    ownerOf: (agentId) => (agentId === RESEARCH ? OWNER : agentId === SEAT ? MEMBER : undefined),
    directory: (uid) => ({ recordSignals: (batch: AgentSignal[]) => (sent[uid] ??= []).push(...batch) }),
    kv,
    waitUntil: (promise) => void waiting.push(promise),
    now: () => now,
  });
  return {
    signals,
    kv,
    sent: async () => {
      await Promise.all(waiting);
      return sent;
    },
    setKind: (next: ChatKind) => (chatKind = next),
    tick: (ms: number) => (now += ms),
  };
}

describe("a chat's signals", () => {
  it("sends each to the agent's owner: the chat's owner for theirs, the member for a seat", async () => {
    const room = chat();
    room.signals.replied({ agentId: RESEARCH, turn: 1, calledBy: { name: "Ana", uid: MEMBER } });
    room.signals.replied({ agentId: SEAT, turn: 2, calledBy: { name: "Radu", uid: OWNER } });
    room.signals.muted(MEMBER, RESEARCH);
    room.signals.muted(OWNER, SEAT);
    const sent = await room.sent();
    expect(sent[OWNER].map((s) => [s.agentId, s.signal, s.actor])).toEqual([
      [RESEARCH, "replied", "none"],
      [RESEARCH, "muted", "member"],
    ]);
    expect(sent[MEMBER].map((s) => [s.agentId, s.signal, s.actor])).toEqual([
      [SEAT, "replied", "none"],
      [SEAT, "muted", "member"],
    ]);
    expect(sent[OWNER][0]).toMatchObject({ chatId: "room", chatOwner: OWNER, chatKind: "group", alone: false, turn: 1 });
  });

  it("records nothing in a chat off the record, and forgets the questions it kept when it goes off", async () => {
    const room = chat("off_record");
    room.signals.replied({ agentId: RESEARCH, turn: 1, calledBy: { name: "Ana", uid: MEMBER } });
    room.signals.message(MEMBER, "no, that is wrong", RESEARCH, 5);
    room.signals.reacted(MEMBER, RESEARCH, 4, "👍");
    room.signals.turnEnded({ id: 1, agentId: RESEARCH, calledBy: { name: "x" } }, "passed");
    expect(await room.sent()).toEqual({});
    expect(room.kv.map.size).toBe(0);

    const later = chat();
    later.signals.message(MEMBER, "what were signups in the west region", undefined, 1);
    expect(later.kv.map.size).toBe(1);
    later.setKind("off_record");
    later.signals.forget();
    expect(later.kv.map.size).toBe(0);
  });

  it("a reply to an agent that corrects it is `corrected`; one that does not, nothing", async () => {
    const room = chat();
    room.signals.message(OWNER, "No, I meant the weekly numbers", RESEARCH, 7);
    room.signals.message(OWNER, "thanks, perfect", RESEARCH, 8);
    room.signals.message(OWNER, "no idea", undefined, 9);
    const sent = await room.sent();
    expect(sent[OWNER].map((s) => [s.signal, s.actor, s.seq])).toEqual([["corrected", "owner", 7]]);
  });

  it("asking again what an agent answered is `repeated`, for that agent", async () => {
    const room = chat();
    room.signals.message(MEMBER, "What were signups in the west region last week?", undefined, 1);
    room.signals.replied({ agentId: SEAT, turn: 1, calledBy: { name: "Ana", uid: MEMBER } });
    room.tick(DAY);
    room.signals.message(OWNER, "@research what were the signups last week in the west region", undefined, 9);
    const sent = await room.sent();
    expect(sent[MEMBER].map((s) => [s.signal, s.actor, s.seq])).toEqual([
      ["replied", "none", undefined],
      // The chat's owner is someone else to a member's agent.
      ["repeated", "member", 9],
    ]);
    // Only a key of the words is kept, never the message.
    expect(JSON.stringify([...room.kv.map.values()])).not.toContain("What were");
  });

  it("an unprompted turn that passed is `passed`; a failed hand-off is the handing agent's", async () => {
    const room = chat();
    room.signals.turnEnded({ id: 4, agentId: RESEARCH, calledBy: { name: "Ana", unprompted: "speak-up" } }, "passed");
    room.signals.turnEnded({ id: 5, agentId: SEAT, calledBy: { name: "research", agentId: RESEARCH } }, "failed");
    room.signals.turnEnded({ id: 6, agentId: SEAT, calledBy: { name: "research", agentId: RESEARCH } }, "done");
    const sent = await room.sent();
    expect(sent[OWNER].map((s) => [s.signal, s.turn])).toEqual([
      ["passed", 4],
      ["handoff_failed", 5],
    ]);
    expect(sent[MEMBER]).toBeUndefined();
  });

  it("drafts, actions, offers and reactions are the owner's or a member's", async () => {
    const room = chat("private", true);
    room.signals.draft(OWNER, RESEARCH, 3, "edited");
    room.signals.draft(OWNER, RESEARCH, 4, "discarded");
    room.signals.action(OWNER, RESEARCH, "decline");
    room.signals.offerTaken(OWNER, RESEARCH, 10);
    room.signals.reacted(OWNER, RESEARCH, 11, "🎉");
    room.signals.reacted(OWNER, "unknown-agent", 11, "🎉");
    const sent = await room.sent();
    expect(sent[OWNER].map((s) => s.signal)).toEqual(["draft_edited", "draft_discarded", "action_declined", "offer_taken", "reaction"]);
    expect(sent[OWNER].every((s) => s.alone && s.chatKind === "private" && s.actor === "owner")).toBe(true);
    expect(sent[OWNER][4].detail).toBe("🎉");
  });
});

describe("pi's signals", () => {
  it("are kept as pi's, in the chat owner's directory", async () => {
    const room = chat();
    room.signals.message(MEMBER, "no, that's the wrong quarter", AGENT_NAME, 3);
    room.signals.reacted(MEMBER, AGENT_NAME, 4, "👍");
    room.signals.action(OWNER, AGENT_NAME, "decline");
    room.signals.offerTaken(OWNER, AGENT_NAME, 5);
    room.signals.piReplied();
    const sent = await room.sent();
    expect(sent[OWNER].map((s) => [s.agentId, s.signal, s.actor])).toEqual([
      [AGENT_NAME, "corrected", "member"],
      [AGENT_NAME, "reaction", "member"],
      [AGENT_NAME, "action_declined", "owner"],
      [AGENT_NAME, "offer_taken", "owner"],
      [AGENT_NAME, "replied", "none"],
    ]);
    expect(sent[MEMBER]).toBeUndefined();
  });

  it("a question pi answered, asked again, is pi's `repeated`", async () => {
    const room = chat("private", true);
    room.signals.message(OWNER, "how many weekly signups in the north region", undefined, 1, true);
    room.signals.piReplied();
    room.signals.message(OWNER, "north region weekly signups how many", undefined, 7, true);
    const sent = await room.sent();
    expect(sent[OWNER].map((s) => [s.signal, s.seq])).toEqual([
      ["replied", undefined],
      ["repeated", 7],
    ]);
  });

  it("a page pi publishes again within minutes is `page_reedited`; later, nothing", async () => {
    const room = chat();
    room.signals.published("p1", 1);
    room.tick(REEDIT_MS / 2);
    room.signals.published("p1", 2);
    room.tick(REEDIT_MS * 2);
    room.signals.published("p1", 3);
    room.signals.published("p2", 1);
    const sent = await room.sent();
    expect(sent[OWNER].map((s) => [s.agentId, s.signal])).toEqual([[AGENT_NAME, "page_reedited"]]);
  });

  it("records nothing of pi's in a chat off the record", async () => {
    const room = chat("off_record");
    room.signals.piReplied();
    room.signals.published("p1", 1);
    room.signals.published("p1", 2);
    room.signals.message(OWNER, "no, wrong", AGENT_NAME, 2, true);
    expect(await room.sent()).toEqual({});
    expect(room.kv.map.size).toBe(0);
  });
});

describe("cheap guesses", () => {
  it("tells a correction from a reply that is not one", () => {
    expect(looksLikeCorrection("No, that's the monthly figure")).toBe(true);
    expect(looksLikeCorrection("@research that's wrong, it should be weekly")).toBe(true);
    expect(looksLikeCorrection("Not what I asked")).toBe(true);
    expect(looksLikeCorrection("Great, thanks!")).toBe(false);
    expect(looksLikeCorrection("Nothing else for now")).toBe(false);
  });

  it("keys a question by its words, whatever their order", () => {
    expect(questionKey("What were signups in the west region?")).toBe(questionKey("@pi signups in the WEST region: what were they"));
    expect(questionKey("thanks")).toBeNull();
    expect(questionKey("weekly signups west")).not.toBe(questionKey("weekly signups east"));
  });
});
