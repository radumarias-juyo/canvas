// When agents run on their own: the schedules and watches of the agents whose home conversation this chat object is,
// and the ways a run starts (its alarm, a watch whose condition holds, Test it, a sign-in that came, a restart). The
// runs themselves are the executor's (executor.ts).

import { canonicalJson } from "../../../shared/canonical.ts";
import type { Value } from "../../../shared/conditions.ts";
import type { AgentDefinition, LookStep } from "../../../shared/agents.ts";
import { errorMessage, sha256Hex } from "../../../shared/util.ts";
import { resultName, RunExecutor, watchFires, type RunEnd, type RunHost } from "./executor.ts";
import { nextRunAt } from "./schedule.ts";
import type { Sql } from "../../members.ts";

/** What a run's alarm carries. */
export type RunAlarm = { agentId: string; dueAt: number };
/** What a watch's interval carries. */
export type WatchAlarm = { agentId: string };

/** The longest a watch's last value is kept, as JSON: a larger one is compared by a hash of it. */
const MAX_KEPT_VALUE = 100_000;

/** What the runner needs besides the executor's host: alarms, the owner's definitions, and shared watches. */
export interface RunnerHost extends RunHost {
  /** A one-shot alarm (the chat object's Scheduler): its schedule id. */
  alarmAt(at: number, payload: RunAlarm): Promise<string>;
  /** An alarm every `seconds`: its schedule id. */
  alarmEvery(seconds: number, payload: WatchAlarm): Promise<string>;
  cancelAlarm(id: string): Promise<void>;
  /** The owner's definition of an agent as it is now; null when it is gone. */
  definition(agentId: string): Promise<AgentDefinition | null>;
  /**
   * Whether a watch's read can be shared with everyone watching the same call (a server whose results all viewers
   * share, and that does not sign in each user): it then goes through a Source object, which polls once for all.
   */
  sharedWatch(step: LookStep): boolean;
  subscribe(agentId: string, step: LookStep, everyMinutes: number): Promise<void>;
  unsubscribe(agentId: string, step: LookStep): Promise<void>;
  /** Keep the object alive for work that outlives the call that started it. */
  waitUntil(promise: Promise<unknown>): void;
}

type ScheduleRow = { agent_id: string; kind: string; key: string; schedule_id: string | null; due_at: number | null };

/** How a trigger is set, as a key: a definition saved with the same trigger keeps its alarm. */
function triggerKey(agent: AgentDefinition): string {
  const trigger = agent.trigger!;
  return trigger.kind === "schedule" ? canonicalJson(trigger) : canonicalJson({ step: trigger.step, everyMinutes: trigger.everyMinutes });
}

const HASHED = "sha256:";

/** A value as it is compared with the last one: its canonical JSON, or a hash of a large one. */
async function fingerprint(value: Value): Promise<string> {
  const json = canonicalJson(value);
  return json.length <= MAX_KEPT_VALUE ? json : `${HASHED}${await sha256Hex(json)}`;
}

/**
 * The schedules and watches of one chat object's agents, in its SQLite (`agent_schedules`, `agent_watch_last`), and
 * the entry points that start runs. A schedule is a one-shot alarm at the next local time (schedule.ts), set again as
 * each run starts; a watch is an alarm on an interval, or a Source shared with everyone watching the same read, and
 * starts a run only when its value moved and its condition holds.
 */
export class AgentRunner {
  readonly executor: RunExecutor;
  readonly #host: RunnerHost;
  readonly #sql: Sql;
  /** Applying a definition and an alarm's run are one at a time per agent: a stale alarm never runs over a new one. */
  #applying: Promise<unknown> = Promise.resolve();

  constructor(host: RunnerHost, sql: Sql) {
    this.#host = host;
    this.#sql = sql;
    this.executor = new RunExecutor(host);
    sql.exec(`
      CREATE TABLE IF NOT EXISTS agent_schedules (
        agent_id TEXT PRIMARY KEY, kind TEXT NOT NULL, key TEXT NOT NULL, schedule_id TEXT, due_at INTEGER
      );
      CREATE TABLE IF NOT EXISTS agent_watch_last (agent_id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, at INTEGER NOT NULL);
    `);
  }

