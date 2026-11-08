// A person's daily allowance as the composer's ring shows it: what their model calls cost today (UTC), in real dollars
// as each answer reported them, against the deployment's daily limit for them. The limit stops their scheduled runs
// and their agents' unprompted posts for the day; their own messages go on. Pages' model calls (pi.use("ai")) have an
// allowance of their own, paid by whoever types.

/** GET /api/me/allowance. `limit` 0: the deployment sets none (the ring then shows no share, only the spend). */
export interface Allowance {
  /** The UTC day it counts, as YYYY-MM-DD. */
  day: string;
  /** Model calls in the person's own chats (pi's, their agents', their runs'): dollars today, and tokens. */
  spent: number;
  tokens: number;
  /** RUNS_DAILY_USD. */
  limit: number;
  /** Pages' model calls they typed into, and PAGE_AI_DAILY_USD. */
  pages: { spent: number; limit: number };
}

/** How the ring reads: how much of the limit is used (0 to 1), and its tone ("" under 60%, high from 60%, full at the limit). */
export interface AllowanceLevel {
  share: number;
  percent: number;
  level: "" | "high" | "full";
  /** What is left of the limit, in dollars (0 past it). */
  left: number;
}

/** A limit read from the environment as dollars: a positive finite number, else 0 (none). */
export function dollars(value: unknown): number {
  const n = typeof value === "string" ? Number(value) : typeof value === "number" ? value : NaN;
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/** How full today's allowance is; with no limit, nothing to fill (share 0). */
export function allowanceLevel(spent: number, limit: number): AllowanceLevel {
  if (!(limit > 0)) return { share: 0, percent: 0, level: "", left: 0 };
  const share = Math.min(1, Math.max(0, spent) / limit);
  return { share, percent: Math.round(share * 100), level: spent >= limit ? "full" : share >= 0.6 ? "high" : "", left: Math.max(0, limit - spent) };
}

/**
 * What the ring's panel says of the limit, after what was spent: how much is left and what stops at it, or that it is
 * reached; "" without a limit. `resets`: when it starts again, as the viewer reads a time.
 */
export function limitNote(spent: number, limit: number, resets: string): string {
  if (!(limit > 0)) return "";
  const { level, left } = allowanceLevel(spent, limit);
  return level === "full"
    ? `The limit is reached: your agents' scheduled runs and unprompted posts wait until ${resets}. Your own messages still go.`
    : `$${left.toFixed(2)} left before your agents' scheduled runs and unprompted posts pause; your own messages never do. It starts again at ${resets}.`;
}

/** When today's allowance starts again: the next UTC midnight after `now`. */
export function resetsAt(now: number): number {
  const day = new Date(now);
  return Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate() + 1);
}
