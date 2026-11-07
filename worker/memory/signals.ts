import { checkSignal, keepsSignals, MAX_SIGNALS_A_DAY, SIGNAL_DAYS, type AgentSignal, type SignalKind } from "../../shared/signals.ts";
import type { ChatKind } from "../../shared/chat-kinds.ts";
import type { Sql } from "../members.ts";

const DAY_MS = 86_400_000;

type SignalRow = {
  agent_id: string;
  chat_id: string;
  chat_owner: string;
  chat_kind: ChatKind;
  alone: number;
  signal: SignalKind;
  actor: AgentSignal["actor"];
  seq: number | null;
  turn: number | null;
  detail: string | null;
  at: number;
};

function signalOf(row: SignalRow): AgentSignal {
  return {
    agentId: row.agent_id,
    chatId: row.chat_id,
    chatOwner: row.chat_owner,
    chatKind: row.chat_kind,
    alone: row.alone === 1,
    signal: row.signal,
    actor: row.actor,
    ...(row.seq !== null && { seq: row.seq }),
    ...(row.turn !== null && { turn: row.turn }),
    ...(row.detail !== null && { detail: row.detail }),
    at: row.at,
  };
}

/**
 * One user's agents' signals (shared/signals.ts), in their UserDirectory's SQLite: what people did with each agent, in
 * which chat, by entry and turn, never what they said. Kept SIGNAL_DAYS, at most MAX_SIGNALS_A_DAY per agent a day.
 * Nothing from a chat off the record: the sender checks, and so does `record`, with the kind this directory knows of its
 * own chat (`known`) too; the strictest wins.
 */
export class SignalStore {
  readonly #sql: Sql;
  readonly #now: () => number;
  /** When old signals were last let go: once an hour is enough. */
  #prunedAt = 0;

  constructor(sql: Sql, now: () => number = Date.now) {
    this.#sql = sql;
    this.#now = now;
    sql.exec(`
      CREATE TABLE IF NOT EXISTS agent_signals (
        id INTEGER PRIMARY KEY AUTOINCREMENT, agent_id TEXT NOT NULL, chat_id TEXT NOT NULL, chat_owner TEXT NOT NULL, chat_kind TEXT NOT NULL,
        alone INTEGER NOT NULL, signal TEXT NOT NULL, actor TEXT NOT NULL, seq INTEGER, turn INTEGER, detail TEXT, at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS agent_signals_by_agent ON agent_signals (agent_id, at);
    `);
  }

  /**
   * Keep the signals a chat sent that may be kept: each checked (checkSignal), none from a chat off the record as it
   * says or as `known` says of it (this directory's own chats; null for someone else's), and within the day's room.
   * How many were kept.
   */
  record(values: readonly unknown[], known: (chatId: string) => ChatKind | null = () => null): number {
    let kept = 0;
    const now = this.#now();
    this.#prune(now);
    for (const value of values) {
      const signal = checkSignal(value);
      if (!signal) continue;
      const own = known(signal.chatId);
      if (!keepsSignals(signal.chatKind, ...(own ? [own] : []))) continue;
      // Never from the future: a sender's clock ahead of this one's would keep it past its days.
      const at = Math.min(signal.at, now);
      const day = this.#sql
        .exec("SELECT COUNT(*) AS n FROM agent_signals WHERE agent_id = ? AND at > ?", signal.agentId, at - DAY_MS)
        .toArray()[0].n as number;
      if (day >= MAX_SIGNALS_A_DAY) continue;
      this.#sql.exec(
        `INSERT INTO agent_signals (agent_id, chat_id, chat_owner, chat_kind, alone, signal, actor, seq, turn, detail, at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        signal.agentId,
        signal.chatId,
        signal.chatOwner,
        signal.chatKind,
        signal.alone ? 1 : 0,
        signal.signal,
        signal.actor,
        signal.seq ?? null,
        signal.turn ?? null,
        signal.detail ?? null,
        at,
      );
      kept++;
    }
    return kept;
  }

  /** An agent's signals from `from` (inclusive) to `to` (exclusive), newest first. */
  between(agentId: string, from: number, to: number): AgentSignal[] {
    return (
      this.#sql.exec("SELECT * FROM agent_signals WHERE agent_id = ? AND at >= ? AND at < ? ORDER BY at DESC, id DESC", agentId, from, to).toArray() as SignalRow[]
    ).map(signalOf);
  }

  /** Whether an agent did anything from `from` to `to`: a signal of any kind. */
  active(agentId: string, from: number, to: number): boolean {
    return this.#sql.exec("SELECT 1 FROM agent_signals WHERE agent_id = ? AND at >= ? AND at < ? LIMIT 1", agentId, from, to).toArray().length > 0;
  }

  /** A chat went off the record, or was deleted: everything recorded in it goes. */
  forgetChat(chatId: string): void {
    this.#sql.exec("DELETE FROM agent_signals WHERE chat_id = ?", chatId);
  }

  /** A deleted agent: its signals go. */
  forgetAgent(agentId: string): void {
    this.#sql.exec("DELETE FROM agent_signals WHERE agent_id = ?", agentId);
  }

  /** Every signal, newest first (for tests and the data export's look). */
  list(): AgentSignal[] {
    return (this.#sql.exec("SELECT * FROM agent_signals ORDER BY at DESC, id DESC").toArray() as SignalRow[]).map(signalOf);
  }

  #prune(now: number): void {
    if (now - this.#prunedAt < 3_600_000) return;
    this.#prunedAt = now;
    this.#sql.exec("DELETE FROM agent_signals WHERE at < ?", now - SIGNAL_DAYS * DAY_MS);
  }
}
