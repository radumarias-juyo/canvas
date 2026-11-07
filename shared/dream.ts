// The nightly dream: once a night, for each agent that learns overnight and for pi, one model call reads that day's
// signals (shared/signals.ts) and the subject's replies with the messages around them, and saves what is worth
// keeping as memory notes ("learned overnight"). Where each note may go is decided here, in code, from where what it
// cites came from, never from what the model asks: see placeDreamNote.

import type { ChatKind } from "./chat-kinds.ts";
import { checkNoteText, MAX_NOTE_CHARS, type MemoryKind, type MemoryNote, type MemoryScope } from "./memory.ts";
import type { SignalActor, SignalKind } from "./signals.ts";
import { isObject } from "./util.ts";

/** Who dreams: one of the owner's agents, or pi (one dream for the owner's pi, over all their chats). */
export type DreamSubject = { kind: "agent"; agentId: string } | { kind: "pi" };

/** The subject as the dreams' table and the signals key it: the agent's id, or "pi". */
export function subjectKey(subject: DreamSubject): string {
  return subject.kind === "pi" ? "pi" : subject.agentId;
}

/** The local time the dream runs at, in the owner's time zone. */
export const DREAM_AT = "03:00";
/** The most chats one dream reads, the newest active first. */
export const MAX_DREAM_CHATS = 8;
/** The most lines it reads of one chat, and of all of them. */
export const MAX_CHAT_ITEMS = 40;
export const MAX_DREAM_ITEMS = 160;
/** How much of one message a line keeps. */
export const MAX_ITEM_CHARS = 400;
/** The most notes one dream saves, and retires. */
export const MAX_DREAM_NOTES = 8;
export const MAX_DREAM_RETIRES = 10;
/** A note learned overnight that nothing read for this long is retired (forgotten; it can be brought back). */
export const DECAY_DAYS = 30;
/** How often the owner may press "Dream now" for one subject. */
export const DREAM_NOW_MS = 60 * 60_000;
/** Below this confidence a note waits for its owner's confirm, whatever it is. */
export const SURE_ENOUGH = 0.6;

/**
 * Where a line the dream reads came from, which bounds who may read what is learned from it:
 *   private  the owner's own private chat with nobody else in it (also an agent's home conversation, where its runs post)
 *   shared   a chat others are in, as everyone in it sees it
 *   fork     a reply in a chat others are in that its turn built on servers only its owner reads (a turn apart)
 */
export type ItemOrigin = "private" | "shared" | "fork";

/** One line of a chat the dream reads: a message or a reply, by its entry in the chat's log. */
export interface DreamItem {
  seq: number;
  /** The subject itself, the subject's owner, someone else, another agent, or pi (when the subject is an agent). */
  who: "self" | "owner" | "member" | "agent" | "pi";
  name: string;
  text: string;
  at: number;
  origin: ItemOrigin;
}

/** A signal as the dream reads it. */
export type DreamSignal = { signal: SignalKind; actor: SignalActor; seq?: number; detail?: string };

/** What the dream reads of one chat: its lines (oldest first) and its signals, and who is in it. */
export interface DreamChat {
  chatId: string;
  kind: ChatKind;
  /** The owner's own private chat with nobody else in it, now. */
  private: boolean;
  /**
   * One of the owner's own chats. Another person's (where the owner's agent sits as a member's) keeps no notes of the
   * owner's: what is learned there may only be a "how to work" lesson for wider use, waiting for a confirm.
   */
  own: boolean;
  /** The names of the people in it (lessons drawn from a shared chat for wider use may name none of them). */
  people: string[];
  items: DreamItem[];
  signals: DreamSignal[];
}

/** A cite, as the model writes it: "c<chat>.<seq>" for a line, "c<chat>.s<n>" for a signal. */
export const CITE_PATTERN = /^c(\d{1,2})\.(s?)(\d{1,9})$/;

/** A note the model proposes. `scope` "wide": the agent's own notes (pi's: the owner's). */
export interface ProposedNote {
  text: string;
  kind: MemoryKind;
  scope: "chat" | "wide";
  cites: string[];
  why: string;
  confidence: number;
  /** A note of the subject's it updates instead of adding one. */
  replaces?: string;
}

/** What one dream's call answered, checked. */
export interface DreamOutput {
  summary: string;
  notes: ProposedNote[];
  retire: { id: string; why: string }[];
}

const MAX_WHY = 200;
const MAX_SUMMARY = 600;

