import type { AgentDefinition } from "../../shared/agents.ts";
import { DREAM_NOW_MS, type DreamRecord, type DreamSettings, type DreamsView, type DreamSubject } from "../../shared/dream.ts";
import type { FeedInput } from "../../shared/feed.ts";
import { waitsForConfirm } from "../../shared/memory.ts";
import { errorMessage, isObject, isTimeZone } from "../../shared/util.ts";
import type { Kv } from "../chat-kind.ts";
import type { Sql } from "../members.ts";
import { Dreamer, DreamStore, nextDreamAt, nightWindow, type DreamAnswer, type DreamHost } from "./dream.ts";
import type { DreamExcerpt } from "./dream-input.ts";
import type { MemoryStore } from "./store.ts";
import type { SignalStore } from "./signals.ts";

const SETTINGS_KEY = "dream.settings";
const DUE_KEY = "dream.due";
const NOW_KEY = "dream.now:";
/** The ref of a dream's item in its owner's feed, for the notes it left waiting for a confirm. */
const LESSON_REF = "lesson:";

/** What the dreams need of the owner's directory, besides the stores. */
export interface UserDreamsDeps extends Pick<DreamHost, "excerpt" | "overBudget" | "spent" | "unopenedReports" | "changed"> {
  sql: Sql;
  kv: Kv;
  memory: MemoryStore;
  signals: SignalStore;
  agents(): readonly AgentDefinition[];
  /** One model answer for the subject (its agent's definition, or null for pi). */
  complete(agent: AgentDefinition | null, system: string, prompt: string): Promise<DreamAnswer | null>;
  /** Set when the nightly dreams are due next (null: none), beside the directory's other alarms. */
  armed(at: number | null): void;
  addFeed(input: FeedInput): void;
  resolveFeed(ref: string): void;
  now?: () => number;
}

/**
 * One user's nightly dreams (shared/dream.ts, worker/memory/dream.ts): pi's, when they let it learn, and each agent of
 * theirs that learns overnight. One alarm for all, at DREAM_AT in the owner's time zone, set again after each night
 * (schedule.ts keeps it DST-safe). Notes a dream leaves waiting for a confirm are one item in the owner's Needs you,
 * resolved once none of them waits.
 */
export class UserDreams {
  readonly store: DreamStore;
  readonly #deps: UserDreamsDeps;
  readonly #dreamer: Dreamer;
  readonly #now: () => number;
  /** The answer the next dream's call gets instead of the model's (DEV_TOOLS only: the e2e suite and screenshots). */
  #scripted: string | undefined;

