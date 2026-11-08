import { describe, expect, it } from "vitest";
import type { EntryRecord } from "@earendil-works/pi-durable";
import type { AgentDefinition } from "../shared/agents.ts";
import { CHAT_AGENT_KIND } from "../shared/agents.ts";
import type { ChatKind } from "../shared/chat-kinds.ts";
import { DECAY_DAYS, DREAM_NOW_MS, holdsContent, placeDreamNote, type Cited, type DreamItem } from "../shared/dream.ts";
import type { FeedInput } from "../shared/feed.ts";
import { reads, type MemoryNote } from "../shared/memory.ts";
import { CHAT_MESSAGE_KIND } from "../shared/protocol.ts";
import type { AgentSignal } from "../shared/signals.ts";
import { wallClock } from "../worker/agents/runs/schedule.ts";
import { AgentStore } from "../worker/agents/store.ts";
import { Dreamer, DreamStore, nextDreamAt, nightWindow, type DreamAnswer, type DreamHost } from "../worker/memory/dream.ts";
import { dreamLines, type DreamExcerpt } from "../worker/memory/dream-input.ts";
import { SignalStore } from "../worker/memory/signals.ts";
import { MemoryStore } from "../worker/memory/store.ts";
import { UserDreams } from "../worker/memory/user-dreams.ts";
import { memoryKv, memorySql } from "./fakes.ts";

const OWNER = "owner-uid";
const MEMBER = "member-uid";
const AGENT = "a".repeat(16);
const DAY = 86_400_000;
const TZ = "Europe/Bucharest";
// Sat 7 Nov 2026, 03:00 in Bucharest (UTC+2): the night's dream looks back on the 6th.
const DUE = Date.UTC(2026, 10, 7, 1, 0);
const WINDOW = nightWindow(TZ, DUE);
const NOON = WINDOW.from + 9 * 3_600_000;

describe("when a dream runs", () => {
  it("is 03:00 in the owner's time zone, also across a daylight-saving change", () => {
    const due = nextDreamAt(TZ, Date.UTC(2026, 10, 6, 12, 0));
    expect(due).toBe(DUE);
    expect(wallClock(due, TZ)).toMatchObject({ hour: 3, minute: 0, day: 7 });
    // The clocks went back on 25 Oct 2026 (03:00 → 02:00): the nights either side are still 03:00 local.
    const before = nextDreamAt(TZ, Date.UTC(2026, 9, 24, 12, 0));
    const after = nextDreamAt(TZ, before);
    expect(wallClock(before, TZ)).toMatchObject({ day: 25, hour: 3 });
    expect(wallClock(after, TZ)).toMatchObject({ day: 26, hour: 3 });
    expect(after - before).toBe(25 * 3_600_000);
    // Spring forward (29 Mar 2026): 23 hours apart.
    const spring = nextDreamAt(TZ, Date.UTC(2026, 2, 28, 12, 0));
    expect(nextDreamAt(TZ, spring) - spring).toBe(23 * 3_600_000);
  });

  it("looks back on the day before: from the night before's 03:00", () => {
    expect(WINDOW).toEqual({ day: "2026-11-06", from: DUE - DAY, to: DUE });
  });
});

/** A chat's line. */
function item(seq: number, who: DreamItem["who"], text: string, origin: DreamItem["origin"] = "shared", name: string = who): DreamItem {
  return { seq, who, name, text, at: NOON + seq, origin };
}

type Chat = { chatId: string; chatOwner?: string; kind: ChatKind; private: boolean; own?: boolean; people?: string[]; items: DreamItem[] };

