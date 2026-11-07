import type { ChatAgentReplyData } from "../../shared/agents.ts";
import type { ChatKind } from "../../shared/chat-kinds.ts";
import { AGENT_NAME } from "../../shared/mentions.ts";
import { keepsSignals, looksLikeCorrection, questionKey, type AgentSignal, type SignalActor, type SignalKind } from "../../shared/signals.ts";
import { errorMessage } from "../../shared/util.ts";
import type { Kv } from "../chat-kind.ts";

/** What a chat reaches of a user's directory to keep their agents' signals (UserDirectory.recordSignals, by RPC). */
export interface SignalsDirectory {
  recordSignals(signals: AgentSignal[]): unknown;
}

/** What ChatSignals needs of the chat object it runs in. */
export interface ChatSignalsDeps {
  chatId: string;
  /** Whose chat it is. */
  chatOwner: string;
  kind(): ChatKind;
  /** Nobody but the chat's owner is in it. */
  alone(): boolean;
  /** The owner of a roster agent; undefined for none (one no longer here). pi's is the chat's owner. */
  ownerOf(agentId: string): string | undefined;
  directory(uid: string): SignalsDirectory;
  kv: Kv;
  waitUntil(promise: Promise<unknown>): void;
  now?: () => number;
}

/** Where the chat keeps which agent answered each question last (questionKey → who, when), for `repeated`. */
const ANSWERED_KEY = "signals.answered";
/** Where it keeps the last question each person asked, until an agent answers it. */
const ASKED_KEY = "signals.asked";
/** How many questions it keeps: the oldest go. */
const MAX_KEPT = 200;
/** How far back an answer counts for `repeated`. */
const REPEAT_MS = 14 * 86_400_000;
/** Where it keeps the version pi last published of each page, and when, for `page_reedited`. */
const PUBLISHED_KEY = "signals.published";
/** A page pi publishes again this soon after its last version was re-edited at once: that version missed. */
export const REEDIT_MS = 10 * 60_000;

type Answered = Record<string, { agentId: string; at: number }>;
/** The question each person last asked, and whether it called pi (pi has no turns: its answer takes the newest such). */
type Asked = Record<string, { key: string; at: number; pi?: true }>;
type Published = Record<string, { version: number; at: number }>;

/**
 * The signals of one chat's agents (shared/signals.ts): the chat object tells it what happened, it works out which
 * agent and whose, and sends each one to that agent's owner's directory, off the caller's path. Nothing in a chat off
 * the record, whatever it is told: checked here, and again by the directory that keeps them.
 */
export class ChatSignals {
  readonly #deps: ChatSignalsDeps;
  readonly #now: () => number;

  constructor(deps: ChatSignalsDeps) {
    this.#deps = deps;
    this.#now = deps.now ?? Date.now;
  }

