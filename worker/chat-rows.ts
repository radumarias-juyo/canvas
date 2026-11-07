import { isChatKind, legacyKind, type ChatKind } from "../shared/chat-kinds.ts";
import type { ChatStatus, ChatSummary, Person } from "../shared/protocol.ts";
import type { Sql } from "./members.ts";

/** The most people a sidebar remembers sharing chats with (ChatRows.knowPeople), newest kept. */
export const MAX_KNOWN_PEOPLE = 500;

/** The longest name someone gives a chat for themselves. */
export const MAX_CHAT_TITLE = 200;

/** What one person changes about a chat in their own sidebar; each field left out stays as it is. */
export interface ChatRowChange {
  pinned?: boolean;
  /** Hidden from their list until someone tags them in it again (or they open it from the closed ones). */
  closed?: boolean;
  /** Bold again, as if something new came in, until they next look at it. */
  unread?: boolean;
  /** Their own name for it; empty goes back to the chat's own. */
  title?: string;
}

/** A change as the browser sends it, checked for shape; null when it holds nothing valid. */
export function parseRowChange(raw: unknown): ChatRowChange | null {
  if (!raw || typeof raw !== "object") return null;
  const given = raw as Record<string, unknown>;
  const change: ChatRowChange = {};
  for (const key of ["pinned", "closed", "unread"] as const) if (typeof given[key] === "boolean") change[key] = given[key];
  if (typeof given.title === "string") change.title = given.title.trim().slice(0, MAX_CHAT_TITLE);
  return Object.keys(change).length ? change : null;
}

type Row = {
  id: string;
  title: string;
  created_at: number;
  updated_at: number;
  shared_by: string | null;
  shared: number;
  status: ChatStatus | null;
  unread: number;
  mentioned: number;
  kind: string | null;
  pinned_at: number;
  closed_at: number;
};

/**
 * The parts of one user's sidebar rows (UserDirectory's `chats`, their own, and `shared_chats`, others' they are in)
 * that are theirs alone, and what the rows say of each chat's kind: pinned, closed, marked unread, their own name for
 * it. Also which of their artifacts has its chat ("Discuss", `page_chats`), and the people they share chats with
 * (`people`), whom the "@" picker offers to add. Over the directory's own SQLite; the directory tells the open sidebars.
 */
export class ChatRows {
  readonly #sql: Sql;

  constructor(sql: Sql) {
    this.#sql = sql;
    for (const table of ["chats", "shared_chats"]) {
      // Copied from the chat (setKind); null in a row from before kinds, which kindOf reads as the chat was.
      this.#addColumn(table, "kind", "TEXT");
      this.#addColumn(table, "pinned_at", "INTEGER NOT NULL DEFAULT 0");
      this.#addColumn(table, "closed_at", "INTEGER NOT NULL DEFAULT 0");
      this.#addColumn(table, "marked_unread", "INTEGER NOT NULL DEFAULT 0");
      this.#addColumn(table, "own_title", "TEXT");
    }
    sql.exec(`
      CREATE TABLE IF NOT EXISTS page_chats (artifact_id TEXT PRIMARY KEY, chat_id TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS people (uid TEXT PRIMARY KEY, name TEXT NOT NULL, met_at INTEGER NOT NULL);
    `);
  }

