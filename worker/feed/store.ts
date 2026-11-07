// One person's feed and follows, over their UserDirectory's SQLite (see shared/feed.ts). The fan-out to followers is
// the directory's (worker/users.ts): these tables only keep and read what it hands them.

import { isChatKind, mayLeave, type ChatKind } from "../../shared/chat-kinds.ts";
import {
  FEED_PAGE,
  MAX_FEED_ITEMS,
  MAX_FEED_TEXT,
  MAX_FEED_TITLE,
  MAX_FOLLOWERS,
  MAX_FOLLOWS,
  NEEDS_YOU_KINDS,
  type FeedInput,
  type FeedItem,
  type FeedKind,
  type FeedList,
  type FollowKind,
  type FollowView,
} from "../../shared/feed.ts";
import { clip, mapLimit } from "../../shared/util.ts";
import type { Sql } from "../members.ts";

type FeedRow = { id: number; kind: FeedKind; at: number; read: number; needs: number; data: string };

/** What a feed row keeps as JSON: the item's fields that are not columns. */
type FeedData = Pick<FeedItem, "title" | "text" | "from" | "open" | "status">;

/** What `about` names an item by, so a page or agent that is gone takes its items with it. */
export function aboutOf(kind: FollowKind, id: string): string {
  return `${kind}:${id}`;
}

/** Whether `add` kept an item: a new one, a newer state of one it had, the same again, or refused (off the record). */
export type FeedAdded = "added" | "updated" | "same" | "refused";

/**
 * A person's feed (`feed`): one row per item, unique by its ref. Items about a chat keep its id (`chat_id`), and items
 * about a followed page or agent what they are about (`about`), so either going takes them along.
 */
export class FeedStore {
  readonly #sql: Sql;

  constructor(sql: Sql) {
    this.#sql = sql;
    sql.exec(`
      CREATE TABLE IF NOT EXISTS feed (id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL, ref TEXT NOT NULL UNIQUE, at INTEGER NOT NULL,
        read INTEGER NOT NULL DEFAULT 0, needs INTEGER NOT NULL DEFAULT 0, chat_id TEXT, about TEXT, data TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS feed_by_at ON feed (at);
      CREATE INDEX IF NOT EXISTS feed_by_chat ON feed (chat_id) WHERE chat_id IS NOT NULL;
    `);
  }