/** `value` (the model's JSON) as a dream's output: only what checks out, within the caps; null when it is none. */
export function checkDreamOutput(value: unknown): DreamOutput | null {
  if (!isObject(value)) return null;
  const notes = (Array.isArray(value.notes) ? value.notes : []).flatMap((note): ProposedNote[] => {
    if (!isObject(note)) return [];
    const text = checkNoteText(note.text);
    if (typeof text !== "string") return [];
    if (note.kind !== "preference" && note.kind !== "fact") return [];
    if (note.scope !== "chat" && note.scope !== "wide") return [];
    const cites = Array.isArray(note.cites) ? note.cites.filter((cite): cite is string => typeof cite === "string" && CITE_PATTERN.test(cite)).slice(0, 20) : [];
    const confidence = typeof note.confidence === "number" && Number.isFinite(note.confidence) ? Math.min(1, Math.max(0, note.confidence)) : 0;
    const why = typeof note.why === "string" ? note.why.replace(/\s+/g, " ").trim().slice(0, MAX_WHY) : "";
    const replaces = typeof note.replaces === "string" && /^[a-f0-9]{12}$/.test(note.replaces) ? note.replaces : undefined;
    return [{ text, kind: note.kind, scope: note.scope, cites, why, confidence, ...(replaces && { replaces }) }];
  });
  const retire = (Array.isArray(value.retire) ? value.retire : []).flatMap((item): DreamOutput["retire"] =>
    isObject(item) && typeof item.id === "string" && /^[a-f0-9]{12}$/.test(item.id)
      ? [{ id: item.id, why: typeof item.why === "string" ? item.why.slice(0, MAX_WHY) : "" }]
      : [],
  );
  const summary = typeof value.summary === "string" ? value.summary.replace(/\s+/g, " ").trim().slice(0, MAX_SUMMARY) : "";
  return { summary, notes: notes.slice(0, MAX_DREAM_NOTES), retire: retire.slice(0, MAX_DREAM_RETIRES) };
}

/** What a cite resolved to: the chat it is in, where its line came from, and whether its author was the owner. */
export interface Cited {
  chatId: string;
  origin: ItemOrigin;
  /** The owner said or did it, or the subject said it to the owner alone: its words may stand as the owner's wish. */
  byOwner: boolean;
  /** The people of its chat. */
  people: readonly string[];
  /** Its chat is one of the owner's own (DreamChat.own). */
  own: boolean;
}

/** Resolve a cite against the chats the dream read (by index): undefined for one that names nothing it was given. */
export function resolveCite(cite: string, chats: readonly DreamChat[]): Cited | undefined {
  const match = CITE_PATTERN.exec(cite);
  if (!match) return undefined;
  const chat = chats[Number(match[1])];
  if (!chat) return undefined;
  const n = Number(match[3]);
  const base = { chatId: chat.chatId, people: chat.people, own: chat.own };
  if (match[2]) {
    const signal = chat.signals[n];
    if (!signal) return undefined;
    return { ...base, origin: chat.private ? "private" : "shared", byOwner: chat.private || signal.actor === "owner" };
  }
  const item = chat.items.find((each) => each.seq === n);
  if (!item) return undefined;
  return { ...base, origin: item.origin, byOwner: item.who === "owner" || (chat.private && item.who === "self") };
}

/** Where a dream's note goes: its scope (and chat), and whether it waits for its owner's confirm; or why not at all. */
export type DreamPlace = { scope: MemoryScope; chatId?: string; confirmed: boolean; moved?: true } | { error: string };

/** Whether a note drawn from a shared chat for wider use holds that chat's content: figures, links, handles, or a name of its people. */
export function holdsContent(text: string, people: readonly string[]): boolean {
  if (/\d/.test(text) || /https?:|www\.|@[a-z0-9]/i.test(text)) return true;
  const lower = ` ${text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ")} `;
  return people.some((name) =>
    name
      .toLowerCase()
      .split(/[^\p{L}\p{N}]+/u)
      .some((part) => part.length >= 3 && lower.includes(` ${part} `)),
  );
}

