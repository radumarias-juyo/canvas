// The cards of the actions members' agents held in their seats (worker/agents/seats/), as the room keeps them: each
// for the agent's owner alone, who decides it here, in the chat the turn was in, and once it ended sees how (as the
// owner's own cards keep their outcome). The action itself (its exact call, its expiry, running it) stays in the
// member's own object, which holds their sign-ins and their rules; the room only shows the card it sends
// (RoomLink.action) and passes the decision back (SeatLink.decide).

import type { PendingActionView } from "../../../shared/limits.ts";
import type { Sql } from "../../members.ts";
import type { RosterEntry } from "../roster.ts";
import { seatedEntry, type ChatRules } from "./rules.ts";

/** An action's id, as the member's object makes it (ChatActions: randomHex(8)). */
const ACTION_ID = /^[a-f0-9]{16}$/;
/** Ended cards kept per member in one chat, newest first: their outcome lines. Older ones go. */
export const MAX_ENDED_SEAT_ACTIONS = 50;
/** A card's row that still waits or runs (its view's status). */
const OPEN = "json_extract(view, '$.status') IN ('pending', 'running')";

type SeatActionRow = { owner_uid: string; agent_id: string };

export class SeatActions {
  readonly #sql: Sql;

  constructor(sql: Sql) {
    this.#sql = sql;
    sql.exec(`
      CREATE TABLE IF NOT EXISTS seat_actions (
        id TEXT PRIMARY KEY, owner_uid TEXT NOT NULL, agent_id TEXT NOT NULL, view TEXT NOT NULL, created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS seat_actions_owner ON seat_actions (owner_uid, created_at);
    `);
  }

  /**
   * A card `ownerUid`'s agent `agentId` sent from its seat, for this chat (`chatId`): kept while it waits or runs, and
   * once it ended as its outcome (the newest MAX_ENDED_SEAT_ACTIONS of the member's). An id another person's seat sent
   * is not taken over. Whether it was taken.
   */
  put(chatId: string, ownerUid: string, agentId: string, view: PendingActionView): boolean {
    if (!ACTION_ID.test(view.id) || view.chatId !== chatId) return false;
    const held = this.owner(view.id);
    if (held && (held.ownerUid !== ownerUid || held.agentId !== agentId)) return false;
    this.#sql.exec(
      `INSERT INTO seat_actions (id, owner_uid, agent_id, view, created_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (id) DO UPDATE SET view = excluded.view`,
      view.id,
      ownerUid,
      agentId,
      JSON.stringify({ ...view, seat: true } satisfies PendingActionView),
      view.createdAt,
    );
    if (view.status !== "pending" && view.status !== "running") {
      this.#sql.exec(
        `DELETE FROM seat_actions WHERE owner_uid = ? AND NOT ${OPEN} AND id NOT IN (
           SELECT id FROM seat_actions WHERE owner_uid = ? AND NOT ${OPEN} ORDER BY created_at DESC, id DESC LIMIT ?
         )`,
        ownerUid,
        ownerUid,
        MAX_ENDED_SEAT_ACTIONS,
      );
    }
    return true;
  }

  /** The cards of `uid`'s agents' seats here, waiting or ended, oldest first: only theirs. */
  of(uid: string): PendingActionView[] {
    const rows = this.#sql.exec("SELECT view FROM seat_actions WHERE owner_uid = ? ORDER BY created_at, id", uid).toArray();
    return rows.map((row) => JSON.parse(row.view as string) as PendingActionView);
  }

  /** Whose seat holds an action: its agent's owner and the agent; null for one this chat has no card of. */
  owner(id: string): { ownerUid: string; agentId: string } | null {
    const [row] = this.#sql.exec("SELECT owner_uid, agent_id FROM seat_actions WHERE id = ?", id).toArray() as SeatActionRow[];
    return row ? { ownerUid: row.owner_uid, agentId: row.agent_id } : null;
  }

  /**
   * An agent left the chat: its open cards go with it (its actions still end in its owner's object, by their expiry,
   * which no longer reaches here); the outcomes of those that ended stay.
   */
  dropAgent(agentId: string): void {
    this.#sql.exec(`DELETE FROM seat_actions WHERE agent_id = ? AND ${OPEN}`, agentId);
  }

  /**
   * The roster entry whose seat `uid` decides action `id` for: only the agent's owner, still in the chat with it
   * seated. A refusal for anyone else, the chat's owner included: it is not their call, nor their sign-ins.
   */
  decider(
    chat: ChatRules,
    entry: (agentId: string) => RosterEntry | null,
    uid: string,
    id: string,
  ): RosterEntry | { error: string; status: 403 | 404 } {
    const held = this.owner(id);
    if (!held) return { error: "No such action.", status: 404 };
    if (held.ownerUid !== uid) return { error: "Only the agent's owner decides what it changes.", status: 403 };
    return seatedEntry(chat, entry(held.agentId), uid) ?? { error: "This agent is no longer in the chat.", status: 404 };
  }
}
