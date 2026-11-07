// Agents that speak up: the chat object's side of the funnel (worker/agents/funnel.ts). After a pause in the chat, or
// once a question has gone unanswered for a while, it walks the roster's agents through the gates, asks Workers AI for
// the interest of those left, and gives the closest one a turn nobody asked for. The chat object schedules the checks
// and says what it holds (SpeakUpHost); this decides who, if anyone, speaks.

import type { EntryRecord } from "@earendil-works/pi-durable";
import type { AgentDefinition, UnpromptedKind } from "../../shared/agents.ts";
import { budgetDay, type ChatAgentSettings } from "../../shared/agent-settings.ts";
import { errorMessage } from "../../shared/util.ts";
import {
  agentProfile,
  cosine,
  followUpAsk,
  gateRefusal,
  INTEREST_THRESHOLD,
  lateRefusal,
  recentText,
  type Embedder,
  type GateRefusal,
} from "./funnel.ts";
import type { ChatRoster, RosterEntry, TurnRequest } from "./roster.ts";
import { askOf, MAX_ASK_CHARS } from "./turns.ts";

/** How long the interest stage may take: nobody waits for it, but the object stays awake while it runs. */
const INTEREST_MS = 5_000;
/** Profiles kept embedded, by agent and definition version. */
const MAX_PROFILES = 50;

/** One funnel stage's outcome, for the metrics. */
export interface FunnelEvent {
  agent: string;
  stage: "gates" | "interest" | "turn";
  passed: boolean;
  /** The gate that stopped it, or the interest score. */
  refusal?: GateRefusal;
  score?: number;
}

/** What the funnel needs of the chat object. */
export interface SpeakUpHost {
  readonly roster: ChatRoster;
  settings(): ChatAgentSettings;
  /** The owner's definition of a roster agent as it is now; null when it is gone. */
  definition(entry: RosterEntry): Promise<AgentDefinition | null>;
  /** Whether the chat's daily token budget has room. */
  budgetLeft(): boolean;
  /** Whether an owner's daily spend has room (RUNS_DAILY_USD). */
  spendLeft(ownerUid: string): Promise<boolean>;
  /** The embeddings model (INTEREST_MODEL); undefined: no agent speaks up. */
  readonly embedder: Embedder | undefined;
  /** Give the agent its turn (AgentTurns.call). */
  give(agentId: string, request: Omit<TurnRequest, "agentId" | "hop">): void;
  /** Count a stage (the metrics). */
  observe(event: FunnelEvent): void;
  now(): number;
}

/** A question nobody answered, as a follow-up reads it: its message, who asked, and when. */
export interface OpenAsk {
  text: string;
  name: string;
  uid: string;
  sentAt: number;
  /** Its askKey (messageAskKey), so the turn's catch-up leaves it out. */
  askKey: string;
}

export class SpeakUp {
  readonly #host: SpeakUpHost;
  readonly #profiles = new Map<string, number[]>();

  constructor(host: SpeakUpHost) {
    this.#host = host;
  }

  /** Whether the deployment can tell an agent's interest (INTEREST_MODEL): without it, no agent speaks up anywhere. */
  available(): boolean {
    return this.#host.embedder !== undefined;
  }

  /** Whether any agent could speak up here at all: the chat allows it, the deployment can tell interest, and the roster has agents. */
  possible(): boolean {
    return !!this.#host.settings().speakUp && this.#host.embedder !== undefined && this.#host.roster.hasAny();
  }