/** A user's directory as the dream sees it: its stores, their chats, and a scripted model answering each call in turn. */
function world(options: { chats: Chat[]; answers?: (string | ((prompt: string) => string))[]; over?: string; agents?: Partial<AgentDefinition>[] }) {
  let now = DUE + 60_000;
  const sql = memorySql();
  const memory = new MemoryStore(sql, () => now++);
  const signals = new SignalStore(sql, () => now);
  const dreams = new DreamStore(sql);
  const prompts: string[] = [];
  const spent: { tokens: number; costUsd: number }[] = [];
  const answers = [...(options.answers ?? [])];
  const chats = new Map(options.chats.map((chat) => [chat.chatId, chat]));
  for (const chat of options.chats) {
    signals.record([signalIn(chat, { signal: "replied", actor: "none", at: NOON })]);
  }
  const host: DreamHost = {
    memory,
    signals,
    dreams,
    now: () => now,
    describe: (subject) => (subject.kind === "pi" ? { name: "pi" } : { name: "@research", job: "finds numbers" }),
    excerpt: async ({ chatId }) => {
      const chat = chats.get(chatId);
      if (!chat) return null;
      if (chat.kind === "off_record") return { off: true } satisfies DreamExcerpt;
      return { kind: chat.kind, private: chat.private, own: chat.own ?? true, people: chat.people ?? [], items: chat.items };
    },
    overBudget: async () => options.over,
    complete: async (_subject, _system, prompt): Promise<DreamAnswer | null> => {
      prompts.push(prompt);
      // An answer that names a chat's words answers only the call that reads them (calls go in no fixed order).
      const at = answers.findIndex((each) => typeof each === "string" || each(prompt) !== "");
      const next = at < 0 ? '{"summary": "nothing", "notes": [], "retire": []}' : answers.splice(at, 1)[0];
      return { text: typeof next === "string" ? next : next(prompt), tokens: 1000, costUsd: 0.002 };
    },
    spent: (answer) => void spent.push(answer),
    unopenedReports: () => [],
    changed: () => {},
  };
  return { memory, signals, dreams, host, prompts, spent, dreamer: new Dreamer(host), tick: (ms: number) => (now += ms), sql };
}

function signalIn(chat: Pick<Chat, "chatId" | "chatOwner" | "kind" | "private">, fields: Partial<AgentSignal>): AgentSignal {
  return {
    agentId: AGENT,
    chatId: chat.chatId,
    chatOwner: chat.chatOwner ?? OWNER,
    chatKind: chat.kind,
    alone: chat.private,
    signal: "replied",
    actor: "none",
    at: NOON,
    ...fields,
  };
}

const answer = (notes: object[], retire: object[] = [], summary = "Learned a few things.") => JSON.stringify({ summary, notes, retire });
/** An answer for the call whose prompt holds `words` only. */
const when = (words: string, text: string) => (prompt: string) => (prompt.includes(words) ? text : "");
const note = (fields: object) => ({ kind: "preference", scope: "chat", why: "said so", confidence: 0.9, ...fields });

const PRIVATE: Chat = { chatId: "home", kind: "private", private: true, items: [item(1, "owner", "Keep it to three bullets please", "private"), item(2, "self", "Here are three bullets", "private")] };
const GROUP_X: Chat = {
  chatId: "groupx",
  kind: "group",
  private: false,
  people: ["Radu Marias", "Ana Pop"],
  items: [item(1, "member", "@research what were West signups?", "shared", "Ana Pop"), item(2, "self", "West had 1,204 signups."), item(3, "owner", "Use a table next time", "shared", "Radu Marias")],
};
const GROUP_Y: Chat = { chatId: "groupy", kind: "group", private: false, people: ["Ion"], items: [item(1, "member", "hello", "shared", "Ion"), item(2, "self", "hi")] };

/** Who reads a note: an agent's turn in `chatId` of `kind`, alone or not. */
const agentIn = (chatId: string, kind: ChatKind = "group", alone = false) => ({ chatId, kinds: [kind], alone, agentId: AGENT });
const piIn = (chatId: string, kind: ChatKind = "group", alone = false) => ({ chatId, kinds: [kind], alone });