  /** Record `signal` about `agentId`, done by `by` (a uid; undefined for nobody). Never throws. */
  #record(agentId: string | undefined, signal: SignalKind, by: string | undefined, extra: Pick<AgentSignal, "seq" | "turn" | "detail"> = {}): void {
    if (!agentId) return;
    try {
      const kind = this.#deps.kind();
      if (!keepsSignals(kind)) return;
      const owner = agentId === AGENT_NAME ? this.#deps.chatOwner : this.#deps.ownerOf(agentId);
      if (!owner) return;
      const actor: SignalActor = by === undefined ? "none" : by === owner ? "owner" : "member";
      const sent: AgentSignal = {
        agentId,
        chatId: this.#deps.chatId,
        chatOwner: this.#deps.chatOwner,
        chatKind: kind,
        alone: this.#deps.alone(),
        signal,
        actor,
        ...(extra.seq !== undefined && { seq: extra.seq }),
        ...(extra.turn !== undefined && { turn: extra.turn }),
        ...(extra.detail !== undefined && { detail: extra.detail }),
        at: this.#now(),
      };
      this.#deps.waitUntil(
        Promise.resolve()
          .then(() => this.#deps.directory(owner).recordSignals([sent]))
          .catch((error: unknown) => console.error("agent signals:", errorMessage(error))),
      );
    } catch (error) {
      console.error("agent signals:", errorMessage(error));
    }
  }

  /**
   * A person's message (entry `seq`, when known): one replying to an agent's reply (`repliesTo`, that agent) that
   * corrects it is `corrected`; one asking again what an agent already answered here is `repeated`. Remembered as the
   * question its author asked, for the agent that answers it next (`replied`), or pi when it calls pi (`callsPi`). Only
   * a key of its words is kept.
   */
  message(uid: string, text: string, repliesTo: string | undefined, seq?: number, callsPi = false): void {
    if (!keepsSignals(this.#deps.kind())) return;
    if (repliesTo && looksLikeCorrection(text)) this.#record(repliesTo, "corrected", uid, seq === undefined ? {} : { seq });
    const key = questionKey(text);
    if (!key) return;
    const now = this.#now();
    const answered = this.#deps.kv.get<Answered>(ANSWERED_KEY)?.[key];
    if (answered && now - answered.at <= REPEAT_MS) this.#record(answered.agentId, "repeated", uid, seq === undefined ? {} : { seq });
    this.#deps.kv.put(ASKED_KEY, kept({ ...this.#deps.kv.get<Asked>(ASKED_KEY), [uid]: { key, at: now, ...(callsPi && { pi: true as const }) } }));
  }

  /** An agent's reply was posted: its activity, and the answer to the question of the person who called it. */
  replied(reply: Pick<ChatAgentReplyData, "agentId" | "turn" | "calledBy" | "failed">): void {
    this.#record(reply.agentId, "replied", undefined, { turn: reply.turn });
    const uid = reply.calledBy.uid;
    if (!uid || reply.failed || !keepsSignals(this.#deps.kind())) return;
    this.#answered(reply.agentId, (asked) => (asked[uid] ? uid : undefined));
  }

  /** pi answered (its run ended): its activity, and the answer to the newest question that called it. */
  piReplied(): void {
    this.#record(AGENT_NAME, "replied", undefined);
    if (!keepsSignals(this.#deps.kind())) return;
    this.#answered(AGENT_NAME, (asked) =>
      Object.entries(asked)
        .filter(([, question]) => question.pi)
        .sort((a, b) => b[1].at - a[1].at)[0]?.[0],
    );
  }

  /** `agentId` answered the question of the person `whose` picks among those asked: it is the one a repeat counts for. */
  #answered(agentId: string, whose: (asked: Asked) => string | undefined): void {
    const asked = this.#deps.kv.get<Asked>(ASKED_KEY) ?? {};
    const uid = whose(asked);
    const question = uid === undefined ? undefined : asked[uid];
    if (!question) return;
    delete asked[uid!];
    this.#deps.kv.put(ASKED_KEY, asked);
    this.#deps.kv.put(ANSWERED_KEY, kept({ ...this.#deps.kv.get<Answered>(ANSWERED_KEY), [question.key]: { agentId, at: this.#now() } }));
  }

  /**
   * pi published version `version` of a page here: when it published the one before only REEDIT_MS ago, that one was
   * re-edited at once (`page_reedited`), a sign it missed what was asked.
   */
  published(artifactId: string, version: number): void {
    if (!keepsSignals(this.#deps.kind())) return;
    const now = this.#now();
    const pages = this.#deps.kv.get<Published>(PUBLISHED_KEY) ?? {};
    const last = pages[artifactId];
    if (last && last.version < version && now - last.at <= REEDIT_MS) this.#record(AGENT_NAME, "page_reedited", undefined);
    this.#deps.kv.put(PUBLISHED_KEY, kept({ ...pages, [artifactId]: { version, at: now } }));
  }

  /**
   * An agent's turn ended: one nobody asked for that passed is `passed`; one handed to it by another agent that failed
   * is that agent's `handoff_failed`.
   */
  turnEnded(turn: { id: number; agentId: string; calledBy: ChatAgentReplyData["calledBy"] }, status: "done" | "failed" | "passed"): void {
    if (status === "passed") this.#record(turn.agentId, "passed", undefined, { turn: turn.id });
    if (status === "failed" && turn.calledBy.agentId) this.#record(turn.calledBy.agentId, "handoff_failed", undefined, { turn: turn.id });
  }

  /** `uid` posted a reply an agent held for their review, edited or not, or discarded it. */
  draft(uid: string, agentId: string, turn: number, action: "posted" | "edited" | "discarded"): void {
    this.#record(agentId, action === "posted" ? "draft_posted" : action === "edited" ? "draft_edited" : "draft_discarded", uid, { turn });
  }

  /** `uid` approved or declined an action an agent queued. */
  action(uid: string, agentId: string, decision: "approve" | "decline"): void {
    this.#record(agentId, decision === "approve" ? "action_approved" : "action_declined", uid);
  }

  /** `uid` said Yes to the next step an agent's reply (entry `seq`) offered. */
  offerTaken(uid: string, agentId: string, seq: number): void {
    this.#record(agentId, "offer_taken", uid, { seq });
  }

  /** `uid` muted an agent here. */
  muted(uid: string, agentId: string): void {
    this.#record(agentId, "muted", uid);
  }

  /** The chat went off the record: what it kept of questions goes. */
  forget(): void {
    this.#deps.kv.delete(ASKED_KEY);
    this.#deps.kv.delete(ANSWERED_KEY);
    this.#deps.kv.delete(PUBLISHED_KEY);
  }

  /** `uid` reacted to an agent's reply (entry `seq`) with `emoji`. */
  reacted(uid: string, agentId: string, seq: number, emoji: string): void {
    this.#record(agentId, "reaction", uid, { seq, detail: emoji });
  }
}

/** The MAX_KEPT newest of `map`'s entries (by `at`). */
function kept<T extends { at: number }>(map: Record<string, T>): Record<string, T> {
  const entries = Object.entries(map);
  if (entries.length <= MAX_KEPT) return map;
  return Object.fromEntries(entries.sort((a, b) => b[1].at - a[1].at).slice(0, MAX_KEPT));
}
