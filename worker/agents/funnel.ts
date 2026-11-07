// The funnel an agent's unprompted post goes through, cheapest stage first, so most never reach a model:
//   1. gates, in code: its owner lets it speak up (AgentDefinition.speaksUp), the chat's owner lets agents speak up
//      there (ChatAgentSettings.speakUp), nobody muted it in this chat, it is on and not working, it has posts left
//      today and its last one was a while ago, and the chat's and its owner's budgets have room;
//   2. a pause: nothing was said in the chat for PAUSE_MS, and nobody is working;
//   3. interest: embeddings on Workers AI of the recent messages (or the unanswered question) and of the agent's job are
//      close enough (INTEREST_THRESHOLD);
//   4. a turn, read-only, as any turn nobody asked for, whose answer may be PASS: then nothing is posted.
// A follow-up is the same funnel for a question nobody answered within FOLLOW_UP_AFTER_MS: the agent may offer to pick
// it up. Every stage is counted in the metrics.

import type { EntryRecord } from "@earendil-works/pi-durable";
import { CHAT_AGENT_KIND, type UnpromptedKind } from "../../shared/agents.ts";
import { CHAT_MESSAGE_KIND, type ChatMessageData } from "../../shared/protocol.ts";
import { clip } from "../../shared/util.ts";
import type { ModelRunner } from "../agent/workers-ai.ts";

/** How long a conversation stays quiet before an agent may speak up in it. */
export const PAUSE_MS = 2 * 60_000;
/** How long a question waits for an answer before an agent may offer to pick it up. */
export const FOLLOW_UP_AFTER_MS = 3 * 60 * 60_000;
/** Unprompted posts one agent makes in one chat a day (UTC), follow-ups included. */
export const MAX_UNPROMPTED_PER_DAY = 3;
/** The shortest time between two of one agent's unprompted turns in a chat. */
export const UNPROMPTED_COOLDOWN_MS = 30 * 60_000;
/** How close (cosine) the recent messages and an agent's job must be. */
export const INTEREST_THRESHOLD = 0.55;
/** What an agent answers to post nothing. */
export const PASS = "PASS";
/** How much of the conversation the interest stage reads, and how many messages of it. */
const MAX_RECENT_CHARS = 2_000;
const MAX_RECENT_MESSAGES = 8;
/** How much of an agent's instructions its profile takes after its job line. */
const MAX_PROFILE_INSTRUCTIONS = 600;

/** What the gates read of one agent in one chat. */
export interface GateState {
  /** Its owner lets it speak up. */
  agentAllows: boolean;
  /** The chat's owner lets agents speak up here. */
  chatAllows: boolean;
  /** Someone in the chat muted it here. */
  muted: boolean;
  /** Its owner turned it off. */
  off: boolean;
  /** It has a turn waiting or running. */
  busy: boolean;
  /** Its unprompted turns in this chat today, and when the last one was. */
  postsToday: number;
  lastAt?: number;
  now: number;
  /** The chat's daily token budget has room. */
  budgetLeft: boolean;
  /** Its owner's daily spend has room. */
  spendLeft: boolean;
}

/** The gate that stopped an agent, for the metrics. */
export type GateRefusal = "agent" | "chat" | "muted" | "off" | "busy" | "daily" | "cooldown" | "budget" | "spend";

/** The first gate that stops the agent, cheapest first; null when it may go on to the next stage. */
export function gateRefusal(state: GateState): GateRefusal | null {
  if (!state.chatAllows) return "chat";
  if (!state.agentAllows) return "agent";
  if (state.off) return "off";
  if (state.muted) return "muted";
  if (state.busy) return "busy";
  if (state.postsToday >= MAX_UNPROMPTED_PER_DAY) return "daily";
  if (state.lastAt !== undefined && state.now - state.lastAt < UNPROMPTED_COOLDOWN_MS) return "cooldown";
  if (!state.budgetLeft) return "budget";
  if (!state.spendLeft) return "spend";
  return null;
}

/** Cosine similarity of two vectors of one length; 0 for an empty or zero one. */
export function cosine(a: readonly number[], b: readonly number[]): number {
  if (!a.length || a.length !== b.length) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}