describe("a dream", () => {
  it("is quiet with nothing that day, and skipped over budget, without a model call", async () => {
    const quiet = world({ chats: [] });
    expect((await quiet.dreamer.dream({ kind: "agent", agentId: AGENT }, WINDOW)).status).toBe("quiet");
    expect(quiet.prompts).toEqual([]);

    const over = world({ chats: [PRIVATE], over: "past the cap" });
    const record = await over.dreamer.dream({ kind: "agent", agentId: AGENT }, WINDOW);
    expect(record).toMatchObject({ status: "skipped", reason: "past the cap" });
    expect(over.prompts).toEqual([]);
    // Activity outside the window does not count.
    const old = world({ chats: [] });
    old.signals.record([signalIn(PRIVATE, { at: WINDOW.from - 1 })]);
    expect((await old.dreamer.dream({ kind: "agent", agentId: AGENT }, WINDOW)).status).toBe("quiet");
  });

  it("runs once per subject and day, and counts its cost", async () => {
    const w = world({ chats: [PRIVATE], answers: [answer([note({ text: "Keep answers to three bullets.", scope: "wide", cites: ["c0.1"] })])] });
    const first = await w.dreamer.dream({ kind: "agent", agentId: AGENT }, WINDOW);
    const again = await w.dreamer.dream({ kind: "agent", agentId: AGENT }, WINDOW);
    expect(first.status).toBe("dreamt");
    expect(again).toEqual(first);
    expect(w.prompts).toHaveLength(1);
    expect(w.spent.map(({ tokens, costUsd }) => ({ tokens, costUsd }))).toEqual([{ tokens: 1000, costUsd: 0.002 }]);
    expect(first).toMatchObject({ costUsd: 0.002, tokens: 1000, summary: "Learned a few things." });
    // pi's dream that day is its own.
    expect((await w.dreamer.dream({ kind: "pi" }, WINDOW)).status).toBe("quiet");
  });

  it("saves what it learned in the owner's private chat as the agent's own, in use, with its why", async () => {
    const w = world({ chats: [PRIVATE], answers: [answer([note({ text: "Keep answers to three bullets.", scope: "wide", cites: ["c0.1", "c0.s0"] })])] });
    const record = await w.dreamer.dream({ kind: "agent", agentId: AGENT }, WINDOW);
    const [saved] = w.memory.list();
    expect(saved).toMatchObject({ scope: "agent", agentId: AGENT, source: "overnight", confirmed: true, confidence: 0.9, learnedBy: "research" });
    expect(saved.why).toEqual({ text: "said so", cites: [{ chatId: "home", seq: 1 }, { chatId: "home", signal: "replied" }], day: "2026-11-06" });
    expect(record.learned).toEqual([saved.id]);
    expect(reads(agentIn("anywhere"), saved)).toBe(true);
  });

  it("keeps a lesson from shared chat X to chat X: never chat Y, never the agent's own unconfirmed", async () => {
    const w = world({
      chats: [GROUP_X, GROUP_Y],
      answers: [
        when("1,204", answer([
          note({ text: "Answer West questions with a table.", scope: "chat", cites: ["c0.3"] }),
          // Asked wide, but it names a figure from the chat: it stays with the chat.
          note({ text: "West had 1,204 signups.", scope: "wide", kind: "fact", cites: ["c0.2"] }),
          // Cites a line of a chat this call did not read (Y is read in a call of its own): not saved.
          note({ text: "Greet people back.", scope: "wide", cites: ["c1.1"] }),
        ])),
      ],
    });
    await w.dreamer.dream({ kind: "agent", agentId: AGENT }, WINDOW);
    const notes = w.memory.list();
    expect(notes.map((each) => [each.text, each.scope, each.chatId, each.confirmed])).toEqual([
      ["West had 1,204 signups.", "chat", "groupx", false],
      ["Answer West questions with a table.", "chat", "groupx", true],
    ]);
    for (const each of notes) {
      expect(reads(agentIn("groupy"), each)).toBe(false);
      expect(reads(agentIn("home", "private", true), each)).toBe(false);
      expect(each.scope).not.toBe("agent");
    }
    // One call per shared chat: X's lines never reach Y's call, nor Y's X's.
    expect(w.prompts).toHaveLength(2);
    const [x, y] = [w.prompts.find((each) => each.includes("1,204"))!, w.prompts.find((each) => !each.includes("1,204"))!];
    expect(x).not.toContain("hello");
    expect(y).toContain("hello");
    expect(y).not.toContain("Ana");
  });

  it("proposes a how-to-work lesson from a shared chat as the agent's own, waiting for the owner", async () => {
    const w = world({
      chats: [GROUP_X],
      answers: [
        answer([
          note({ text: "Put comparisons in a table rather than prose.", scope: "wide", cites: ["c0.3"], confidence: 1 }),
          // With a name of the chat's people: stays with the chat.
          note({ text: "Ana prefers tables.", scope: "wide", cites: ["c0.1"] }),
        ]),
      ],
    });
    const record = await w.dreamer.dream({ kind: "agent", agentId: AGENT }, WINDOW);
    const wide = w.memory.list().find((each) => each.scope === "agent")!;
    expect(wide).toMatchObject({ text: "Put comparisons in a table rather than prose.", confirmed: false });
    expect(reads(agentIn("groupy"), wide)).toBe(false);
    expect(record.waiting).toContain(wide.id);
    const named = w.memory.list().find((each) => each.text.startsWith("Ana"))!;
    expect(named).toMatchObject({ scope: "chat", chatId: "groupx" });
  });

  it("saves a fact off until confirmed, even from the owner's private chat", async () => {
    const w = world({ chats: [PRIVATE], answers: [answer([note({ text: "The target is a monthly figure.", kind: "fact", scope: "wide", cites: ["c0.1"] })])] });
    await w.dreamer.dream({ kind: "agent", agentId: AGENT }, WINDOW);
    expect(w.memory.list()[0]).toMatchObject({ scope: "agent", confirmed: false });
  });

  it("never reads a reply built on private servers in a shared chat, nor writes it where members' turns read", async () => {
    const forked: Chat = {
      ...GROUP_X,
      items: [item(4, "owner", "@research check my calendar", "shared", "Radu Marias"), item(5, "self", "You meet the board at 4pm Tuesday.", "fork")],
    };
    const w = world({ chats: [forked], answers: [answer([note({ text: "The owner meets the board on Tuesdays.", scope: "chat", kind: "fact", cites: ["c0.5"] })])] });
    await w.dreamer.dream({ kind: "agent", agentId: AGENT }, WINDOW);
    expect(w.prompts[0]).not.toContain("board");
    expect(w.memory.list()).toEqual([]);
  });

  it("never reads such a reply in the owner's private chat either: the agent's own notes are read where others are", async () => {
    const forked: Chat = { ...PRIVATE, items: [item(1, "owner", "check my calendar", "private"), item(2, "self", "You meet the board at 4pm Tuesday.", "fork")] };
    const w = world({ chats: [forked], answers: [answer([note({ text: "The owner meets the board on Tuesdays.", scope: "wide", cites: ["c0.2"] })])] });
    await w.dreamer.dream({ kind: "agent", agentId: AGENT }, WINDOW);
    expect(w.prompts[0]).not.toContain("board");
    expect(w.memory.list().filter((each) => each.scope === "agent")).toEqual([]);
  });

  it("puts anything citing a private-fork line only in the owner's own notes", () => {
    const fork: Cited = { chatId: "groupx", origin: "fork", byOwner: true, people: [], own: true };
    for (const scope of ["chat", "wide"] as const) {
      const place = placeDreamNote({ kind: "agent", agentId: AGENT }, { text: "x", kind: "preference", scope, confidence: 1 }, [fork]);
      expect(place).toMatchObject({ scope: "user" });
      // The owner's own notes: only where nobody else reads the replies.
      expect(reads(agentIn("groupx"), { ...(place as { scope: "user" }), confirmed: true })).toBe(false);
    }
  });

  it("reads nothing of a chat off the record", async () => {
    const off: Chat = { chatId: "off", kind: "off_record", private: false, items: [item(1, "owner", "secret plan")] };
    const w = world({ chats: [PRIVATE] });
    // Recorded as group, now off the record: the chat says so when asked.
    w.signals.record([signalIn({ ...off, kind: "group" }, {})]);
    const hostChats = w.host.excerpt;
    w.host.excerpt = async (chat, subject, from, to) => (chat.chatId === "off" ? { off: true } : hostChats(chat, subject, from, to));
    await w.dreamer.dream({ kind: "agent", agentId: AGENT }, WINDOW);
    expect(w.prompts.join("\n")).not.toContain("secret");
  });

  it("keeps no note for another person's chat, where the owner's agent is a guest", async () => {
    const theirs: Chat = { ...GROUP_X, chatId: "theirs", chatOwner: MEMBER, own: false };
    const w = world({
      chats: [theirs],
      answers: [answer([note({ text: "Use a table here.", scope: "chat", cites: ["c0.3"] }), note({ text: "Prefer tables for comparisons.", scope: "wide", cites: ["c0.3"] })])],
    });
    await w.dreamer.dream({ kind: "agent", agentId: AGENT }, WINDOW);
    expect(w.memory.list().map((each) => [each.scope, each.confirmed])).toEqual([["agent", false]]);
  });

  it("merges into a note it has instead of adding a near copy", async () => {
    const w = world({ chats: [PRIVATE] });
    const kept = w.memory.add({ scope: "agent", agentId: AGENT, text: "Keep answers short.", source: "overnight", kind: "preference", confirmed: true });
    if ("error" in kept) throw new Error(kept.error);
    w.host.complete = async (_s, _sys, prompt) => {
      expect(prompt).toContain(`[${kept.note.id}]`);
      return { text: answer([note({ text: "Keep answers to three bullets.", scope: "wide", cites: ["c0.1"], replaces: kept.note.id })]), tokens: 1, costUsd: 0 };
    };
    await w.dreamer.dream({ kind: "agent", agentId: AGENT }, WINDOW);
    expect(w.memory.list().map((each) => [each.id, each.text])).toEqual([[kept.note.id, "Keep answers to three bullets."]]);
    // The same text again is the same note.
    const again = world({ chats: [PRIVATE], answers: [answer([note({ text: "keep answers short.", scope: "wide", cites: ["c0.1"] })])] });
    again.memory.add({ scope: "agent", agentId: AGENT, text: "Keep answers short.", source: "overnight", kind: "preference", confirmed: true });
    await again.dreamer.dream({ kind: "agent", agentId: AGENT }, WINDOW);
    expect(again.memory.list()).toHaveLength(1);
  });

  it("retires notes it learned that nothing read for a month, and those it asks to; both can come back", async () => {
    const w = world({ chats: [PRIVATE] });
    const add = (text: string, fields: Partial<MemoryNote> = {}) => {
      const added = w.memory.add({ scope: "agent", agentId: AGENT, text, source: "overnight", kind: "preference", confirmed: true, ...fields });
      if ("error" in added) throw new Error(added.error);
      return added.note;
    };
    const stale = add("Stale lesson.");
    const used = add("Used lesson.");
    const pinned = add("Pinned lesson.", { pinned: true });
    const wrong = add("Wrong lesson.");
    const person = w.memory.add({ scope: "agent", agentId: AGENT, text: "Mine.", source: "person", kind: "preference", confirmed: true });
    w.memory.use([used.id]);
    w.tick(DECAY_DAYS * DAY);
    w.host.complete = async () => ({ text: answer([], [{ id: wrong.id, why: "turned out wrong" }, { id: "id" in person ? person.id : "", why: "x" }]), tokens: 1, costUsd: 0 });
    // A month later, with that day's activity.
    const later = { day: "2026-12-06", from: w.host.now() - DAY, to: w.host.now() + 1 };
    w.signals.record([signalIn(PRIVATE, { at: w.host.now() - 10 })]);
    const record = await w.dreamer.dream({ kind: "agent", agentId: AGENT }, later);
    expect(new Set(record.retired)).toEqual(new Set([stale.id, wrong.id]));
    expect(w.memory.get(used.id)?.forgottenAt).toBeUndefined();
    expect(w.memory.get(pinned.id)?.forgottenAt).toBeUndefined();
    expect(w.memory.restore(stale.id)).toMatchObject({ id: stale.id });
    expect(w.memory.get(stale.id)?.forgottenAt).toBeUndefined();
  });

  it("refuses an answer that is not JSON, and a note that cites nothing it read", async () => {
    const w = world({ chats: [PRIVATE], answers: ["I think the owner likes bullets."] });
    expect((await w.dreamer.dream({ kind: "agent", agentId: AGENT }, WINDOW)).status).toBe("failed");
    const w2 = world({ chats: [PRIVATE], answers: [answer([note({ text: "Made up.", scope: "wide", cites: ["c7.1"] }), note({ text: "No cites.", scope: "wide", cites: [] })])] });
    await w2.dreamer.dream({ kind: "agent", agentId: AGENT }, WINDOW);
    expect(w2.memory.list()).toEqual([]);
  });
});

