import { describe, expect, it } from "vitest";
import type { CallToolResult } from "../shared/protocol.ts";
import { ResultCache, type EvictReason } from "../worker/mcp/result-cache.ts";

// A result whose JSON is exactly `bytes` long, which is what the cache counts it as.
function sized(bytes: number): CallToolResult {
  const pad = bytes - JSON.stringify({ content: [{ type: "text", text: "" }] }).length;
  return { content: [{ type: "text", text: "x".repeat(pad) }] };
}

// A 1,000-byte cache whose entries expire after a minute, with its evictions noted and a clock the test moves.
function cache({ floorBytes = 0 } = {}) {
  const clock = { now: 0 };
  const evicted: [string, number, EvictReason][] = [];
  const results = new ResultCache(1_000, 60_000, () => clock.now, { floorBytes, onEvict: (...event) => evicted.push(event) });
  const put = (key: string, bytes: number, owner: string) => results.set(key, { result: sized(bytes), storedAt: clock.now }, owner);
  const kept = () => [...results.stats()].map(([owner, { bytes }]) => [owner, bytes]);
  return { clock, evicted, results, put, kept };
}

describe("ResultCache", () => {
  it("makes room from expired entries first, even when another owner is over its share", () => {
    const { clock, evicted, results, put } = cache();
    put("b1", 200, "b");
    clock.now = 50_000;
    put("a1", 300, "a");
    put("a2", 300, "a");
    clock.now = 70_000;
    put("b2", 300, "b"); // a holds 600 of a 500 share, but b1 is past its lifetime
    expect(evicted).toEqual([["b", 200, "expired"]]);
    expect(results.get("a1")).toBeDefined();
  });

  it("keeps expired entries while there is room", () => {
    const { clock, evicted, results, put } = cache();
    put("a1", 300, "a");
    clock.now = 120_000;
    put("a2", 300, "a");
    expect(evicted).toEqual([]);
    expect(results.get("a1")).toBeDefined();
  });

  it("takes the oldest entries of the owner most over its share before anyone else's", () => {
    const { evicted, results, put, kept } = cache();
    put("b1", 100, "b"); // the oldest entry of all
    put("a1", 300, "a");
    put("a2", 300, "a");
    put("a3", 300, "a");
    put("b2", 400, "b"); // needs 400: a, at 900 of a 500 share, gives up a1, then (still over) a2
    expect(evicted).toEqual([
      ["a", 300, "over-share"],
      ["a", 300, "over-share"],
    ]);
    expect(results.get("b1")).toBeDefined();
    expect(results.get("a3")).toBeDefined();
    expect(kept()).toEqual([
      ["b", 500],
      ["a", 300],
    ]);
  });

  it("counts the result being stored as its owner's, so a busy owner makes room from its own entries", () => {
    const { evicted, results, put } = cache();
    put("b1", 300, "b");
    put("a1", 300, "a");
    put("a2", 300, "a");
    put("a3", 300, "a"); // a would hold 900 of a 500 share
    expect(evicted).toEqual([["a", 300, "over-share"]]);
    expect(results.get("b1")).toBeDefined();
  });

  it("takes the oldest entry of all when nobody holding entries is over its share", () => {
    const { evicted, results, put } = cache();
    put("a1", 250, "a");
    put("a2", 250, "a");
    put("b1", 600, "b"); // only b is over, and it holds nothing yet
    expect(evicted).toEqual([["a", 250, "oldest"]]);
    expect(results.get("a2")).toBeDefined();
  });

  it("never splits shares below the floor", () => {
    const fill = (floorBytes: number) => {
      const c = cache({ floorBytes });
      c.put("b1", 100, "b"); // the oldest entry of all
      c.put("a1", 290, "a");
      c.put("c1", 100, "c");
      c.put("d1", 250, "d");
      c.put("e1", 300, "e"); // five owners: 200 each, or the floor
      return c.evicted;
    };
    // With a 300-byte floor nobody holding entries is over its share, so the oldest entry goes; without one, a is over.
    expect(fill(300)).toEqual([["b", 100, "oldest"]]);
    expect(fill(0)).toEqual([["a", 290, "over-share"]]);
  });

  it("does not keep a result bigger than the whole budget, nor make room for it", () => {
    const { evicted, results, put } = cache();
    put("a1", 500, "a");
    put("b1", 1_001, "b");
    expect(results.get("b1")).toBeUndefined();
    expect(evicted).toEqual([]);
  });

  it("counts what each owner holds, and a replaced result is not an eviction", () => {
    const { evicted, results, put } = cache();
    put("k", 300, "a");
    put("k", 200, "b");
    put("j", 100, "b");
    results.set("old", { result: sized(100), storedAt: 0 });
    expect(evicted).toEqual([]);
    expect(results.stats()).toEqual(
      new Map([
        ["b", { bytes: 300, entries: 2 }],
        ["", { bytes: 100, entries: 1 }],
      ]),
    );
  });
});
