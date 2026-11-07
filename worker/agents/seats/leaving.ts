// A member's agent leaves a room (removed by its owner or the room's, its owner leaves, the room is deleted, the agent
// is deleted): its seat object for that room (one per agent and room: seatChatId) is cleaned up. The room keeps what
// it must ask the seat to do in an outbox until the seat says it is done, so a seat object that cannot be reached is
// asked again later; the seat's side is idempotent, so asking twice does no harm.
//
// What stays: what reached the room. The pages and files the agent's replies posted there are the member's own (their
// sidebar lists them, followers may have them, people in the room open them from its log), so they are kept. What
// goes: everything else the seat object holds for the room, which nobody else ever saw: its pages and files no posted
// reply named, its drafts, saved tool results, sandbox, its seat rows, and the actions it held, which expire.

import type { EntryRecord } from "@earendil-works/pi-durable";
import { CHAT_AGENT_KIND, type ChatAgentReplyData } from "../../../shared/agents.ts";
import type { Sql } from "../../members.ts";

/** What a seat keeps when it leaves its room: the pages and files the agent's replies posted there. */
export interface SeatKeeps {
  pages: string[];
  files: string[];
}

/** The pages and files the replies of `ownerUid`'s agent `agentId` posted, from the room's log (any order). */
export function postedBy(entries: Iterable<Pick<EntryRecord, "kind" | "data">>, agentId: string, ownerUid: string, into: SeatKeeps = { pages: [], files: [] }): SeatKeeps {
  const pages = new Set(into.pages);
  const files = new Set(into.files);
  for (const entry of entries) {
    if (entry.kind !== CHAT_AGENT_KIND) continue;
    const reply = entry.data as unknown as Partial<ChatAgentReplyData>;
    if (reply.agentId !== agentId || reply.ownerUid !== ownerUid) continue;
    for (const page of reply.published ?? []) if (typeof page?.artifactId === "string") pages.add(page.artifactId);
    for (const path of reply.saved ?? []) if (typeof path === "string") files.add(path);
  }
  return { pages: [...pages], files: [...files] };
}

/**
 * What a seat object removes when its last seat left: of what its sessions made (`made`: the artifacts it published and
 * the files it saved, as its traces say), those `keeps` does not name. Its drafts, saved results and sandbox go whole.
 */
export function seatLeftovers(made: SeatKeeps, keeps: SeatKeeps): SeatKeeps {
  const pages = new Set(keeps.pages);
  const files = new Set(keeps.files);
  return { pages: made.pages.filter((id) => !pages.has(id)), files: made.files.filter((path) => !files.has(path)) };
}

/** How long the room waits before asking a seat again, after `attempts` failed asks: longer each time, at most an hour. */
export function leaveRetryMs(attempts: number): number {
  return Math.min(60 * 60_000, 30_000 * 2 ** Math.max(0, attempts - 1));
}

/** One seat a room still has to clean up: whose agent, its seat object, and what it keeps. */
export interface SeatLeave {
  ownerUid: string;
  agentId: string;
  seat: string;
  keeps: SeatKeeps;
  attempts: number;
}

type LeaveRow = { owner_uid: string; agent_id: string; seat: string; keeps: string; attempts: number };

/** The room's outbox of seats to clean up (chat_seat_leaves): a row stays until its seat said it is done. */
export class SeatLeaves {
  readonly #sql: Sql;

  constructor(sql: Sql) {
    this.#sql = sql;
    sql.exec(`
      CREATE TABLE IF NOT EXISTS chat_seat_leaves (
        owner_uid TEXT NOT NULL, agent_id TEXT NOT NULL, seat TEXT NOT NULL, keeps TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (owner_uid, agent_id, seat)
      );
    `);
  }

  /** A seat to clean up, with what it keeps (a second leave of it keeps the newer list, and asks again from the start). */
  add(leave: Omit<SeatLeave, "attempts">): void {
    this.#sql.exec(
      `INSERT INTO chat_seat_leaves (owner_uid, agent_id, seat, keeps, attempts) VALUES (?, ?, ?, ?, 0)
       ON CONFLICT(owner_uid, agent_id, seat) DO UPDATE SET keeps = excluded.keeps, attempts = 0`,
      leave.ownerUid,
      leave.agentId,
      leave.seat,
      JSON.stringify(leave.keeps),
    );
  }

  list(): SeatLeave[] {
    return (this.#sql.exec("SELECT * FROM chat_seat_leaves ORDER BY attempts, seat").toArray() as LeaveRow[]).map((row) => ({
      ownerUid: row.owner_uid,
      agentId: row.agent_id,
      seat: row.seat,
      keeps: JSON.parse(row.keeps) as SeatKeeps,
      attempts: row.attempts,
    }));
  }

  /** The seat said it is done: the row goes. */
  done(leave: Pick<SeatLeave, "ownerUid" | "agentId" | "seat">): void {
    this.#sql.exec("DELETE FROM chat_seat_leaves WHERE owner_uid = ? AND agent_id = ? AND seat = ?", leave.ownerUid, leave.agentId, leave.seat);
  }

  /** Asking it failed: counted, for the wait before the next ask (leaveRetryMs). The attempts now. */
  failed(leave: Pick<SeatLeave, "ownerUid" | "agentId" | "seat">): number {
    const [row] = this.#sql
      .exec(
        "UPDATE chat_seat_leaves SET attempts = attempts + 1 WHERE owner_uid = ? AND agent_id = ? AND seat = ? RETURNING attempts",
        leave.ownerUid,
        leave.agentId,
        leave.seat,
      )
      .toArray();
    return (row?.attempts as number | undefined) ?? 0;
  }

  /**
   * Ask each seat in the outbox to clean up (`ask`), one after another; a seat that answers is done, one that fails is
   * counted. The wait before the next round (leaveRetryMs of the fewest attempts left), or undefined once none is left.
   */
  async flush(ask: (leave: SeatLeave) => Promise<void>): Promise<number | undefined> {
    let next: number | undefined;
    for (const leave of this.list()) {
      try {
        await ask(leave);
        this.done(leave);
      } catch (error) {
        const wait = leaveRetryMs(this.failed(leave));
        next = next === undefined ? wait : Math.min(next, wait);
        console.error("agent seat, leave:", error instanceof Error ? error.message : String(error));
      }
    }
    return next;
  }
}