describe("pi's dream", () => {
  it("saves a lesson from the owner's private chats as the owner's own notes, read wherever only they read", async () => {
    const w = world({ chats: [PRIVATE], answers: [answer([note({ text: "Keep answers to three bullets.", scope: "wide", cites: ["c0.1"] })])] });
    w.signals.record([{ ...signalIn(PRIVATE, {}), agentId: "pi" }]);
    await w.dreamer.dream({ kind: "pi" }, WINDOW);
    const [saved] = w.memory.list();
    expect(saved).toMatchObject({ scope: "user", source: "overnight", learnedBy: "pi", confirmed: true });
    expect(saved.agentId).toBeUndefined();
    expect(reads(piIn("other", "private", true), saved)).toBe(true);
    expect(reads(piIn("groupx"), saved)).toBe(false);
  });

  it("keeps a lesson from a shared chat to that chat: never another chat, never the owner's own unconfirmed", async () => {
    const w = world({
      chats: [GROUP_X, GROUP_Y],
      answers: [
        when(
          "1,204",
          answer([
            note({ text: "Answer West questions with a table.", scope: "chat", cites: ["c0.3"] }),
            note({ text: "Put comparisons in a table rather than prose.", scope: "wide", cites: ["c0.3"] }),
          ]),
        ),
      ],
    });
    for (const chat of [GROUP_X, GROUP_Y]) w.signals.record([{ ...signalIn(chat, {}), agentId: "pi" }]);
    await w.dreamer.dream({ kind: "pi" }, WINDOW);
    const notes = w.memory.list();
    const chat = notes.find((each) => each.scope === "chat")!;
    const wide = notes.find((each) => each.scope === "user")!;
    expect(chat).toMatchObject({ chatId: "groupx", confirmed: true });
    expect(reads(piIn("groupy"), chat)).toBe(false);
    expect(reads(piIn("home", "private", true), chat)).toBe(false);
    expect(wide).toMatchObject({ confirmed: false });
    expect(reads(piIn("home", "private", true), wide)).toBe(false);
    expect(w.prompts).toHaveLength(2);
  });

  it("is shown only the notes everyone who reads its call's notes may read", async () => {
    const w = world({ chats: [GROUP_X] });
    w.signals.record([{ ...signalIn(GROUP_X, {}), agentId: "pi" }]);
    w.memory.add({ scope: "user", text: "Owner's private habit.", source: "person", kind: "preference", confirmed: true });
    w.memory.add({ scope: "chat", chatId: "groupy", text: "Other chat's note.", source: "person", kind: "preference", confirmed: true });
    w.memory.add({ scope: "chat", chatId: "groupx", text: "This chat's note.", source: "person", kind: "preference", confirmed: true });
    await w.dreamer.dream({ kind: "pi" }, WINDOW);
    expect(w.prompts[0]).toContain("This chat's note.");
    expect(w.prompts[0]).not.toContain("Owner's private habit.");
    expect(w.prompts[0]).not.toContain("Other chat's note.");
  });
});

