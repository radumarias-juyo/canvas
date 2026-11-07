import {
  KEPT_RUNS,
  type AgentRunView,
  type RunDelivery,
  type RunItemStatus,
  type RunItemView,
  type RunStatus,
  type RunStepRecord,
  type RunWhy,
} from "../../../shared/runs.ts";
import type { Sql } from "../../members.ts";

/** The run itself, among its items: the row its status, deliveries and totals are kept in. */
const RUN = "";

type RunRow = {
  agent_id: string;
  due_at: number;
  item: string;
  why: RunWhy;
  status: string;
  test: number;
  label: string | null;
  session: string | null;
  started_at: number;
  ended_at: number | null;
  cost: number;
  summary: string | null;
  detail: string | null;
  reply_session: string | null;
};

/** What a run's own row keeps besides its status: what it sent, and what it waits for. */
export interface RunDetail {
  deliveries: RunDelivery[];
  needsSignIn?: string[];
  when?: string;
  used?: { skills: string[]; servers: string[]; models: string[] };
  /** The watch result that started it, for its steps to read as `watch`. */
  watch?: unknown;
  /** The delivery keys it sent already: a run that goes on after a restart sends each once. */
  sent?: string[];
}

/** What an item's row keeps: its steps, its part of the report and why it stopped. */
interface ItemDetail {
  steps: RunStepRecord[];
  text?: string;
  reason?: string;
  /** The keys of the delivery steps (tell, page, hand over) it reached: what its text goes out with. */
  reached?: string[];
}

/** A run as its own row has it. */
export interface RunRecord {
  agentId: string;
  dueAt: number;
  why: RunWhy;
  status: RunStatus;
  test: boolean;
  startedAt: number;
  endedAt?: number;
  cost: number;
  summary?: string;
  detail: RunDetail;
  /** The session replies to its post continue in: a fork of its session, made at the first reply. */
  replySession?: string;
}

function parse<T>(json: string | null, fallback: T): T {
  if (!json) return fallback;
  try {
    return JSON.parse(json) as T;
  } catch {
    return fallback;
  }
}

function recordOf(row: RunRow): RunRecord {
  return {
    agentId: row.agent_id,
    dueAt: row.due_at,
    why: row.why,
    status: row.status as RunStatus,
    test: row.test === 1,
    startedAt: row.started_at,
    ...(row.ended_at !== null && { endedAt: row.ended_at }),
    cost: row.cost,
    ...(row.summary !== null && { summary: row.summary }),
    detail: parse<RunDetail>(row.detail, { deliveries: [] }),
    ...(row.reply_session !== null && { replySession: row.reply_session }),
  };
}

function itemOf(row: RunRow): RunItemView {
  const detail = parse<ItemDetail>(row.detail, { steps: [] });
  return {
    item: row.item,
    label: row.label ?? row.item,
    status: row.status as RunItemStatus,
    ...(row.session !== null && { session: row.session }),
    steps: detail.steps,
    ...(detail.text !== undefined && { text: detail.text }),
    ...(detail.reason !== undefined && { reason: detail.reason }),
    ...(detail.reached?.length && { reached: detail.reached }),
    cost: row.cost,
    startedAt: row.started_at,
    ...(row.ended_at !== null && { endedAt: row.ended_at }),
  };
}

/** A run that ended, as `begin` finds it: it is not run again. */
export function isFinal(status: RunStatus): boolean {
  return status !== "running" && status !== "needs_sign_in";
}

/**
 * The runs of the agents whose home conversation this chat object is, in its SQLite: one row per run, with the item
 * "" (its status, what it sent), and one per item of its scope. Rows are keyed by (agent, due time, item), so an
 * alarm that fires twice finds the run it started and stops, and an item is never started twice.
 */
export class AgentRuns {
  readonly #sql: Sql;
  readonly #now: () => number;

  constructor(sql: Sql, now: () => number = Date.now) {
    this.#sql = sql;
    this.#now = now;
    sql.exec(`
      CREATE TABLE IF NOT EXISTS agent_runs (
        agent_id TEXT NOT NULL, due_at INTEGER NOT NULL, item TEXT NOT NULL, why TEXT NOT NULL, status TEXT NOT NULL,
        test INTEGER NOT NULL DEFAULT 0, label TEXT, session TEXT, started_at INTEGER NOT NULL, ended_at INTEGER,
        cost REAL NOT NULL DEFAULT 0, summary TEXT, detail TEXT, reply_session TEXT,
        PRIMARY KEY (agent_id, due_at, item)
      );
      CREATE INDEX IF NOT EXISTS agent_runs_by_status ON agent_runs (status, item);
    `);
  }