/**
 * Where a note the dream proposes goes, from where what it cites came from (strictest wins); the model only proposes.
 * Fail-closed, in this order:
 * - It must cite something it was given: a note that cites nothing it read is not saved.
 * - Anything from a turn apart in a shared chat (a reply built on servers only its owner reads) feeds only the owner's
 *   own notes ("just me"), which members' turns never read.
 * - From the owner's private chats (and an agent's runs, in its home conversation) only: the subject's own notes (an
 *   agent's; pi's are the owner's), or that one chat's.
 * - From one shared chat: that chat's notes only, cited from it alone (none for another person's chat, which keeps no
 *   notes of the owner's). A "how to work" lesson for wider use (`wide`) is
 *   proposed to the subject's own notes but waits for the owner's confirm, and only when it holds none of the chats'
 *   content (holdsContent): else it stays with its chat, or is not saved when it cites several.
 * - A fact always waits for the owner's confirm, and so does a note not sure enough, or one whose words are not all the
 *   owner's (in a chat others are in, their words are not the owner's wish).
 */
export function placeDreamNote(
  subject: DreamSubject,
  note: Pick<ProposedNote, "text" | "kind" | "scope" | "confidence">,
  cited: readonly Cited[],
): DreamPlace {
  if (!cited.length) return { error: "it cites nothing the dream read" };
  const wide: MemoryScope = subject.kind === "pi" ? "user" : "agent";
  const chats = [...new Set(cited.map((each) => each.chatId))];
  // In use at once only for a preference, sure enough, all in the owner's own words.
  const confirmed = note.kind === "preference" && note.confidence >= SURE_ENOUGH && cited.every((each) => each.byOwner);
  const moved = (to: MemoryScope) => ((note.scope === "chat" ? to !== "chat" : to !== wide) ? { moved: true as const } : {});
  if (cited.some((each) => each.origin === "fork")) return { scope: "user", confirmed, ...moved("user") };
  if (cited.every((each) => each.origin === "private")) {
    if (note.scope === "chat" && chats.length === 1) return { scope: "chat", chatId: chats[0], confirmed };
    return { scope: wide, confirmed, ...moved(wide) };
  }
  const people = [...new Set(cited.flatMap((each) => each.people))];
  if (note.scope === "wide" && note.kind === "preference" && !holdsContent(note.text, people)) return { scope: wide, confirmed: false };
  if (chats.length !== 1) return { error: "it mixes chats" };
  if (cited.some((each) => !each.own)) return { error: "another person's chat keeps none of the owner's notes" };
  return { scope: "chat", chatId: chats[0], confirmed, ...moved("chat") };
}

/** Whether a note learned overnight has decayed: in use, not pinned, read by nothing for DECAY_DAYS since it last changed. */
export function decays(note: Pick<MemoryNote, "source" | "pinned" | "uses" | "updatedAt" | "forgottenAt" | "confirmed">, now: number): boolean {
  return note.source === "overnight" && note.forgottenAt === undefined && note.confirmed && !note.pinned && note.uses === 0 && now - note.updatedAt >= DECAY_DAYS * 86_400_000;
}

/** Why a dream did what it did, as its record keeps it. */
export type DreamStatus = "dreamt" | "quiet" | "skipped" | "failed";

/** One dream, as the subject's Knows tab (pi's: Memory) shows it. */
export interface DreamRecord {
  subject: string;
  /** The local day it looked back on ("2026-11-07"), or "now:<time>" for a Dream now. */
  day: string;
  status: DreamStatus;
  /** Why it was quiet, skipped or failed. */
  reason?: string;
  at: number;
  /** What it said it learned, in a sentence or two. */
  summary?: string;
  learned: string[];
  retired: string[];
  waiting: string[];
  costUsd: number;
  tokens: number;
}

/** A note's "why", as a dream writes it: in words, and what it cites (by chat and entry, or signal). */
export interface NoteWhy {
  text: string;
  cites: { chatId: string; seq?: number; signal?: SignalKind }[];
  /** The day of the dream that wrote it. */
  day?: string;
}

/** `value` as a note's why, or undefined. */
export function checkNoteWhy(value: unknown): NoteWhy | undefined {
  if (!isObject(value) || typeof value.text !== "string" || !Array.isArray(value.cites)) return undefined;
  const cites = value.cites.flatMap((cite): NoteWhy["cites"] =>
    isObject(cite) && typeof cite.chatId === "string"
      ? [
          {
            chatId: cite.chatId,
            ...(typeof cite.seq === "number" && { seq: cite.seq }),
            ...(typeof cite.signal === "string" && { signal: cite.signal as SignalKind }),
          },
        ]
      : [],
  );
  return { text: value.text.slice(0, MAX_NOTE_CHARS), cites: cites.slice(0, 20), ...(typeof value.day === "string" && { day: value.day.slice(0, 40) }) };
}