  /**
   * The chat went quiet after a conversation (`recent`, the log's newest entries, newest first): the closest agent past
   * the gates may speak up about it. Which agent got a turn; undefined for none.
   */
  afterPause(recent: readonly EntryRecord[], last: { line: string; askKey?: string }): Promise<string | undefined> {
    const text = recentText(recent);
    if (!text) return Promise.resolve(undefined);
    return this.#offer(text, () => ({
      calledBy: { name: "the conversation", unprompted: "speak-up" },
      ask: last.line,
      byOwner: false,
      unattended: true,
      ...(last.askKey && { askKey: last.askKey }),
    }));
  }

  /** A question has had no answer for a while: the closest agent past the gates may offer to pick it up. */
  followUp(ask: OpenAsk): Promise<string | undefined> {
    return this.#offer(ask.text, (entry) => ({
      calledBy: { name: ask.name, uid: ask.uid, unprompted: "follow-up" },
      // Labelled and escaped as any message an agent reads: the asker is marked as its owner when they are.
      ask: followUpAsk(
        askOf({ name: ask.name, kind: "person", owner: ask.uid === entry.ownerUid }, ask.text, MAX_ASK_CHARS),
        ask.sentAt,
        this.#host.now(),
      ),
      askKey: ask.askKey,
      byOwner: false,
      unattended: true,
    }));
  }

  async #offer(text: string, request: (entry: RosterEntry) => Omit<TurnRequest, "agentId" | "hop">): Promise<string | undefined> {
    const host = this.#host;
    const embedder = host.embedder;
    if (!this.possible() || !embedder) return undefined;
    const now = host.now();
    const since = Date.parse(`${budgetDay(now)}T00:00:00Z`);
    const budgetLeft = host.budgetLeft();
    // Stage 1, the gates: the cheap ones in code first; the owner's definition and spend only for those still in, read
    // at once, each owner's spend once.
    const early = host.roster.list().filter((entry) => {
      const used = host.roster.unpromptedSince(entry.agentId, since);
      const refusal = gateRefusal({
        muted: entry.muted,
        off: entry.off,
        busy: host.roster.isBusy(entry.agentId),
        postsToday: used.count,
        ...(used.lastAt !== undefined && { lastAt: used.lastAt }),
        now,
        budgetLeft,
      });
      if (refusal) host.observe({ agent: entry.agentId, stage: "gates", passed: false, refusal });
      return !refusal;
    });
    if (!early.length) return undefined;
    const spends = new Map<string, Promise<boolean>>();
    const spendLeft = (owner: string) => {
      let left = spends.get(owner);
      if (!left) spends.set(owner, (left = host.spendLeft(owner).catch(() => false)));
      return left;
    };
    const read = await Promise.all(
      early.map(async (entry) => {
        const [agent, left] = await Promise.all([host.definition(entry).catch(() => null), spendLeft(entry.ownerUid)]);
        return { entry, agent, refusal: lateRefusal(agent, left) };
      }),
    );
    const open: { entry: RosterEntry; agent: AgentDefinition }[] = [];
    for (const { entry, agent, refusal } of read) {
      host.observe({ agent: entry.agentId, stage: "gates", passed: !refusal, ...(refusal && { refusal }) });
      if (!refusal && agent) open.push({ entry, agent });
    }
    if (!open.length) return undefined;
    // Stage 3, interest: the conversation and the profiles not embedded yet, in one call; the closest past the threshold.
    let scores: number[];
    try {
      const profiles = await this.#embed(
        embedder,
        text,
        open.map(({ agent }) => agent),
      );
      scores = profiles.rest.map((profile) => cosine(profiles.subject, profile));
    } catch (error) {
      console.error("speak up, interest:", errorMessage(error));
      return undefined;
    }
    let best: { entry: RosterEntry; score: number } | undefined;
    open.forEach(({ entry }, i) => {
      const score = scores[i];
      const passed = score >= INTEREST_THRESHOLD;
      host.observe({ agent: entry.agentId, stage: "interest", passed, score });
      if (passed && (!best || score > best.score)) best = { entry, score };
    });
    if (!best) return undefined;
    // Stage 4, the turn: it may still PASS (AgentTurns posts nothing then).
    const chosen: RosterEntry = best.entry;
    host.observe({ agent: chosen.agentId, stage: "turn", passed: true, score: best.score });
    host.give(chosen.agentId, request(chosen));
    return chosen.agentId;
  }

  /** `text` and the agents' profiles embedded, in one call; a profile is embedded once per version of its definition. */
  async #embed(embedder: Embedder, text: string, agents: readonly AgentDefinition[]): Promise<{ subject: number[]; rest: number[][] }> {
    const keyOf = (agent: AgentDefinition) => `${agent.id}:${agent.version}`;
    const missing = agents.filter((agent) => !this.#profiles.has(keyOf(agent)));
    const [subject, ...vectors] = await embedder.embed([text, ...missing.map(agentProfile)], AbortSignal.timeout(INTEREST_MS));
    missing.forEach((agent, i) => {
      this.#profiles.set(keyOf(agent), vectors[i]);
      if (this.#profiles.size > MAX_PROFILES) this.#profiles.delete(this.#profiles.keys().next().value!);
    });
    return { subject, rest: agents.map((agent) => this.#profiles.get(keyOf(agent)) ?? []) };
  }
}
