import type { CacheObserver } from "./mcp/hub.ts";
import type { EvictReason } from "./mcp/result-cache.ts";

/**
 * What the app records about its agents in Workers Analytics Engine (the optional `METRICS` binding), so that their
 * cost, speed and cache use can be asked with SQL. Without the binding every method does nothing.
 *
 * Every point has one index, its kind, and the same first blobs:
 *
 *   index1  kind: "cache" | "turn" | "run" | "router" | "funnel" | "budget"
 *   blob1   kind (again, so it can be selected beside the others)
 *   blob2   uid: the user the work is for (a chat's owner)
 *   blob3   chatId
 *   blob4   who: the agent's id, or the cache's owner ("pi", "pages", an agent's id), or the budget's scope
 *   blob5   detail: the turn's status, the run's outcome, the funnel's stage, the router's picked agent ids joined by ","
 *   blob6   more detail: the router's failure, else ""
 *
 * The doubles, by kind:
 *
 *   cache   1 hits, 2 misses, 3 evicted as expired, 4 evicted over share, 5 evicted as oldest, 6 evicted bytes
 *           (one point per owner per flush: the counts since the last one)
 *   turn    1 wall ms, 2 tokens, 3 cost USD, 4 tool calls, 5 by the owner (1/0), 6 unprompted (1/0), 7 cache bytes held
 *   run     1 wall ms, 2 cost USD, 3 items
 *   router  1 candidates, 2 picked, 3 ms, 4 failed (1/0)
 *   funnel  1 passed (1/0), 2 has a score (1/0), 3 score (0 when none)
 *   budget  1 tokens used, 2 USD used (one point when a budget runs out, once a day)
 *
 * For example, hits per owner for a day:
 *   SELECT blob4 AS owner, SUM(_sample_interval * double1) AS hits FROM <dataset>
 *   WHERE index1 = 'cache' AND timestamp > NOW() - INTERVAL '1' DAY GROUP BY owner
 *
 * Workers expose no CPU or memory reading to code: CPU time per invocation comes from Workers Observability. What is
 * recorded here is wall time, and the bytes the hub's read cache holds as the stand-in for memory.
 */

/** Cache events held in memory before they are written anyway, so that a long turn does not hold them all. */
const FLUSH_EVENTS = 200;
/** Analytics Engine takes at most 16 KB of blobs a point: no one blob may take much of that. */
const MAX_BLOB = 1_000;

interface CacheCounts {
  hits: number;
  misses: number;
  expired: number;
  overShare: number;
  oldest: number;
  evictedBytes: number;
}

/** A failing write is logged once per isolate, not once per point. */
let complained = false;

/**
 * One chat's metrics, as `base.uid` in `base.chatId`. The hub's cache events are counted here and written as one
 * point per owner on flush() (and after each turn and run), never one point per hit.
 */
export class Metrics implements CacheObserver {
  readonly #dataset: AnalyticsEngineDataset | undefined;
  readonly #base: { uid: string; chatId: string };
  readonly #cache = new Map<string, CacheCounts>();
  #events = 0;

  constructor(dataset: AnalyticsEngineDataset | undefined, base: { uid: string; chatId: string }) {
    this.#dataset = dataset;
    this.#base = base;
  }

  hit(owner: string): void {
    this.#count(owner, (counts) => counts.hits++);
  }

  miss(owner: string): void {
    this.#count(owner, (counts) => counts.misses++);
  }

  evict(owner: string, bytes: number, reason: EvictReason): void {
    this.#count(owner, (counts) => {
      if (reason === "expired") counts.expired++;
      else if (reason === "over-share") counts.overShare++;
      else counts.oldest++;
      counts.evictedBytes += bytes;
    });
  }

  /** One finished turn of an agent (or of pi), then the cache counts so far. */
  turn(t: {
    agent: string;
    status: string;
    wallMs: number;
    tokens: number;
    costUsd: number;
    toolCalls: number;
    byOwner: boolean;
    unprompted?: boolean;
    cacheBytes: number;
  }): void {
    this.#write("turn", t.agent, t.status, "", [t.wallMs, t.tokens, t.costUsd, t.toolCalls, flag(t.byOwner), flag(t.unprompted), t.cacheBytes]);
    this.flush();
  }

  /** One finished scheduled or watched run, then the cache counts so far. */
  run(r: { agent: string; outcome: string; wallMs: number; costUsd: number; items: number }): void {
    this.#write("run", r.agent, r.outcome, "", [r.wallMs, r.costUsd, r.items]);
    this.flush();
  }

  /** One pick of which agents answer a message: the agent ids picked, out of how many, how long it took, and why it failed. */
  router(r: { picked: readonly string[]; candidates: number; ms: number; failed?: string }): void {
    this.#write("router", "", r.picked.join(","), r.failed ?? "", [r.candidates, r.picked.length, r.ms, flag(r.failed !== undefined)]);
  }

  /** One stage an agent's unprompted turn went through ("gates" or "gates:<refusal>", "interest", "turn"), and whether it passed. */
  funnel(f: { agent: string; stage: string; passed: boolean; score?: number }): void {
    this.#write("funnel", f.agent, f.stage, "", [flag(f.passed), flag(f.score !== undefined), f.score ?? 0]);
  }

  /** A chat's or a user's budget ran out today (one point a day each), and what was used by then. */
  budget(b: { scope: "chat" | "user"; usedTokens?: number; usedUsd?: number }): void {
    this.#write("budget", b.scope, "capped", "", [b.usedTokens ?? 0, b.usedUsd ?? 0]);
  }

  /** Write the cache counts since the last flush, one point per owner. */
  flush(): void {
    for (const [owner, c] of this.#cache) this.#write("cache", owner, "", "", [c.hits, c.misses, c.expired, c.overShare, c.oldest, c.evictedBytes]);
    this.#cache.clear();
    this.#events = 0;
  }

  #count(owner: string, add: (counts: CacheCounts) => void): void {
    if (!this.#dataset) return;
    let counts = this.#cache.get(owner);
    if (!counts) this.#cache.set(owner, (counts = { hits: 0, misses: 0, expired: 0, overShare: 0, oldest: 0, evictedBytes: 0 }));
    add(counts);
    if (++this.#events >= FLUSH_EVENTS) this.flush();
  }

  #write(kind: string, who: string, detail: string, more: string, doubles: number[]): void {
    if (!this.#dataset) return;
    const blobs = [kind, this.#base.uid, this.#base.chatId, who, detail, more].map((blob) => blob.slice(0, MAX_BLOB));
    try {
      this.#dataset.writeDataPoint({ indexes: [kind], blobs, doubles: doubles.map((n) => (Number.isFinite(n) ? n : 0)) });
    } catch (error) {
      // Metrics never break what they measure.
      if (!complained) console.error("Writing a metrics point failed:", error);
      complained = true;
    }
  }
}

const flag = (value: boolean | undefined) => (value ? 1 : 0);