  /**
   * Keep an item. One from a chat is refused when that chat is off the record, as the sender says or as this person's
   * own sidebar row says (`known`, which may be newer): the strictest wins (mayLeave). The same ref again with the same
   * content changes nothing; with new content (a run that went on and sent) it replaces the item, unread again.
   */
  add(input: FeedInput, known: ChatKind | null = null, about?: string): FeedAdded {
    if (input.chat) {
      const kinds: (ChatKind | null)[] = [isChatKind(input.chat.kind) ? input.chat.kind : null];
      if (known) kinds.push(known);
      if (!mayLeave({ what: "feed" }, ...kinds)) return "refused";
    }
    const data: FeedData = {
      title: clip(input.title, MAX_FEED_TITLE),
      ...(input.text && { text: clip(input.text, MAX_FEED_TEXT) }),
      ...(input.from && { from: input.from }),
      open: input.open,
      ...(input.status && { status: input.status }),
    };
    const json = JSON.stringify(data);
    const needs = input.needsYou || NEEDS_YOU_KINDS.includes(input.kind) ? 1 : 0;
    const read = input.quiet ? 1 : 0;
    const chatId = input.chat?.id ?? (input.open.to === "chat" ? input.open.chatId : null);
    const before = this.#sql.exec("SELECT data FROM feed WHERE ref = ?", input.ref).toArray()[0] as { data: string } | undefined;
    if (before?.data === json) return "same";
    this.#sql.exec(
      `INSERT INTO feed (kind, ref, at, read, needs, chat_id, about, data) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(ref) DO UPDATE SET kind = excluded.kind, at = excluded.at, read = excluded.read, needs = excluded.needs,
         chat_id = excluded.chat_id, about = excluded.about, data = excluded.data`,
      input.kind,
      input.ref,
      input.at,
      read,
      needs,
      chatId,
      about ?? null,
      json,
    );
    if (!before) this.#prune();
    return before ? "updated" : "added";
  }

  /** The newest items, only the unread ones or only those needing the person when asked, and the counts. */
  list(filter: { unread?: boolean; needsYou?: boolean } = {}, limit = FEED_PAGE): FeedList {
    const where = [filter.unread && "read = 0", filter.needsYou && "needs = 1"].filter(Boolean);
    const rows = this.#sql
      .exec(`SELECT id, kind, at, read, needs, data FROM feed ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY at DESC, id DESC LIMIT ?`, limit)
      .toArray() as FeedRow[];
    return { items: rows.map(itemOf), ...this.counts() };
  }

  /** How many items are unread, and of those how many need the person: what the sidebar's entry shows. */
  counts(): { unread: number; needsYou: number } {
    const row = this.#sql.exec("SELECT COUNT(*) AS unread, COALESCE(SUM(needs), 0) AS needs FROM feed WHERE read = 0").toArray()[0];
    return { unread: Number(row?.unread ?? 0), needsYou: Number(row?.needs ?? 0) };
  }

  /** Mark items read (or unread again): by id, or every one. Returns how many changed. */
  mark(ids: readonly number[] | "all", read = true): number {
    const flag = read ? 1 : 0;
    if (ids === "all") return this.#sql.exec("UPDATE feed SET read = ? WHERE read != ?", flag, flag).rowsWritten;
    return this.#sql.exec("UPDATE feed SET read = ? WHERE read != ? AND id IN (SELECT value FROM json_each(?))", flag, flag, JSON.stringify(ids)).rowsWritten;
  }

  /** The person saw chat `chatId`: what its items told them of (tags, questions, runs posted there) is read. */
  markChatRead(chatId: string): number {
    return this.#sql.exec("UPDATE feed SET read = 1 WHERE chat_id = ? AND read = 0", chatId).rowsWritten;
  }

  /** What `ref` asked of the person was answered elsewhere (an agent's guesses confirmed by turning it on): read. */
  markRefRead(ref: string): number {
    return this.#sql.exec("UPDATE feed SET read = 1 WHERE ref = ? AND read = 0", ref).rowsWritten;
  }

  /** A chat is gone, or the person is out of it: its items go. */
  forgetChat(chatId: string): number {
    return this.#sql.exec("DELETE FROM feed WHERE chat_id = ?", chatId).rowsWritten;
  }

  /** A followed page or agent is gone, or no longer followed: its items go. */
  forgetAbout(about: string): number {
    return this.#sql.exec("DELETE FROM feed WHERE about = ?", about).rowsWritten;
  }

  /** At most MAX_FEED_ITEMS: the oldest read ones go first, then the oldest. */
  #prune(): void {
    this.#sql.exec("DELETE FROM feed WHERE id IN (SELECT id FROM feed ORDER BY read ASC, at DESC, id DESC LIMIT -1 OFFSET ?)", MAX_FEED_ITEMS);
  }
}

function itemOf(row: FeedRow): FeedItem {
  const data = JSON.parse(row.data) as FeedData;
  const flags = { ...(row.read === 1 && { read: true as const }), ...(row.needs === 1 && { needsYou: true as const }) };
  return { id: row.id, kind: row.kind, at: row.at, ...data, ...flags };
}

/** A follower of one of this person's pages or agents, and the chat that let them follow it (an agent's: it is shared there). */
export interface Follower {
  uid: string;
  via?: { ownerUid: string; chatId: string };
}

/** A follow as the follower keeps it: with whose the target is, which the app is never told. */
export interface FollowRecord extends FollowView {
  ownerUid: string;
  /** For an agent: the owner of the chat it is shared in (with `chatId`). */
  chatOwner?: string;
}

/**
 * Both sides of following, in each person's directory: `follows`, what this person follows (with whose it is), and
 * `followers`, who follows this person's pages and agents (with, for an agent, the chat it was followed from, which
 * must still share it for a post to reach them).
 */
export class FollowStore {
  readonly #sql: Sql;

  constructor(sql: Sql) {
    this.#sql = sql;
    sql.exec(`
      CREATE TABLE IF NOT EXISTS follows (kind TEXT NOT NULL, target_id TEXT NOT NULL, owner_uid TEXT NOT NULL, title TEXT NOT NULL,
        chat_owner TEXT, chat_id TEXT, at INTEGER NOT NULL, PRIMARY KEY (kind, target_id));
      CREATE TABLE IF NOT EXISTS followers (kind TEXT NOT NULL, target_id TEXT NOT NULL, follower_uid TEXT NOT NULL,
        chat_owner TEXT, chat_id TEXT, at INTEGER NOT NULL, PRIMARY KEY (kind, target_id, follower_uid));
    `);
  }

