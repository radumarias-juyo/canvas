import { withCache } from "../../shared/canonical.ts";
import type { CallToolResult } from "../../shared/protocol.ts";

export interface CachedResult {
  result: CallToolResult;
  /** When the result was produced upstream (epoch ms). */
  storedAt: number;
}

interface Entry extends CachedResult {
  /** About how much memory the result holds: its JSON length. */
  bytes: number;
  /** Who stored it: an agent's id, "pi", "pages", or "" when nobody said. */
  owner: string;
}

/** Why an entry left the cache to make room: it was past its lifetime, its owner held more than its share, or it was the oldest. */
export type EvictReason = "expired" | "over-share" | "oldest";

/** What one owner holds in the cache. */
export interface OwnerStats {
  bytes: number;
  entries: number;
}

export interface ResultCacheOptions {
  /** The least share of the budget each owner may keep, however many owners there are. */
  floorBytes?: number;
  /** Told of each entry that leaves the cache to make room (not of one replaced by a newer result for its key). */
  onEvict?(owner: string, bytes: number, reason: EvictReason): void;
}

/** An owner's share never falls below this, so that one busy chat with many agents still keeps something for each. */
const DEFAULT_FLOOR_BYTES = 1024 * 1024;

/**
 * Tool results by key, within a byte budget. Callers decide how young a result must be; entries older than
 * `lifetimeMs` only go first when room is needed.
 *
 * Each entry has an owner (whoever stored it), and each owner a share of the budget: the budget split evenly between
 * the owners holding entries and the one storing now, but never less than the floor. When a result needs room, expired
 * entries go first, then the oldest entries of whoever is most over its share, and only when nobody is over its share
 * the oldest entry overall. So one busy agent pushes out its own results before another's.
 */
export class ResultCache {
  readonly #entries = new Map<string, Entry>();
  readonly #owners = new Map<string, OwnerStats>();
  #bytes = 0;
  readonly #maxBytes: number;
  readonly #lifetimeMs: number;
  readonly #floorBytes: number;
  readonly #onEvict: ResultCacheOptions["onEvict"];
  readonly #now: () => number;

  constructor(maxBytes: number, lifetimeMs: number, now: () => number = Date.now, { floorBytes = DEFAULT_FLOOR_BYTES, onEvict }: ResultCacheOptions = {}) {
    this.#maxBytes = maxBytes;
    this.#lifetimeMs = lifetimeMs;
    this.#floorBytes = floorBytes;
    this.#onEvict = onEvict;
    this.#now = now;
  }

  get(key: string): CachedResult | undefined {
    return this.#entries.get(key);
  }

  /**
   * The result younger than `staleMs`, stamped as served from the cache, and when it goes stale. Never one for a
   * `staleMs` of 0, even when `storedAt` is ahead of this clock (it may come from another machine's).
   */
  fresh(key: string, staleMs: number): (CachedResult & { nextRefreshAt: number }) | undefined {
    const hit = this.#entries.get(key);
    if (!hit || staleMs <= 0 || this.#now() - hit.storedAt >= staleMs) return undefined;
    return { result: withCache(hit.result, hit.storedAt, false), storedAt: hit.storedAt, nextRefreshAt: hit.storedAt + staleMs };
  }

  /**
   * Keep a result within the budget, as `owner`'s. Entries are re-inserted on every store, so the map runs oldest first,
   * and each owner's entries in it too. A result bigger than the whole budget is not kept.
   */
  set(key: string, { result, storedAt }: CachedResult, owner = ""): void {
    this.#remove(key);
    const bytes = JSON.stringify(result).length;
    if (bytes > this.#maxBytes) return;
    const fits = () => this.#bytes + bytes <= this.#maxBytes;
    const now = this.#now();
    for (const [k, e] of this.#entries) {
      if (fits()) break;
      if (now - e.storedAt > this.#lifetimeMs) this.#evict(k, "expired");
    }
    while (!fits()) {
      const over = this.#mostOverShare(owner, bytes);
      const victim = over === undefined ? this.#entries.keys().next().value : this.#oldestOf(over);
      if (victim === undefined) break;
      this.#evict(victim, over === undefined ? "oldest" : "over-share");
    }
    this.#entries.set(key, { result, storedAt, bytes, owner });
    this.#bytes += bytes;
    const held = this.#owners.get(owner) ?? { bytes: 0, entries: 0 };
    this.#owners.set(owner, { bytes: held.bytes + bytes, entries: held.entries + 1 });
  }

  /** What each owner holds now. */
  stats(): Map<string, OwnerStats> {
    return new Map([...this.#owners].map(([owner, held]) => [owner, { ...held }]));
  }

  /**
   * The owner holding entries that is furthest over its share, counting the result `storing` is about to add as its own,
   * or undefined when nobody is over. Shares are worked out afresh each time, as owners whose last entry went drop out.
   */
  #mostOverShare(storing: string, bytes: number): string | undefined {
    const active = this.#owners.size + (this.#owners.has(storing) ? 0 : 1);
    const share = Math.max(this.#floorBytes, this.#maxBytes / active);
    let most: string | undefined;
    let mostOver = 0;
    for (const [owner, held] of this.#owners) {
      const over = held.bytes + (owner === storing ? bytes : 0) - share;
      if (over > mostOver) [most, mostOver] = [owner, over];
    }
    return most;
  }

  #oldestOf(owner: string): string | undefined {
    for (const [k, e] of this.#entries) if (e.owner === owner) return k;
    return undefined;
  }

  #evict(key: string, reason: EvictReason): void {
    const entry = this.#remove(key);
    if (entry) this.#onEvict?.(entry.owner, entry.bytes, reason);
  }

  #remove(key: string): Entry | undefined {
    const entry = this.#entries.get(key);
    if (!entry) return undefined;
    this.#entries.delete(key);
    this.#bytes -= entry.bytes;
    const held = this.#owners.get(entry.owner)!;
    if (held.entries === 1) this.#owners.delete(entry.owner);
    else this.#owners.set(entry.owner, { bytes: held.bytes - entry.bytes, entries: held.entries - 1 });
    return entry;
  }
}
