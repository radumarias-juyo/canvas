import type { EntryRecord } from "@earendil-works/pi-durable";
import { CHAT_AGENT_KIND, type ChatAgentReplyData } from "../../shared/agents.ts";
import { textOf } from "../../shared/canonical.ts";
import type { ChatKind } from "../../shared/chat-kinds.ts";
import { MAX_CHAT_ITEMS, MAX_ITEM_CHARS, type DreamItem } from "../../shared/dream.ts";
import { AGENT_NAME } from "../../shared/mentions.ts";
import { CHAT_MESSAGE_KIND, type ChatMessageData } from "../../shared/protocol.ts";

/** What a chat gives a dream of itself (ChatAgent.dreamLines): its kind, whether it is the owner's alone, its lines. */
export type DreamExcerpt = { off: true } | { kind: ChatKind; private: boolean; own: boolean; people: string[]; items: DreamItem[] };

/** Whose lines to read, and from when to when. */
export interface ExcerptQuery {
  /** The agent's id, or "pi". */
  subject: string;
  /** Whose agent (or pi) it is: their messages are the owner's. */
  owner: string;
  /** The chat is the owner's own private chat with nobody else in it: everything in it is said to the owner alone. */
  private: boolean;
  from: number;
  to: number;
}

/** How many lines before (older) and after (newer) each of the subject's replies the dream reads. */
const BEFORE = 3;
const AFTER = 2;
/** The most log pages a chat reads for one dream. */
export const MAX_DREAM_PAGES = 10;

/** When an entry was written, as its own data says it; undefined for one that does not (a bookkeeping entry). */
function timeOf(entry: EntryRecord): number | undefined {
  if (entry.kind === CHAT_MESSAGE_KIND) return (entry.data as Partial<ChatMessageData> | undefined)?.sentAt;
  if (entry.kind === CHAT_AGENT_KIND) return (entry.data as Partial<ChatAgentReplyData> | undefined)?.endedAt;
  const message = entry.model?.[0];
  if (entry.kind === "pi.assistant" && message?.role === "assistant") return message.timestamp;
  return undefined;
}

function short(text: string): string {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length <= MAX_ITEM_CHARS ? line : `${line.slice(0, MAX_ITEM_CHARS)}…`;
}

/**
 * One entry as a line the dream reads: a person's message, an agent's reply, or pi's answer, as everyone in the chat
 * sees it in its log. Nothing else: no tool calls or results, no turn apart (only its posted reply is in the log), and
 * nothing held for review (it never reached the log). A reply of the subject's that its turn built on servers only its
 * owner reads (`sources`) is `fork`, also in the owner's private chat: an agent's notes are read in chats others are in.
 */
function lineOf(entry: EntryRecord, query: ExcerptQuery): Omit<DreamItem, "at"> | null {
  const origin = query.private ? "private" : "shared";
  const seq = entry.id as number;
  if (entry.kind === CHAT_MESSAGE_KIND) {
    const data = entry.data as Partial<ChatMessageData> | undefined;
    if (!data?.text?.trim()) return null;
    return { seq, who: data.uid === query.owner ? "owner" : "member", name: data.name ?? "someone", text: short(data.text), origin };
  }
  if (entry.kind === CHAT_AGENT_KIND) {
    const data = entry.data as Partial<ChatAgentReplyData> | undefined;
    if (!data?.text?.trim()) return null;
    const self = data.agentId === query.subject && data.ownerUid === query.owner;
    return {
      seq,
      who: self ? "self" : "agent",
      name: data.name ?? "agent",
      text: short(data.text),
      origin: self && data.sources?.length ? "fork" : origin,
    };
  }
  const message = entry.model?.[0];
  if (entry.kind === "pi.assistant" && message?.role === "assistant") {
    const text = textOf(message.content.filter(Boolean), " ");
    if (!text.trim()) return null;
    return { seq, who: query.subject === AGENT_NAME ? "self" : "pi", name: AGENT_NAME, text: short(text), origin };
  }
  return null;
}

/**
 * The lines a dream reads of one chat, from its log read newest first (`pages`): within [from, to), each of the
 * subject's replies with the few lines around it, the newest first up to MAX_CHAT_ITEMS; returned oldest first, with
 * the names of the people who wrote in it then.
 */
export async function dreamLines(pages: AsyncIterable<readonly EntryRecord[]>, query: ExcerptQuery): Promise<{ items: DreamItem[]; people: string[] }> {
  const lines: DreamItem[] = [];
  let read = 0;
  scan: for await (const page of pages) {
    if (++read > MAX_DREAM_PAGES) break;
    for (const entry of page) {
      const at = timeOf(entry);
      if (at === undefined || at >= query.to) continue;
      if (at < query.from) break scan;
      const line = lineOf(entry, query);
      if (line) lines.push({ ...line, at });
    }
  }
  // Newest first: the subject's replies, each with what came just before it (older, later in the list) and after.
  const keep = new Set<number>();
  for (let i = 0; i < lines.length && keep.size < MAX_CHAT_ITEMS; i++) {
    if (lines[i].who !== "self") continue;
    for (let j = Math.max(0, i - AFTER); j <= Math.min(lines.length - 1, i + BEFORE) && keep.size < MAX_CHAT_ITEMS; j++) keep.add(j);
  }
  const items = [...keep].sort((a, b) => b - a).map((i) => lines[i]);
  const people = [...new Set(lines.filter((line) => line.who === "owner" || line.who === "member").map((line) => line.name))];
  return { items, people };
}