  constructor(deps: UserDreamsDeps) {
    this.#deps = deps;
    this.#now = deps.now ?? Date.now;
    this.store = new DreamStore(deps.sql);
    this.#dreamer = new Dreamer({
      memory: deps.memory,
      signals: deps.signals,
      dreams: this.store,
      now: this.#now,
      describe: (subject) => {
        const agent = subject.kind === "agent" ? this.#agent(subject.agentId) : null;
        return agent ? { name: `@${agent.name}`, job: agent.job } : { name: "pi, the main assistant of the owner's chats" };
      },
      excerpt: deps.excerpt,
      overBudget: deps.overBudget,
      complete: (subject, system, prompt) => {
        const scripted = this.#scripted;
        this.#scripted = undefined;
        if (scripted !== undefined) return Promise.resolve({ text: scripted, tokens: 0, costUsd: 0 });
        return deps.complete(subject.kind === "agent" ? this.#agent(subject.agentId) : null, system, prompt);
      },
      spent: deps.spent,
      unopenedReports: deps.unopenedReports,
      changed: deps.changed,
    });
  }

  #agent(agentId: string): AgentDefinition | null {
    return this.#deps.agents().find((agent) => agent.id === agentId) ?? null;
  }

  settings(): DreamSettings {
    const kept = this.#deps.kv.get<Partial<DreamSettings>>(SETTINGS_KEY) ?? {};
    return { piLearns: kept.piLearns !== false, timeZone: kept.timeZone && isTimeZone(kept.timeZone) ? kept.timeZone : "UTC" };
  }

  /** Change the settings (each field given); the alarm follows a new time zone. */
  setSettings(input: unknown): DreamSettings | { error: string } {
    if (!isObject(input)) return { error: "Expected {piLearns?, timeZone?}." };
    const next = this.settings();
    if (input.piLearns !== undefined) {
      if (typeof input.piLearns !== "boolean") return { error: "piLearns is true or false." };
      next.piLearns = input.piLearns;
    }
    if (input.timeZone !== undefined) {
      if (!isTimeZone(input.timeZone)) return { error: "timeZone is a time zone, such as Europe/Bucharest." };
      next.timeZone = input.timeZone;
    }
    const moved = next.timeZone !== this.settings().timeZone;
    this.#deps.kv.put(SETTINGS_KEY, next);
    if (moved) this.#deps.kv.delete(DUE_KEY);
    this.arm();
    return next;
  }

  /** The subjects that learn overnight now: pi when let, and each agent with `learns` on. */
  subjects(): DreamSubject[] {
    const agents = this.#deps.agents().filter((agent) => agent.learns === true);
    return [...(this.settings().piLearns ? [{ kind: "pi" as const }] : []), ...agents.map((agent) => ({ kind: "agent" as const, agentId: agent.id }))];
  }

  /** When the nightly dreams are due next; null when nothing learns. */
  due(): number | null {
    return this.subjects().length ? (this.#deps.kv.get<number>(DUE_KEY) ?? null) : null;
  }

  /** Set the next night's alarm when none is set (or nothing learns any more: cleared). */
  arm(): void {
    if (!this.subjects().length) {
      this.#deps.kv.delete(DUE_KEY);
      this.#deps.armed(null);
      return;
    }
    let due = this.#deps.kv.get<number>(DUE_KEY);
    if (due === undefined) {
      due = nextDreamAt(this.settings().timeZone, this.#now());
      this.#deps.kv.put(DUE_KEY, due);
    }
    this.#deps.armed(due);
  }

  /**
   * The alarm: when the night's dreams are due, each subject dreams over the day before (one at a time: one model call
   * at a time per user), then the next night is set. A dream that fails is recorded, never retried in a loop.
   */
  async alarm(): Promise<void> {
    const due = this.#deps.kv.get<number>(DUE_KEY);
    if (due === undefined || due > this.#now()) return this.arm();
    const tz = this.settings().timeZone;
    const window = nightWindow(tz, due);
    // The next night first: a dream cut off by a restart is not run twice tonight (each is idempotent anyway).
    this.#deps.kv.put(DUE_KEY, nextDreamAt(tz, Math.max(due, this.#now())));
    let quiet = true;
    for (const subject of this.subjects()) {
      try {
        const record = await this.#dreamer.dream(subject, window);
        if (record.status !== "quiet") quiet = false;
        this.#ended(subject, record);
      } catch (error) {
        quiet = false;
        console.error("dream:", errorMessage(error));
      }
    }
    // A night with nothing to learn from sets no next one: the next signal does (UserDirectory.recordSignals), so an
    // idle account is not woken every night.
    if (quiet) this.#deps.kv.delete(DUE_KEY);
    if (quiet) this.#deps.armed(null);
    else this.arm();
  }

  /** The owner's "Dream now": one subject's dream over the last day, at most once per DREAM_NOW_MS. */
  async dreamNow(subject: DreamSubject, scripted?: string): Promise<DreamRecord | { error: string; retryAt?: number }> {
    if (subject.kind === "agent" && !this.#agent(subject.agentId)) return { error: "No such agent." };
    const key = subject.kind === "pi" ? "pi" : subject.agentId;
    const now = this.#now();
    const last = this.#deps.kv.get<number>(NOW_KEY + key);
    if (scripted === undefined && last !== undefined && now - last < DREAM_NOW_MS) {
      return { error: "It dreamt a moment ago; try again later.", retryAt: last + DREAM_NOW_MS };
    }
    this.#deps.kv.put(NOW_KEY + key, now);
    this.#scripted = scripted;
    let record: DreamRecord;
    try {
      record = await this.#dreamer.dream(subject, { day: `now:${new Date(now).toISOString().slice(0, 16)}`, from: now - 86_400_000, to: now });
    } finally {
      // A dream that called no model (nothing to learn from) leaves no scripted answer behind for a later one.
      this.#scripted = undefined;
    }
    this.#ended(subject, record);
    return record;
  }

  /** A dream left notes waiting for a confirm: one Needs you item for them, which opens where they are. */
  #ended(subject: DreamSubject, record: DreamRecord): void {
    if (!record.waiting.length) return;
    const agent = subject.kind === "agent" ? this.#agent(subject.agentId) : null;
    const n = record.waiting.length;
    const who = agent ? `@${agent.name}` : "pi";
    this.#deps.addFeed({
      kind: "lesson",
      ref: `${LESSON_REF}${record.subject}:${record.day}`,
      at: record.at,
      title: `${who} learned ${n === 1 ? "something" : `${n} things`} overnight to confirm`,
      ...(record.summary && { text: record.summary }),
      open: agent ? { to: "agent", agentId: agent.id, tab: "knows" } : { to: "memory" },
      needsYou: true,
      ...(agent && { aboutAgent: agent.id }),
    });
  }

  /** The notes changed: a dream's Needs you item whose notes no longer wait (confirmed, edited in or forgotten) is resolved. */
  notesChanged(): void {
    const waiting = new Set(this.#deps.memory.list().filter(waitsForConfirm).map((note) => note.id));
    for (const record of this.store.waiting()) {
      if (!record.waiting.some((id) => waiting.has(id))) this.#deps.resolveFeed(`${LESSON_REF}${record.subject}:${record.day}`);
    }
  }

  /** What the views show. */
  view(): DreamsView {
    const subjects = ["pi", ...this.#deps.agents().map((agent) => agent.id)];
    const now = this.#now();
    const nowAfter: Record<string, number> = {};
    const dreams: Record<string, DreamRecord[]> = {};
    for (const subject of subjects) {
      const list = this.store.list(subject);
      if (list.length) dreams[subject] = list;
      const last = this.#deps.kv.get<number>(NOW_KEY + subject);
      if (last !== undefined && now - last < DREAM_NOW_MS) nowAfter[subject] = last + DREAM_NOW_MS;
    }
    return { settings: this.settings(), nextAt: this.due(), dreams, nowAfter };
  }

  forgetAgent(agentId: string): void {
    this.store.forget(agentId);
    this.#deps.kv.delete(NOW_KEY + agentId);
  }
}

export type { DreamExcerpt, DreamSettings, DreamsView };