  /** `table`, `column` and `type` are written here, never input. */
  #addColumn(table: string, column: string, type: string): void {
    const columns = this.#sql.exec(`SELECT name FROM pragma_table_info('${table}')`).toArray();
    if (!columns.some((row) => row.name === column)) this.#sql.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
  }

  /** The user's own chats and the ones shared with them, most recent first, as their sidebar shows them. */
  list(): ChatSummary[] {
    const rows = this.#sql
      .exec(
        `SELECT id, COALESCE(own_title, title) AS title, created_at, updated_at, NULL AS shared_by, shared, status,
           (activity_at > seen_at OR marked_unread = 1) AS unread, mentioned_at > seen_at AS mentioned, kind, pinned_at, closed_at FROM chats
         UNION ALL SELECT id, COALESCE(own_title, title), joined_at, updated_at, owner_name, 0, status,
           (activity_at > seen_at OR marked_unread = 1), mentioned_at > seen_at, kind, pinned_at, closed_at FROM shared_chats
         ORDER BY updated_at DESC`,
      )
      .toArray() as Row[];
    return rows.map((row) => ({
      id: row.id,
      title: row.title,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      kind: rowKind(row.kind, row.shared_by !== null || row.shared === 1),
      ...(row.shared_by !== null ? { sharedBy: row.shared_by } : row.shared === 1 && { shared: true as const }),
      ...(row.status && { status: row.status }),
      ...(row.unread === 1 && { unread: true as const }),
      ...(row.mentioned === 1 && { mentioned: true as const }),
      ...(row.pinned_at > 0 && { pinnedAt: row.pinned_at }),
      ...(row.closed_at > 0 && { closed: true as const }),
    }));
  }

  /**
   * Change the user's own row for chat `id` (ChatRowChange), in whichever table has it. Their own name is kept apart
   * from the chat's title, so the chat naming itself, or its owner renaming it, does not undo it. Whether a row changed.
   */
  change(id: string, change: ChatRowChange, now = Date.now()): boolean {
    const sets: string[] = [];
    const values: (string | number | null)[] = [];
    if (change.pinned !== undefined) {
      sets.push("pinned_at = CASE WHEN ? THEN CASE WHEN pinned_at > 0 THEN pinned_at ELSE ? END ELSE 0 END");
      values.push(change.pinned ? 1 : 0, now);
    }
    if (change.closed !== undefined) {
      sets.push("closed_at = ?");
      values.push(change.closed ? now : 0);
    }
    if (change.unread !== undefined) {
      sets.push("marked_unread = ?");
      values.push(change.unread ? 1 : 0);
    }
    if (change.title !== undefined) {
      sets.push("own_title = ?");
      values.push(change.title || null);
    }
    if (!sets.length) return false;
    const set = sets.join(", ");
    let written = 0;
    for (const table of ["chats", "shared_chats"]) written += this.#sql.exec(`UPDATE ${table} SET ${set} WHERE id = ?`, ...values, id).rowsWritten;
    return written > 0;
  }

  /** Someone tagged this user in chat `id` (or added them to it again): a chat they closed is in their list again. */
  reopen(id: string): void {
    for (const table of ["chats", "shared_chats"]) this.#sql.exec(`UPDATE ${table} SET closed_at = 0 WHERE id = ? AND closed_at > 0`, id);
  }

  /** The kind of chat `id` as this sidebar last heard it, or null for a chat it does not list. */
  kindOf(id: string): ChatKind | null {
    const row = this.#sql
      .exec("SELECT kind, shared AS members FROM chats WHERE id = ? UNION ALL SELECT kind, 1 FROM shared_chats WHERE id = ?", id, id)
      .toArray()[0];
    return row ? rowKind(row.kind as string | null, row.members === 1) : null;
  }

  /** The chat that discusses one of this user's artifacts, made by "Discuss" on its page; null when there is none yet. */
  pageChat(artifactId: string): string | null {
    const row = this.#sql
      .exec("SELECT p.chat_id FROM page_chats p JOIN chats c ON c.id = p.chat_id WHERE p.artifact_id = ?", artifactId)
      .toArray()[0];
    return (row?.chat_id as string | undefined) ?? null;
  }

  linkPage(artifactId: string, chatId: string): void {
    this.#sql.exec(
      "INSERT INTO page_chats (artifact_id, chat_id) VALUES (?, ?) ON CONFLICT(artifact_id) DO UPDATE SET chat_id = excluded.chat_id",
      artifactId,
      chatId,
    );
  }

  /** A deleted chat no longer discusses any page. */
  forgetChat(chatId: string): void {
    this.#sql.exec("DELETE FROM page_chats WHERE chat_id = ?", chatId);
  }

  /** Remember the people this user shares a chat with, by the name they last showed, at most MAX_KNOWN_PEOPLE. */
  knowPeople(people: readonly Person[], self: string, now = Date.now()): void {
    for (const person of people) {
      if (person.uid === self) continue;
      this.#sql.exec(
        "INSERT INTO people (uid, name, met_at) VALUES (?, ?, ?) ON CONFLICT(uid) DO UPDATE SET name = excluded.name, met_at = excluded.met_at",
        person.uid,
        person.name,
        now,
      );
    }
    this.#sql.exec("DELETE FROM people WHERE uid NOT IN (SELECT uid FROM people ORDER BY met_at DESC LIMIT ?)", MAX_KNOWN_PEOPLE);
  }

  /** The people this user shares chats with, most recently met first. */
  people(): Person[] {
    return this.#sql
      .exec("SELECT uid, name FROM people ORDER BY met_at DESC")
      .toArray()
      .map((row) => ({ uid: row.uid as string, name: row.name as string }));
  }

  /** One of them, or null for someone this user does not share a chat with. */
  person(uid: string): Person | null {
    const row = this.#sql.exec("SELECT uid, name FROM people WHERE uid = ?", uid).toArray()[0];
    return row ? { uid: row.uid as string, name: row.name as string } : null;
  }
}

/** A row's kind: as copied from the chat, or for a row from before kinds, as the chat then was (with members a group). */
function rowKind(kind: string | null, hasMembers: boolean): ChatKind {
  return isChatKind(kind) ? kind : legacyKind(hasMembers);
}