describe("holding a chat's content", () => {
  it("is a figure, a link, a handle or a person's name", () => {
    expect(holdsContent("West had 1,204 signups", [])).toBe(true);
    expect(holdsContent("See https://x.test", [])).toBe(true);
    expect(holdsContent("Ask @ana first", [])).toBe(true);
    expect(holdsContent("Ana likes tables", ["Ana Pop"])).toBe(true);
    expect(holdsContent("Use tables for comparisons", ["Ana Pop"])).toBe(false);
  });
});

/** An entry of a chat's log. */
function entry(id: number, kind: string, data: object): EntryRecord {
  return { id, conversationId: "root", kind, data } as unknown as EntryRecord;
}

async function* pages(entries: EntryRecord[]): AsyncGenerator<readonly EntryRecord[]> {
  yield [...entries].reverse();
}

describe("the lines a chat gives a dream", () => {
  const reply = (id: number, at: number, fields: object = {}) =>
    entry(id, CHAT_AGENT_KIND, { agentId: AGENT, ownerUid: OWNER, name: "research", text: `reply ${id}`, endedAt: at, ...fields });
  const message = (id: number, at: number, uid = MEMBER, name = "Ana") => entry(id, CHAT_MESSAGE_KIND, { uid, name, text: `message ${id}`, sentAt: at });

  it("reads the subject's replies with what is around them, within the window", async () => {
    const log = [message(1, WINDOW.from - 10), reply(2, WINDOW.from - 5), message(3, NOON), reply(4, NOON + 1), message(5, NOON + 2, OWNER, "Radu"), message(6, WINDOW.to + 1)];
    const { items, people } = await dreamLines(pages(log), { subject: AGENT, owner: OWNER, private: false, from: WINDOW.from, to: WINDOW.to });
    expect(items.map((each) => [each.seq, each.who])).toEqual([
      [3, "member"],
      [4, "self"],
      [5, "owner"],
    ]);
    expect(people).toEqual(["Radu", "Ana"]);
  });

  it("marks a reply built on private servers as a fork, in a shared chat and in the owner's private chat", async () => {
    const log = [message(1, NOON, OWNER, "Radu"), reply(2, NOON + 1, { sources: ["calendar"] })];
    const shared = await dreamLines(pages(log), { subject: AGENT, owner: OWNER, private: false, from: WINDOW.from, to: WINDOW.to });
    expect(shared.items.find((each) => each.seq === 2)?.origin).toBe("fork");
    const alone = await dreamLines(pages(log), { subject: AGENT, owner: OWNER, private: true, from: WINDOW.from, to: WINDOW.to });
    expect(alone.items.find((each) => each.seq === 2)?.origin).toBe("fork");
  });

  it("reads another owner's agent of the same id as another agent", async () => {
    const log = [message(1, NOON), reply(2, NOON + 1, { ownerUid: MEMBER })];
    const { items } = await dreamLines(pages(log), { subject: AGENT, owner: OWNER, private: false, from: WINDOW.from, to: WINDOW.to });
    expect(items).toEqual([]);
  });
});