  now(): number {
    return this.#now();
  }

  #rows(where: string, ...params: (string | number)[]): RunRow[] {
    return this.#sql.exec(`SELECT * FROM agent_runs WHERE ${where}`, ...params).toArray() as RunRow[];
  }

  /**
   * Start a run, or find the one started for the same due time. `started` is false when it was there already: the
   * caller runs it only when it has not ended (a run cut off by a restart goes on, a finished one never repeats).
   */
  begin(agentId: string, dueAt: number, why: RunWhy, test: boolean, detail: Omit<RunDetail, "deliveries"> = {}): { run: RunRecord; started: boolean } {
    const written = this.#sql.exec(
      `INSERT INTO agent_runs (agent_id, due_at, item, why, status, test, started_at, detail) VALUES (?, ?, ?, ?, 'running', ?, ?, ?)
       ON CONFLICT (agent_id, due_at, item) DO NOTHING`,
      agentId,
      dueAt,
      RUN,
      why,
      test ? 1 : 0,
      this.#now(),
      JSON.stringify({ deliveries: [], ...detail } satisfies RunDetail),
    ).rowsWritten;
    if (written) this.#prune(agentId);
    return { run: this.get(agentId, dueAt)!, started: written > 0 };
  }

  /** Keep the newest KEPT_RUNS runs of an agent, items included. */
  #prune(agentId: string): void {
    this.#sql.exec(
      `DELETE FROM agent_runs WHERE agent_id = ? AND due_at < (
         SELECT MIN(due_at) FROM (SELECT due_at FROM agent_runs WHERE agent_id = ? AND item = '' ORDER BY due_at DESC LIMIT ?)
       )`,
      agentId,
      agentId,
      KEPT_RUNS,
    );
  }

  get(agentId: string, dueAt: number): RunRecord | null {
    const row = this.#rows("agent_id = ? AND due_at = ? AND item = ''", agentId, dueAt)[0];
    return row ? recordOf(row) : null;
  }

  /** A run waiting for sign-in goes again: back to running, the servers it waited for forgotten. */
  restart(agentId: string, dueAt: number): void {
    const run = this.get(agentId, dueAt);
    if (!run || run.status !== "needs_sign_in") return;
    const { needsSignIn: _, ...detail } = run.detail;
    this.#sql.exec(
      "UPDATE agent_runs SET status = 'running', ended_at = NULL, summary = NULL, detail = ? WHERE agent_id = ? AND due_at = ? AND item = ''",
      JSON.stringify(detail),
      agentId,
      dueAt,
    );
  }

  /** Change what a run's row keeps: its status (an end when final), summary, cost, detail. */
  update(agentId: string, dueAt: number, change: { status?: RunStatus; summary?: string; detail?: Partial<RunDetail> }): void {
    const run = this.get(agentId, dueAt);
    if (!run) return;
    const status = change.status ?? run.status;
    const ended = isFinal(status) || status === "needs_sign_in" ? this.#now() : null;
    const { cost } = this.#sql.exec("SELECT COALESCE(SUM(cost), 0) AS cost FROM agent_runs WHERE agent_id = ? AND due_at = ? AND item != ''", agentId, dueAt).toArray()[0] as {
      cost: number;
    };
    this.#sql.exec(
      "UPDATE agent_runs SET status = ?, ended_at = ?, summary = ?, cost = ?, detail = ? WHERE agent_id = ? AND due_at = ? AND item = ''",
      status,
      ended,
      change.summary ?? run.summary ?? null,
      cost,
      JSON.stringify({ ...run.detail, ...change.detail }),
      agentId,
      dueAt,
    );
  }

  /** Start an item of a run in its session, or find it: an item that ended is not run again. */
  async beginItem(agentId: string, dueAt: number, item: string, label: string, session: () => Promise<string>): Promise<{ view: RunItemView; started: boolean }> {
    const found = this.item(agentId, dueAt, item);
    if (found && found.session) return { view: found, started: false };
    const id = await session();
    // A second start of the same item while the first made its session finds the first's row.
    this.#sql.exec(
      `INSERT INTO agent_runs (agent_id, due_at, item, why, status, label, session, started_at, detail)
       SELECT ?, ?, ?, why, 'running', ?, ?, ?, ? FROM agent_runs WHERE agent_id = ? AND due_at = ? AND item = ''
       ON CONFLICT (agent_id, due_at, item) DO NOTHING`,
      agentId,
      dueAt,
      item || "*",
      label,
      id,
      this.#now(),
      JSON.stringify({ steps: [] } satisfies ItemDetail),
      agentId,
      dueAt,
    );
    return { view: this.item(agentId, dueAt, item)!, started: true };
  }

  /** An item of a run; "" names the item of a run with no scope (kept as "*", apart from the run's own row). */
  item(agentId: string, dueAt: number, item: string): RunItemView | null {
    const row = this.#rows("agent_id = ? AND due_at = ? AND item = ?", agentId, dueAt, item || "*")[0];
    return row ? { ...itemOf(row), item } : null;
  }

  /** An item ended (or recorded a step): its status, steps, text and cost. */
  updateItem(agentId: string, dueAt: number, item: string, change: { status?: RunItemStatus; cost?: number } & Partial<ItemDetail>): void {
    const found = this.item(agentId, dueAt, item);
    if (!found) return;
    const status = change.status ?? found.status;
    const detail: ItemDetail = {
      steps: change.steps ?? found.steps,
      ...((change.text ?? found.text) !== undefined && { text: change.text ?? found.text }),
      ...((change.reason ?? found.reason) !== undefined && { reason: change.reason ?? found.reason }),
      ...((change.reached ?? found.reached) && { reached: change.reached ?? found.reached }),
    };
    this.#sql.exec(
      "UPDATE agent_runs SET status = ?, ended_at = ?, cost = ?, detail = ? WHERE agent_id = ? AND due_at = ? AND item = ?",
      status,
      status === "running" ? null : this.#now(),
      change.cost ?? found.cost,
      JSON.stringify(detail),
      agentId,
      dueAt,
      item || "*",
    );
  }

  items(agentId: string, dueAt: number): RunItemView[] {
    return this.#rows("agent_id = ? AND due_at = ? AND item != '' ORDER BY started_at, item", agentId, dueAt).map((row) => {
      const view = itemOf(row);
      return row.item === "*" ? { ...view, item: "", label: view.label === "*" ? "" : view.label } : view;
    });
  }

  /** The run as the runs list shows it. */
  view(run: RunRecord): AgentRunView {
    const counts = this.#sql
      .exec(
        `SELECT COUNT(*) AS total, SUM(status = 'acted') AS acted, SUM(status = 'not_today') AS not_today, SUM(status = 'failed') AS failed
         FROM agent_runs WHERE agent_id = ? AND due_at = ? AND item != ''`,
        run.agentId,
        run.dueAt,
      )
      .toArray()[0] as { total: number; acted: number | null; not_today: number | null; failed: number | null };
    return {
      agentId: run.agentId,
      dueAt: run.dueAt,
      why: run.why,
      status: run.status,
      ...(run.test && { test: true as const }),
      startedAt: run.startedAt,
      ...(run.endedAt !== undefined && { endedAt: run.endedAt }),
      cost: run.cost,
      items: { total: counts.total, acted: counts.acted ?? 0, notToday: counts.not_today ?? 0, failed: counts.failed ?? 0 },
      ...(run.summary !== undefined && { summary: run.summary }),
      ...(run.detail.needsSignIn?.length && { needsSignIn: run.detail.needsSignIn }),
    };
  }

  /** An agent's runs, newest first. */
  list(agentId: string, limit = 50): AgentRunView[] {
    return this.#rows("agent_id = ? AND item = '' ORDER BY due_at DESC LIMIT ?", agentId, limit).map((row) => this.view(recordOf(row)));
  }

  /** The runs that did not end: cut off by a restart, or waiting for a sign-in. */
  unfinished(): RunRecord[] {
    return this.#rows("item = '' AND status IN ('running', 'needs_sign_in') ORDER BY due_at").map(recordOf);
  }

  /** The session replies to a run's post continue in, once made. */
  setReplySession(agentId: string, dueAt: number, session: string): void {
    this.#sql.exec("UPDATE agent_runs SET reply_session = ? WHERE agent_id = ? AND due_at = ? AND item = '' AND reply_session IS NULL", session, agentId, dueAt);
  }

  /** Forget an agent's runs (it was deleted). */
  forget(agentId: string): void {
    this.#sql.exec("DELETE FROM agent_runs WHERE agent_id = ?", agentId);
  }
}
