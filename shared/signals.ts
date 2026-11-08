// How people work with an agent, recorded as it happens, cheaply and with no model call: each signal says what happened
// to which agent in which chat (by entry or turn), never what anyone said. They go to the agent's owner's directory
// (the chat's owner for its own agents, the member for theirs in someone else's chat), tagged with the chat and its
// kind, and nothing is recorded in a chat off the record (mayLeave), in code at both ends. The nightly dream reads them
// (worker/memory/signals.ts).

import { mayLeave, type ChatKind } from "./chat-kinds.ts";
import { isReaction } from "./reactions.ts";

/**
 * What happened:
 *   replied          the agent posted a reply (its activity: a day with none has nothing to learn from)
 *   corrected        a person replied to its reply correcting or contradicting it
 *   draft_posted     its owner posted a reply it held for review as it was
 *   draft_edited     its owner edited such a reply before posting it
 *   draft_discarded  its owner discarded it
 *   action_approved  its owner approved an action it queued
 *   action_declined  its owner declined one
 *   offer_taken      its owner said Yes to the next step its reply offered
 *   muted            someone muted it in the chat (it posts nothing unprompted there)
 *   passed           an unprompted turn of its answered PASS: nothing was posted
 *   reaction         someone reacted to its reply (`detail`: the emoji, one of a fixed set)
 *   repeated         someone asked again what it had already answered in the chat
 *   handoff_failed   a turn it handed to another agent failed or stopped
 *   report_unopened  a report of one of its runs that its owner never opened (the dream finds these itself)
 *   page_reedited    a page it published got a new version within minutes: the one before missed what was asked
 * pi's signals are kept as the agent "pi", in the chat's owner's directory.
 */
export const SIGNAL_KINDS = [
  "replied",
  "corrected",
  "draft_posted",
  "draft_edited",
  "draft_discarded",
  "action_approved",
  "action_declined",
  "offer_taken",
  "muted",
  "passed",
  "reaction",
  "repeated",
  "handoff_failed",
  "report_unopened",
  "page_reedited",
] as const;
export type SignalKind = (typeof SIGNAL_KINDS)[number];

/** Who did it: the agent's owner, someone else in the chat, or nobody (the agent itself, a run). */
export type SignalActor = "owner" | "member" | "none";

/** One signal, as a chat sends it and its agent's owner's directory keeps it. */
export interface AgentSignal {
  /** The agent's id, or "pi" (AGENT_NAME) for the chat's own agent. */
  agentId: string;
  chatId: string;
  /** Whose chat it is: the agent's owner's own, or another person's (a member's agent, in its seat). */
  chatOwner: string;
  /** The chat's kind when it happened. */
  chatKind: ChatKind;
  /** Nobody but the chat's owner was in it. */
  alone: boolean;
  signal: SignalKind;
  actor: SignalActor;
  /** The chat's entry it is about (a reply, a message), when known. */
  seq?: number;
  /** The agent's turn it is about, when known. */
  turn?: number;
  /** A reaction's emoji; nothing else. */
  detail?: string;
  at: number;
}

/** How many signals one agent keeps a day at most: past it, the day's newest are dropped (a busy chat cannot fill the store). */
export const MAX_SIGNALS_A_DAY = 500;
/** How long signals are kept: the dream reads one day; a few more for a look back and a missed night. */
export const SIGNAL_DAYS = 14;

/** Whether a signal from a chat of these kinds may be kept: never from one off the record, or of no known kind. */
export function keepsSignals(...kinds: (ChatKind | null | undefined)[]): boolean {
  return mayLeave({ what: "memory", scope: "chat" }, ...kinds);
}

/** `value` as a signal a chat sent, or null: only the fields a signal has, each of its type. */
export function checkSignal(value: unknown): AgentSignal | null {
  if (typeof value !== "object" || value === null) return null;
  const v = value as Record<string, unknown>;
  const str = (key: string) => typeof v[key] === "string" && (v[key] as string).length > 0 && (v[key] as string).length <= 64;
  const int = (key: string) => v[key] === undefined || (typeof v[key] === "number" && Number.isSafeInteger(v[key]) && (v[key] as number) >= 0);
  if (!str("agentId") || !str("chatId") || !str("chatOwner") || !int("seq") || !int("turn")) return null;
  if (!(SIGNAL_KINDS as readonly unknown[]).includes(v.signal) || !["owner", "member", "none"].includes(v.actor as string)) return null;
  if (!["private", "group", "page", "off_record"].includes(v.chatKind as string) || typeof v.alone !== "boolean") return null;
  if (typeof v.at !== "number" || !Number.isFinite(v.at)) return null;
  if (v.detail !== undefined && !(v.signal === "reaction" && isReaction(v.detail))) return null;
  return {
    agentId: v.agentId as string,
    chatId: v.chatId as string,
    chatOwner: v.chatOwner as string,
    chatKind: v.chatKind as ChatKind,
    alone: v.alone,
    signal: v.signal as SignalKind,
    actor: v.actor as SignalActor,
    ...(v.seq !== undefined && { seq: v.seq as number }),
    ...(v.turn !== undefined && { turn: v.turn as number }),
    ...(v.detail !== undefined && { detail: v.detail as string }),
    at: v.at,
  };
}

/**
 * Whether a reply to an agent's message reads as correcting or contradicting it: it opens with a no, or says it is
 * wrong, not what was asked, or "actually". A cheap guess in code, never a model call: a miss only loses a signal.
 */
export function looksLikeCorrection(text: string): boolean {
  const said = text
    .toLowerCase()
    .replace(/@[a-z0-9-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return OPENS_WITH_NO.test(said) || SAYS_WRONG.test(said);
}

const OPENS_WITH_NO = /^(no|nope|nah|wrong|incorrect|not quite|not really|that's not|that is not|thats not)\b/;
const SAYS_WRONG = new RegExp(
  `\\b(${[
    "that'?s wrong|is wrong|are wrong|was wrong|not what i (asked|meant|wanted)|you misunderstood|you missed",
    "incorrect|not correct|isn'?t right|is not right|actually,|i said\\b|i meant\\b|should be\\b|should have been\\b",
  ].join("|")})`,
);

/** Words a question key leaves out: the ones that change nothing of what is asked. */
const FILLER = new Set(
  "the please pls can could you me us is are was were what whats tell again hey and for they them their did does how about".split(" "),
);

/**
 * What a message asks, as a key two askings of the same thing share: its words (three letters or more, not `FILLER`),
 * lowercased, without mentions, deduplicated and sorted. Null for a message too short to be a question worth matching.
 * Only the key is kept, never the text.
 */
export function questionKey(text: string): string | null {
  const words = [
    ...new Set(
      text
        .toLowerCase()
        .replace(/@[a-z0-9-]+/g, " ")
        .split(/[^\p{L}\p{N}]+/u)
        .filter((word) => word.length >= 3 && !FILLER.has(word)),
    ),
  ].sort();
  return words.length >= 3 ? words.join(" ") : null;
}