describe("a user's dreams", () => {
  function user(agents: Partial<AgentDefinition>[] = [{ id: AGENT, name: "research", job: "finds numbers", learns: true }]) {
    let now = DUE - 3_600_000;
    const sql = memorySql();
    const kv = memoryKv();
    const memory = new MemoryStore(sql, () => now);
    const signals = new SignalStore(sql, () => now);
    const feed: FeedInput[] = [];
    const resolved: string[] = [];
    const armed: (number | null)[] = [];
    const calls: string[] = [];
    let reply = answer([]);
    const dreams = new UserDreams({
      sql,
      kv,
      memory,
      signals,
      agents: () => agents as AgentDefinition[],
      excerpt: async () => ({ kind: "private", private: true, own: true, people: [], items: PRIVATE.items }),
      overBudget: async () => undefined,
      complete: async (agent) => {
        calls.push(agent?.id ?? "pi");
        return { text: reply, tokens: 10, costUsd: 0.001 };
      },
      spent: () => {},
      unopenedReports: () => [],
      changed: () => {},
      armed: (at) => void armed.push(at),
      addFeed: (input) => void feed.push(input),
      resolveFeed: (ref) => void resolved.push(ref),
      now: () => now,
    });
    return {
      dreams,
      memory,
      signals,
      kv,
      feed,
      resolved,
      armed,
      calls,
      setReply: (text: string) => (reply = text),
      at: (time: number) => (now = time),
      now: () => now,
    };
  }

  it("arms the night at 03:00 in the owner's zone, dreams each subject that learns, then arms the next night", async () => {
    const u = user();
    expect(u.dreams.setSettings({ timeZone: TZ })).toMatchObject({ timeZone: TZ, piLearns: true });
    expect(u.armed.at(-1)).toBe(DUE);
    u.signals.record([signalIn(PRIVATE, { at: NOON }), { ...signalIn(PRIVATE, { at: NOON }), agentId: "pi" }]);
    u.at(DUE + 1000);
    await u.dreams.alarm();
    expect(u.calls).toEqual(["pi", AGENT]);
    expect(u.armed.at(-1)).toBe(DUE + DAY);
    // Fired again (a retry): nothing runs twice.
    await u.dreams.alarm();
    expect(u.calls).toHaveLength(2);
  });

  it("sets no next night after a quiet one, until something happens again", async () => {
    const u = user();
    u.dreams.setSettings({ timeZone: TZ });
    u.at(DUE + 1000);
    await u.dreams.alarm();
    expect(u.calls).toEqual([]);
    expect(u.dreams.due()).toBeNull();
    expect(u.armed.at(-1)).toBeNull();
    u.dreams.arm();
    expect(u.dreams.due()).toBe(DUE + DAY);
  });

  it("never dreams for an agent with learning off, nor for pi when the owner turned it off", async () => {
    const u = user([{ id: AGENT, name: "old", job: "x" }]);
    u.dreams.setSettings({ piLearns: false });
    expect(u.dreams.subjects()).toEqual([]);
    expect(u.armed.at(-1)).toBeNull();
  });

  it("puts notes waiting for a confirm in Needs you, and resolves it once none waits", async () => {
    const u = user();
    u.signals.record([signalIn(PRIVATE, { at: u.now() - 10 })]);
    u.setReply(answer([note({ text: "The target is monthly.", kind: "fact", scope: "wide", cites: ["c0.1"] })]));
    const record = await u.dreams.dreamNow({ kind: "agent", agentId: AGENT });
    if ("error" in record) throw new Error(record.error);
    expect(record.waiting).toHaveLength(1);
    expect(u.feed).toHaveLength(1);
    expect(u.feed[0]).toMatchObject({ kind: "lesson", needsYou: true, open: { to: "agent", agentId: AGENT, tab: "knows" }, aboutAgent: AGENT });
    u.dreams.notesChanged();
    expect(u.resolved).toEqual([]);
    u.memory.change(record.waiting[0], { confirmed: true });
    u.dreams.notesChanged();
    expect(u.resolved).toEqual([u.feed[0].ref]);
  });

  it("lets the owner dream now at most once an hour per subject", async () => {
    const u = user();
    u.signals.record([signalIn(PRIVATE, { at: u.now() - 10 })]);
    expect(await u.dreams.dreamNow({ kind: "agent", agentId: AGENT })).toMatchObject({ status: "dreamt" });
    expect(await u.dreams.dreamNow({ kind: "agent", agentId: AGENT })).toMatchObject({ retryAt: u.now() + DREAM_NOW_MS });
    expect(u.dreams.view().nowAfter[AGENT]).toBe(u.now() + DREAM_NOW_MS);
    expect(await u.dreams.dreamNow({ kind: "agent", agentId: "f".repeat(16) })).toEqual({ error: "No such agent." });
  });

  it("leaves no scripted answer behind after a dream with nothing to learn from", async () => {
    const u = user();
    u.dreams.setSettings({ timeZone: TZ });
    const scripted = answer([note({ text: "Left over.", kind: "preference", scope: "wide", cites: ["c0.1"] })]);
    expect(await u.dreams.dreamNow({ kind: "agent", agentId: AGENT }, scripted)).toMatchObject({ status: "quiet" });
    // The night after a day of work asks the model, not the answer scripted for the quiet dream before it.
    u.signals.record([signalIn(PRIVATE, { at: NOON })]);
    u.at(DUE + 1000);
    await u.dreams.alarm();
    expect(u.calls).toEqual([AGENT]);
    expect(u.memory.list().map((each) => each.text)).not.toContain("Left over.");
  });
});