  /** Follow a target (again: its title and chat updated). Refused past MAX_FOLLOWS. */
  follow(record: Omit<FollowRecord, "at">, now = Date.now()): { ok: true } | { error: string } {
    const had = this.get(record.kind, record.id);
    if (!had && Number(this.#sql.exec("SELECT COUNT(*) AS n FROM follows").toArray()[0]?.n ?? 0) >= MAX_FOLLOWS) {
      return { error: `You follow ${MAX_FOLLOWS} pages and agents, the most there can be; stop following one first.` };
    }
    this.#sql.exec(
      `INSERT INTO follows (kind, target_id, owner_uid, title, chat_owner, chat_id, at) VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(kind, target_id) DO UPDATE SET owner_uid = excluded.owner_uid, title = excluded.title, chat_owner = excluded.chat_owner,
         chat_id = excluded.chat_id`,
      record.kind,
      record.id,
      record.ownerUid,
      record.title,
      record.chatOwner ?? null,
      record.chatId ?? null,
      had?.at ?? now,
    );
    return { ok: true };
  }

  /** Stop following; the follow as it was, or null when there was none. */
  unfollow(kind: FollowKind, id: string): FollowRecord | null {
    const had = this.get(kind, id);
    if (had) this.#sql.exec("DELETE FROM follows WHERE kind = ? AND target_id = ?", kind, id);
    return had;
  }

  get(kind: FollowKind, id: string): FollowRecord | null {
    const row = this.#sql.exec("SELECT * FROM follows WHERE kind = ? AND target_id = ?", kind, id).toArray()[0];
    return row ? followOf(row) : null;
  }

  /** Whether this person follows `owner`'s target: what an item from a follow is checked against when it comes in. */
  follows(kind: FollowKind, id: string, ownerUid: string): boolean {
    return this.#sql.exec("SELECT 1 FROM follows WHERE kind = ? AND target_id = ? AND owner_uid = ?", kind, id, ownerUid).toArray().length > 0;
  }

  /** What this person follows, newest first, as the app lists it (never whose it is). */
  list(): FollowView[] {
    return this.#sql
      .exec("SELECT * FROM follows ORDER BY at DESC")
      .toArray()
      .map((row) => {
        const { ownerUid: _owner, chatOwner: _chatOwner, ...view } = followOf(row);
        return view;
      });
  }

  /** A followed target's title changed (a page published under a new one), as an item from it says. */
  retitle(kind: FollowKind, id: string, ownerUid: string, title: string): boolean {
    const sql = "UPDATE follows SET title = ? WHERE kind = ? AND target_id = ? AND owner_uid = ? AND title != ?";
    return this.#sql.exec(sql, title, kind, id, ownerUid, title).rowsWritten > 0;
  }

  /** Someone follows one of this person's targets. Refused past MAX_FOLLOWERS. */
  addFollower(kind: FollowKind, id: string, follower: Follower, now = Date.now()): { ok: true } | { error: string } {
    const had = this.#sql.exec("SELECT 1 FROM followers WHERE kind = ? AND target_id = ? AND follower_uid = ?", kind, id, follower.uid).toArray().length > 0;
    if (!had && Number(this.#sql.exec("SELECT COUNT(*) AS n FROM followers WHERE kind = ? AND target_id = ?", kind, id).toArray()[0]?.n ?? 0) >= MAX_FOLLOWERS) {
      return { error: `This ${kind} has ${MAX_FOLLOWERS} followers, the most there can be.` };
    }
    this.#sql.exec(
      `INSERT INTO followers (kind, target_id, follower_uid, chat_owner, chat_id, at) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(kind, target_id, follower_uid) DO UPDATE SET chat_owner = excluded.chat_owner, chat_id = excluded.chat_id`,
      kind,
      id,
      follower.uid,
      follower.via?.ownerUid ?? null,
      follower.via?.chatId ?? null,
      now,
    );
    return { ok: true };
  }

  removeFollower(kind: FollowKind, id: string, uid: string): void {
    this.#sql.exec("DELETE FROM followers WHERE kind = ? AND target_id = ? AND follower_uid = ?", kind, id, uid);
  }

  followersOf(kind: FollowKind, id: string): Follower[] {
    return this.#sql
      .exec("SELECT follower_uid, chat_owner, chat_id FROM followers WHERE kind = ? AND target_id = ? ORDER BY at", kind, id)
      .toArray()
      .map((row) => ({
        uid: row.follower_uid as string,
        ...(row.chat_owner && row.chat_id ? { via: { ownerUid: row.chat_owner as string, chatId: row.chat_id as string } } : {}),
      }));
  }

