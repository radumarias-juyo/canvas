// What a user's directory keeps of their limits: their rules for all agents, the log of calls that change data, and the
// index of actions waiting for them across their chats (the "Needs you" list). The actions themselves stay in the chat
// objects that made them, which run them.

import { checkRules, GuardrailError, type CallLogView, type CallOutcome, type GuardrailRule, type NeedsYouItem } from "../../../shared/limits.ts";
import type { Sql } from "../../members.ts";

/** How long the log keeps a call: longer than any day a callsPerDay rule counts, and enough to look back on a week. */
const LOG_DAYS = 30;
const MAX_LOG_ROWS = 5_000;

type CallRow = { id: number; at: number; chat_id: string; actor: string; server: string; tool: string; outcome: CallOutcome; detail: string | null };

/** The key-value storage the rules are kept in: a Durable Object's `ctx.storage.kv`, or a test's map. */
export interface Kv {
  get<T>(key: string): T | undefined;
  put(key: string, value: unknown): void;
  delete(key: string): unknown;
}

/** A call to log, as the chat that made it tells it. */
export type CallEntry = Omit<CallLogView, "id" | "at">;

export class LimitsDirectory {
  readonly #sql: Sql;
  readonly #kv: Kv;
  readonly #now: () => number;

  constructor(sql: Sql, kv: Kv, now: () => number = Date.now) {
    this.#sql = sql;
    this.#kv = kv;
    this.#now = now;
    sql.exec(`
      CREATE TABLE IF NOT EXISTS tool_calls (
        id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, chat_id TEXT NOT NULL, actor TEXT NOT NULL, server TEXT NOT NULL,
        tool TEXT NOT NULL, outcome TEXT NOT NULL, detail TEXT
      );
      CREATE INDEX IF NOT EXISTS tool_calls_tool ON tool_calls (server, tool, at);
      CREATE TABLE IF NOT EXISTS needs_you (
        chat_id TEXT NOT NULL, id TEXT NOT NULL, item TEXT NOT NULL, expires_at INTEGER NOT NULL, created_at INTEGER NOT NULL,
        PRIMARY KEY (chat_id, id)
      );
    `);
  }

  rules(): GuardrailRule[] {
    return this.#kv.get<GuardrailRule[]>("guardrails") ?? [];
  }

  setRules(input: unknown): GuardrailRule[] | { error: string } {
    try {
      const rules = checkRules(input);
      if (rules.length) this.#kv.put("guardrails", rules);
      else this.#kv.delete("guardrails");
      return rules;
    } catch (error) {
      if (error instanceof GuardrailError) return { error: error.message };
      throw error;
    }
  }

  log(entry: CallEntry): void {
    const now = this.#now();
    this.#sql.exec(
      "INSERT INTO tool_calls (at, chat_id, actor, server, tool, outcome, detail) VALUES (?, ?, ?, ?, ?, ?, ?)",
      now,
      entry.chatId,
      entry.actor.slice(0, 64),
      entry.server,
      entry.tool,
      entry.outcome,
      entry.detail?.slice(0, 500) ?? null,
    );
    this.#sql.exec("DELETE FROM tool_calls WHERE at < ?", now - LOG_DAYS * 86_400_000);
    this.#sql.exec("DELETE FROM tool_calls WHERE id <= (SELECT id FROM tool_calls ORDER BY id DESC LIMIT 1 OFFSET ?)", MAX_LOG_ROWS);
  }

  /** How many calls of server.tool ran since `since`, in all the user's chats: what a callsPerDay rule counts. */
  callsSince(server: string, tool: string, since: number): number {
    return this.#sql
      .exec(
        "SELECT COUNT(*) AS n FROM tool_calls WHERE server = ? AND tool = ? AND at >= ? AND outcome IN ('ran', 'warned', 'failed')",
        server,
        tool,
        since,
      )
      .toArray()[0].n as number;
  }

  /** The newest calls, of one actor ("@name", "pi") when given. */
  calls(actor?: string, limit = 50): CallLogView[] {
    const rows = (
      actor === undefined
        ? this.#sql.exec("SELECT * FROM tool_calls ORDER BY id DESC LIMIT ?", limit)
        : this.#sql.exec("SELECT * FROM tool_calls WHERE actor = ? ORDER BY id DESC LIMIT ?", actor, limit)
    ).toArray() as CallRow[];
    return rows.map((row) => ({
      id: row.id,
      at: row.at,
      chatId: row.chat_id,
      actor: row.actor,
      server: row.server,
      tool: row.tool,
      outcome: row.outcome,
      ...(row.detail !== null && { detail: row.detail }),
    }));
  }

  addNeedsYou(item: NeedsYouItem): void {
    this.#sql.exec(
      "INSERT OR REPLACE INTO needs_you (chat_id, id, item, expires_at, created_at) VALUES (?, ?, ?, ?, ?)",
      item.chatId,
      item.id,
      JSON.stringify(item),
      item.expiresAt,
      item.createdAt,
    );
  }

  /** Whether it was there. */
  removeNeedsYou(chatId: string, id: string): boolean {
    return this.#sql.exec("DELETE FROM needs_you WHERE chat_id = ? AND id = ?", chatId, id).rowsWritten > 0;
  }

  /** The actions waiting, oldest first; one whose chat never said it expired goes once its time is past. */
  needsYou(): NeedsYouItem[] {
    this.#sql.exec("DELETE FROM needs_you WHERE expires_at < ?", this.#now());
    return (this.#sql.exec("SELECT item FROM needs_you ORDER BY created_at").toArray() as { item: string }[]).map(
      (row) => JSON.parse(row.item) as NeedsYouItem,
    );
  }

  /** A chat that is deleted takes its waiting actions with it. */
  forgetChat(chatId: string): boolean {
    return this.#sql.exec("DELETE FROM needs_you WHERE chat_id = ?", chatId).rowsWritten > 0;
  }
}