/** Whether an agent's answer is PASS: nothing to post. Punctuation, emphasis and case around it do not matter. */
export function isPass(text: string): boolean {
  return /^[\s*_`"'.!>-]*pass[\s*_`"'.!]*$/i.test(text);
}

/** Words that open a request or a question, in English: "can you", "who has", "please send". */
const ASKING =
  /^(?:can|could|would|will|does|do|did|is|are|was|has|have|who|what|when|where|which|why|how|please|pls|send|pull|get|find|show|give|list|share|check)\b/i;

/** Whether a message reads as a question or a request someone could answer: one with a question mark, or opened by an asking word. */
export function looksLikeAsk(text: string): boolean {
  const said = text.trim();
  if (!/\p{L}{2}/u.test(said)) return false;
  return said.includes("?") || ASKING.test(said);
}

/**
 * What an agent's profile is to the interest stage: its job line, and the start of its instructions, which say more of
 * what it does.
 */
export function agentProfile(agent: { name: string; job: string; instructions: string }): string {
  return `${agent.name}: ${agent.job}\n${clip(agent.instructions, MAX_PROFILE_INSTRUCTIONS)}`;
}

/**
 * The end of the conversation as the interest stage reads it, from the log's entries newest first: the people's
 * messages and the agents' replies, oldest first, within MAX_RECENT_CHARS.
 */
export function recentText(entries: readonly EntryRecord[]): string {
  const lines: string[] = [];
  let chars = 0;
  for (const entry of entries) {
    const line = lineOf(entry);
    if (!line) continue;
    if (lines.length >= MAX_RECENT_MESSAGES || chars + line.length > MAX_RECENT_CHARS) break;
    lines.push(line);
    chars += line.length;
  }
  return lines.reverse().join("\n");
}

function lineOf(entry: EntryRecord): string | undefined {
  if (entry.kind === CHAT_MESSAGE_KIND) {
    const data = entry.data as unknown as Partial<ChatMessageData>;
    return data.text?.trim() ? clip(data.text.trim(), 600) : undefined;
  }
  if (entry.kind === CHAT_AGENT_KIND) {
    const text = (entry.data as unknown as { text?: string }).text?.trim();
    return text ? clip(text, 600) : undefined;
  }
  const message = entry.model?.[0];
  if (entry.kind === "pi.assistant" && message?.role === "assistant") {
    const text = message.content
      .flatMap((block) => (block?.type === "text" ? [block.text] : []))
      .join("")
      .trim();
    return text ? clip(text, 600) : undefined;
  }
  return undefined;
}

/**
 * Whether a question was answered: the log's entries after it (any order) hold a message from someone other than its
 * asker, or a reply from pi or another agent.
 */
export function answered(after: readonly EntryRecord[], askerUid: string): boolean {
  return after.some((entry) => {
    if (entry.kind === CHAT_MESSAGE_KIND) return (entry.data as unknown as Partial<ChatMessageData>).uid !== askerUid;
    if (entry.kind === CHAT_AGENT_KIND) return !!(entry.data as unknown as { text?: string }).text;
    return entry.kind === "pi.assistant";
  });
}

/** A follow-up's ask: the question's labelled line, and when it was asked. */
export function followUpAsk(line: string, sentAt: number, now: number): string {
  return `${line}\n(asked ${agoText(now - sentAt)})`;
}

/** A time span as the follow-up's input says it: "3 hours ago", "yesterday", "2 days ago". */
export function agoText(ms: number): string {
  const hours = Math.round(ms / 3_600_000);
  if (hours < 1) return `${Math.max(1, Math.round(ms / 60_000))} minutes ago`;
  if (hours < 20) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  const days = Math.round(hours / 24);
  return days <= 1 ? "yesterday" : `${days} days ago`;
}

/**
 * The input that gives an agent an unprompted turn: what it may say, and that PASS posts nothing. `ask` is the labelled
 * line it is about (for a follow-up, with when it was asked: followUpAsk).
 */
export function unpromptedInput(kind: UnpromptedKind, ask: string): string {
  if (kind === "follow-up") {
    return (
      `Nobody called you. This question in the chat has had no answer:\n\n${ask}\n\n` +
      "If it is within your job and you could pick it up, offer to, in one or two short lines that name who asked and when " +
      '(for example: "Ana asked yesterday for the campaign list and nobody has answered. Want me to pull it?"). Do not do the work yet: ' +
      `someone says yes first. If it is not yours to pick up, or someone already did, answer exactly ${PASS}.`
    );
  }
  return (
    "Nobody called you. The chat went quiet after a conversation close to your job; its newest message:\n\n" +
    `${ask}\n\n` +
    "Post only if you can add something useful nobody has said yet: a fact from your tools, a correction, a next step. Keep it to a few lines. " +
    `If you have nothing worth adding, answer exactly ${PASS}: most of the time that is the right answer.`
  );
}

/** What embeds texts for the interest stage: the AI binding, with the deployment's model (INTEREST_MODEL). */
export interface Embedder {
  id: string;
  embed(texts: readonly string[], signal: AbortSignal): Promise<number[][]>;
}

/** The embeddings model the deployment names on Workers AI (`@cf/baai/bge-m3`), through the AI binding; undefined for none. */
export function embedder(ai: ModelRunner, model: string): Embedder | undefined {
  const id = model.trim();
  if (!id) return undefined;
  return {
    id,
    async embed(texts, signal) {
      const answer = (await ai.run(id, { text: [...texts] }, { signal })) as { data?: unknown };
      const data = answer?.data;
      if (!Array.isArray(data) || data.length !== texts.length || data.some((vector) => !Array.isArray(vector)))
        throw new Error(`${id} answered with no embeddings for ${texts.length} texts`);
      return data as number[][];
    },
  };
}