  #one<T>(work: () => Promise<T>): Promise<T> {
    const next = this.#applying.then(work);
    this.#applying = next.catch(() => {});
    return next;
  }

  #row(agentId: string): ScheduleRow | undefined {
    return this.#sql.exec("SELECT * FROM agent_schedules WHERE agent_id = ?", agentId).toArray()[0] as ScheduleRow | undefined;
  }

  /** When an agent runs next on its schedule; null for none (off, a watch, or no trigger). */
  nextRun(agentId: string): number | null {
    const row = this.#row(agentId);
    return row?.kind === "schedule" ? row.due_at : null;
  }

  /**
   * Set an agent's alarms from its definition as it is now: its schedule's next run, or its watch; none when it is off,
   * has no trigger, or is gone (`agent` null). A definition saved with the same trigger keeps the alarm it had.
   */
  apply(agentId: string, agent: AgentDefinition | null): Promise<void> {
    return this.#one(() => this.#apply(agentId, agent));
  }

  async #apply(agentId: string, agent: AgentDefinition | null, after = this.#host.runs.now()): Promise<void> {
    const row = this.#row(agentId);
    const wanted = agent?.enabled && agent.trigger ? agent : null;
    const key = wanted ? triggerKey(wanted) : "";
    if (row && wanted && row.kind === wanted.trigger!.kind && row.key === key && (row.kind === "watch" || (row.due_at ?? 0) > after)) return;
    if (row) await this.#clear(row);
    if (!wanted) return;
    const trigger = wanted.trigger!;
    if (trigger.kind === "schedule") {
      const dueAt = nextRunAt(trigger, after);
      if (dueAt === null) return;
      const id = await this.#host.alarmAt(dueAt, { agentId, dueAt });
      this.#sql.exec("INSERT OR REPLACE INTO agent_schedules (agent_id, kind, key, schedule_id, due_at) VALUES (?, 'schedule', ?, ?, ?)", agentId, key, id, dueAt);
      return;
    }
    let id: string | null = null;
    if (this.#host.sharedWatch(trigger.step)) await this.#host.subscribe(agentId, trigger.step, trigger.everyMinutes);
    else id = await this.#host.alarmEvery(trigger.everyMinutes * 60, { agentId });
    this.#sql.exec("INSERT OR REPLACE INTO agent_schedules (agent_id, kind, key, schedule_id, due_at) VALUES (?, 'watch', ?, ?, NULL)", agentId, key, id);
  }

  /** Take an agent's alarm down, and its watch's last value with it. */
  async #clear(row: ScheduleRow): Promise<void> {
    if (row.schedule_id) await this.#host.cancelAlarm(row.schedule_id).catch((error: unknown) => console.error("agent alarm:", errorMessage(error)));
    if (row.kind === "watch" && !row.schedule_id) {
      const step = (JSON.parse(row.key) as { step: LookStep }).step;
      await this.#host.unsubscribe(row.agent_id, step).catch((error: unknown) => console.error("agent watch:", errorMessage(error)));
    }
    this.#sql.exec("DELETE FROM agent_schedules WHERE agent_id = ?", row.agent_id);
    this.#sql.exec("DELETE FROM agent_watch_last WHERE agent_id = ?", row.agent_id);
  }

  /**
   * A run's alarm came: the next run is set first (so a run that never ends does not stop the schedule), then this
   * one runs. An alarm for a time the agent no longer runs at (its definition changed since) runs nothing; one that
   * fires twice runs once.
   */
  async fired({ agentId, dueAt }: RunAlarm): Promise<RunEnd | null> {
    const agent = await this.#host.definition(agentId);
    const due = await this.#one(async () => {
      const row = this.#row(agentId);
      if (!agent?.enabled || agent.trigger?.kind !== "schedule" || row?.kind !== "schedule" || row.due_at !== dueAt) {
        if (row?.due_at !== dueAt) return false;
        await this.#apply(agentId, agent);
        return false;
      }
      // From the later of the due time and now: an alarm that came late does not set one in the past.
      await this.#apply(agentId, agent, Math.max(dueAt, this.#host.runs.now()));
      return true;
    });
    if (!due || !agent) return null;
    return this.executor.start({ agent, dueAt, why: "schedule" });
  }

  /** A watch's interval came: read it, and run when its value moved and its condition holds. */
  async watchTick({ agentId }: WatchAlarm): Promise<RunEnd | null> {
    const agent = await this.#host.definition(agentId);
    if (!agent?.enabled || agent.trigger?.kind !== "watch") {
      await this.apply(agentId, agent);
      return null;
    }
    const step = agent.trigger.step;
    return this.moved(agent, await this.#host.read(step.server, step.tool, step.input));
  }

  /** A Source the agent watches through says its value moved. */
  async sourceMoved(agentId: string, value: Value): Promise<RunEnd | null> {
    const agent = await this.#host.definition(agentId);
    if (!agent?.enabled || agent.trigger?.kind !== "watch") {
      await this.apply(agentId, agent);
      return null;
    }
    return this.moved(agent, value);
  }

  /** A watch read `value`: a run when it differs from the last one and the condition holds over it (and `previous`). */
  async moved(agent: AgentDefinition, value: Value): Promise<RunEnd | null> {
    if (agent.trigger?.kind !== "watch") return null;
    const now = this.#host.runs.now();
    const print = await fingerprint(value);
    const last = this.#sql.exec("SELECT fingerprint FROM agent_watch_last WHERE agent_id = ?", agent.id).toArray()[0] as { fingerprint: string } | undefined;
    if (last?.fingerprint === print) return null;
    this.#sql.exec("INSERT OR REPLACE INTO agent_watch_last (agent_id, fingerprint, at) VALUES (?, ?, ?)", agent.id, print, now);
    // A small value is kept as its JSON, so the condition can compare with it; a large one only as its hash.
    const previous = last && !last.fingerprint.startsWith(HASHED) ? (JSON.parse(last.fingerprint) as Value) : undefined;
    let fires: boolean;
    try {
      fires = watchFires(agent.trigger.when, resultName(agent.trigger.step), value, previous);
    } catch (error) {
      console.error("agent watch:", errorMessage(error));
      return null;
    }
    if (!fires) return null;
    return this.executor.start({ agent, dueAt: now, why: "watch", watch: value });
  }

  /**
   * A run now, outside the schedule: Test it (`test`: nothing is sent or changed) or one a person asked for. Returns
   * its due time, which names it, at once; the run goes on in the background.
   */
  async now(agentId: string, test: boolean): Promise<{ dueAt: number } | { error: string }> {
    const agent = await this.#host.definition(agentId);
    if (!agent) return { error: "No such agent." };
    if (!test && !agent.enabled) return { error: `@${agent.name} is off: turn it on first.` };
    let dueAt = this.#host.runs.now();
    while (this.#host.runs.get(agentId, dueAt)) dueAt++;
    this.#host.waitUntil(this.executor.start({ agent, dueAt, why: test ? "test" : "manual", test }));
    return { dueAt };
  }

  /** The owner signed in to `server`: the runs waiting for it go again. */
  async signedIn(server: string): Promise<number> {
    let restarted = 0;
    for (const run of this.#host.runs.unfinished()) {
      if (run.status !== "needs_sign_in" || !run.detail.needsSignIn?.includes(server)) continue;
      const agent = await this.#host.definition(run.agentId);
      if (!agent) continue;
      this.#host.runs.restart(run.agentId, run.dueAt);
      restarted++;
      this.#host.waitUntil(this.executor.start({ agent, dueAt: run.dueAt, why: run.why, test: run.test }));
    }
    return restarted;
  }

  /** After a restart: the runs that were going go on, from where their rows say. Cheap when there are none. */
  resume(): void {
    for (const run of this.#host.runs.unfinished()) {
      if (run.status !== "running" || this.executor.busy(run.agentId)) continue;
      this.#host.waitUntil(
        this.#host.definition(run.agentId).then((agent) => {
          if (!agent) {
            this.#host.runs.update(run.agentId, run.dueAt, { status: "failed", summary: "Failed: the agent was deleted." });
            return null;
          }
          return this.executor.start({ agent, dueAt: run.dueAt, why: run.why, test: run.test, watch: run.detail.watch as Value | undefined });
        }),
      );
    }
  }

  /** Take every alarm and watch down: the chat is being deleted. */
  async clearAll(): Promise<void> {
    for (const row of this.#sql.exec("SELECT * FROM agent_schedules").toArray() as ScheduleRow[]) await this.#clear(row);
  }

  /** Whether an agent has runs going or set. */
  hasWork(): boolean {
    return this.#sql.exec("SELECT 1 FROM agent_schedules LIMIT 1").toArray().length > 0 || this.#host.runs.unfinished().length > 0;
  }
}
