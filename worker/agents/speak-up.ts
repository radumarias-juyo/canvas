// Agents that speak up: the chat object's side of the funnel (worker/agents/funnel.ts). After a pause in the chat, or
// once a question has gone unanswered for a while, it walks the roster's agents through the gates, asks Workers AI for
// the interest of those left, and gives the closest one a turn nobody asked for. The chat object schedules the checks
// and says what it holds (SpeakUpHost); this decides who, if anyone, speaks.

import type { EntryRecord } from "@earendil-works/pi-durable";
import { speakerLabel, type AgentDefinition, type UnpromptedKind } from "../../shared/agents.ts";
import type { ChatAgentSettings } from "../../shared/agent-settings.ts";
import { errorMessage } from "../../shared/util.ts";
import { agentProfile, cosine, followUpAsk, gateRefusal, INTEREST_THRESHOLD, recentText, type Embedder, type GateRefusal } from "./funnel.ts";
import type { ChatRoster, RosterEntry, TurnRequest } from "./roster.ts";

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
  kind: UnpromptedKind;
}

/** What the funnel needs of the chat object. */
export interface SpeakUpHost {
  readonly roster: ChatRoster;
  settings(): ChatAgentSettings;
  /** Whether someone muted the agent in this chat. */
  muted(agentId: string): boolean;
  /** The owner's definition of a roster agent as it is now; null when it is gone. */
  definition(entry: RosterEntry): Promise<AgentDefinition | null>;
  /** Whether the chat's daily token budget has room. */
  budgetLeft(): boolean;
  /** Whether the agent's owner's daily spend has room (RUNS_DAILY_USD). */
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
  /** The asker is the agent's owner: their line is marked so (speakerLabel). */
}

/** The start of the day (UTC) a time falls on. */
function dayStart(at: number): number {
  return Date.parse(`${new Date(at).toISOString().slice(0, 10)}T00:00:00Z`);
}

export class SpeakUp {
  readonly #host: SpeakUpHost;
  readonly #profiles = new Map<string, Promise<number[]>>();

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
  async afterPause(recent: readonly EntryRecord[], last: { line: string; askKey?: string }): Promise<string | undefined> {
    const text = recentText(recent);
    if (!text) return undefined;
    return this.#offer("speak-up", text, (entry) => ({
      calledBy: { name: "the conversation", unprompted: "speak-up" },
      ask: last.line,
      byOwner: false,
      unattended: true,
      ...(last.askKey && { askKey: last.askKey }),
    }));
  }

  /** A question has had no answer for a while: the closest agent past the gates may offer to pick it up. */
  async followUp(ask: OpenAsk): Promise<string | undefined> {
    return this.#offer("follow-up", ask.text, (entry) => ({
      calledBy: { name: ask.name, uid: ask.uid, unprompted: "follow-up" },
      ask: followUpAsk(
        `${speakerLabel({ name: ask.name, kind: "person", owner: ask.uid === entry.ownerUid })}: ${ask.text}`,
        ask.sentAt,
        this.#host.now(),
      ),
      askKey: ask.askKey,
      byOwner: false,
      unattended: true,
    }));
  }

  async #offer(
    kind: UnpromptedKind,
    text: string,
    request: (entry: RosterEntry) => Omit<TurnRequest, "agentId" | "hop">,
  ): Promise<string | undefined> {
    const host = this.#host;
    const embedder = host.embedder;
    if (!this.possible() || !embedder) return undefined;
    const now = host.now();
    const since = dayStart(now);
    // Stage 1, the gates: in code, the cheap ones first, the owner's definition and spend only for those still in.
    const open: { entry: RosterEntry; agent: AgentDefinition }[] = [];
    for (const entry of host.roster.list()) {
      const used = host.roster.unpromptedSince(entry.agentId, since);
      const early = gateRefusal({
        agentAllows: true,
        chatAllows: true,
        muted: host.muted(entry.agentId),
        off: entry.off,
        busy: host.roster.isBusy(entry.agentId),
        postsToday: used.count,
        ...(used.lastAt !== undefined && { lastAt: used.lastAt }),
        now,
        budgetLeft: host.budgetLeft(),
        spendLeft: true,
      });
      if (early) {
        host.observe({ agent: entry.agentId, stage: "gates", passed: false, refusal: early, kind });
        continue;
      }
      const agent = await host.definition(entry).catch(() => null);
      const late = !agent?.enabled ? "off" : !agent.speaksUp ? "agent" : (await host.spendLeft(entry.ownerUid).catch(() => false)) ? null : "spend";
      if (late || !agent) {
        host.observe({ agent: entry.agentId, stage: "gates", passed: false, refusal: late ?? "off", kind });
        continue;
      }
      host.observe({ agent: entry.agentId, stage: "gates", passed: true, kind });
      open.push({ entry, agent });
    }
    if (!open.length) return undefined;
    // Stage 3, interest: the conversation and each agent's profile, embedded; the closest past the threshold.
    let scores: number[];
    try {
      const signal = AbortSignal.timeout(INTEREST_MS);
      const [subject, ...profiles] = await Promise.all([
        embedder.embed([text], signal).then(([vector]) => vector),
        ...open.map(({ agent }) => this.#profile(embedder, agent, signal)),
      ]);
      scores = profiles.map((profile) => cosine(subject, profile));
    } catch (error) {
      console.error("speak up, interest:", errorMessage(error));
      return undefined;
    }
    let best: { entry: RosterEntry; score: number } | undefined;
    open.forEach(({ entry }, i) => {
      const score = scores[i];
      const passed = score >= INTEREST_THRESHOLD;
      host.observe({ agent: entry.agentId, stage: "interest", passed, score, kind });
      if (passed && (!best || score > best.score)) best = { entry, score };
    });
    if (!best) return undefined;
    // Stage 4, the turn: it may still PASS (AgentTurns posts nothing then).
    const chosen: RosterEntry = best.entry;
    host.observe({ agent: chosen.agentId, stage: "turn", passed: true, score: best.score, kind });
    host.give(chosen.agentId, request(chosen));
    return chosen.agentId;
  }

  /** An agent's profile, embedded once per version of its definition. */
  #profile(embedder: Embedder, agent: AgentDefinition, signal: AbortSignal): Promise<number[]> {
    const key = `${agent.id}:${agent.version}`;
    let profile = this.#profiles.get(key);
    if (!profile) {
      profile = embedder.embed([agentProfile(agent)], signal).then(([vector]) => vector);
      this.#profiles.set(key, profile);
      profile.catch(() => this.#profiles.delete(key));
      if (this.#profiles.size > MAX_PROFILES) this.#profiles.delete(this.#profiles.keys().next().value!);
    }
    return profile;
  }
}