describe("learning overnight, as an agent's setting", () => {
  const input = { name: "research", job: "finds numbers", instructions: "Look things up." };

  it("is on for a new agent, kept by a change that does not say, and the owner's to turn off", () => {
    const store = new AgentStore(memorySql(), () => DUE);
    const made = store.save(input, "user", true);
    if ("error" in made) throw new Error(made.error);
    expect(made.learns).toBe(true);
    expect(store.save({ ...input, job: "finds more numbers" }, "user", undefined, { id: made.id })).toMatchObject({ learns: true });
    expect(store.save({ ...input, learns: false }, "user", undefined, { id: made.id })).toMatchObject({ learns: false });
    expect(store.save(input, "user", undefined, { id: made.id })).toMatchObject({ learns: false });
  });

  it("stays off for an agent made before it existed, and one imported without it", () => {
    const sql = memorySql();
    const store = new AgentStore(sql, () => DUE);
    const made = store.save(input, "user", true);
    if ("error" in made) throw new Error(made.error);
    // An agent saved before the setting: its definition has no `learns`.
    sql.exec("UPDATE agents SET definition = ? WHERE id = ?", JSON.stringify(input), made.id);
    expect(store.get(made.id)?.learns).toBeUndefined();
    expect(store.save({ ...input, job: "x" }, "user", undefined, { id: made.id })).not.toHaveProperty("learns");
    const imported = store.import({ ...input, name: "other", id: "c".repeat(16), origin: "user", enabled: true } as never);
    expect("id" in imported && store.get(imported.id)?.learns).toBeUndefined();
  });
});