  /** One of this person's targets is gone: its followers are forgotten, and returned, to be told. */
  dropTarget(kind: FollowKind, id: string): string[] {
    const uids = this.followersOf(kind, id).map((follower) => follower.uid);
    this.#sql.exec("DELETE FROM followers WHERE kind = ? AND target_id = ?", kind, id);
    return uids;
  }
}

function followOf(row: Record<string, unknown>): FollowRecord {
  return {
    kind: row.kind as FollowKind,
    id: row.target_id as string,
    ownerUid: row.owner_uid as string,
    title: row.title as string,
    ...(row.chat_id ? { chatId: row.chat_id as string } : {}),
    ...(row.chat_owner ? { chatOwner: row.chat_owner as string } : {}),
    at: row.at as number,
  };
}

/** Followers grouped by the chat that let them follow (an agent's), for one check per chat; those with none apart. */
export function byChat(followers: readonly Follower[]): { via?: Follower["via"]; uids: string[] }[] {
  const groups = new Map<string, { via?: Follower["via"]; uids: string[] }>();
  for (const follower of followers) {
    const key = follower.via ? `${follower.via.ownerUid}/${follower.via.chatId}` : "";
    const group = groups.get(key) ?? { ...(follower.via && { via: follower.via }), uids: [] };
    group.uids.push(follower.uid);
    groups.set(key, group);
  }
  return [...groups.values()];
}

/**
 * Whether what an agent's run reads may reach people who follow it: only when every server it may read is one it
 * shares with chats (its `sharedServers`, or when it names none, those that do not sign in each user), so a follower
 * reads nothing they could not have asked it for in the chat where it is shared. `servers` are the agent's own, absent
 * for every server of the deployment (`all`).
 */
export function postsReachFollowers(
  agent: { servers?: readonly string[]; sharedServers?: readonly string[] },
  all: readonly string[],
  signsIn: (server: string) => boolean,
): boolean {
  const reads = agent.servers ?? all;
  return reads.every((server) => (agent.sharedServers ? agent.sharedServers.includes(server) : !signsIn(server)));
}

/** What a fan-out needs: who may still read the target, and a way to hand one follower the item. */
export interface FanOutHost {
  /** Of `uids`, who followed an agent from the chat `via` and may still open it there (ChatAgent.followersIn). */
  stillIn(via: NonNullable<Follower["via"]>, uids: readonly string[]): Promise<string[]>;
  /** Hand the item to one follower's directory: false when they no longer follow the target. */
  deliver(uid: string): Promise<boolean>;
  /** Forget a follower who no longer follows it. */
  forget(uid: string): void;
}

/**
 * Hand one item to the followers of a target, `limit` directories at a time. A page's followers all get it: anyone
 * signed in may open a page. An agent's only where the chat each followed it from says they still may (`stillIn`);
 * one without such a chat gets nothing. A follower who no longer follows it is forgotten; a failed delivery is not.
 * Returns who got it.
 */
export async function fanOut(kind: FollowKind, followers: readonly Follower[], host: FanOutHost, limit = FAN_OUT): Promise<string[]> {
  const allowed =
    kind === "page"
      ? followers.map((follower) => follower.uid)
      : (
          await mapLimit(byChat(followers), limit, async ({ via, uids }) =>
            via ? (await host.stillIn(via, uids).catch(() => [] as string[])).filter((uid) => uids.includes(uid)) : [],
          )
        ).flat();
  const delivered = await mapLimit(allowed, limit, async (uid) => {
    const got = await host.deliver(uid).catch(() => null);
    if (got === false) host.forget(uid);
    return got ? uid : null;
  });
  return delivered.filter((uid) => uid !== null);
}

/** How many followers' directories (or chats checking them) one fan-out calls at a time. */
export const FAN_OUT = 8;

/**
 * Of `uids`, those who may follow `ownerUid`'s agent from a chat: the chat is there, the agent is on its roster as that
 * owner's and shared, and each is in the chat (not the owner, who needs no follow).
 */
export function followersAllowed(
  entry: { ownerUid: string; shared: boolean } | null,
  ownerUid: string,
  uids: readonly string[],
  inChat: (uid: string) => boolean,
): string[] {
  if (!entry || entry.ownerUid !== ownerUid || !entry.shared) return [];
  return uids.filter((uid) => uid !== ownerUid && inChat(uid));
}
