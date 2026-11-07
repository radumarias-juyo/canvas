import { describe, expect, it } from "vitest";
import { MAX_TOOL_RESULTS, TOOL_RESULT_MS, TOOL_RESULTS, ToolResults } from "../worker/storage/tool-results.ts";
import { UserFiles } from "../worker/storage/user-files.ts";
import { FakeBucket } from "./fakes.ts";

const KEY = new Uint8Array(32).fill(1).buffer;
const T0 = Date.parse("2026-11-07T10:00:00Z");

function setup() {
  const bucket = new FakeBucket();
  const clock = { now: T0 };
  bucket.clock = () => clock.now;
  return { bucket, clock, results: new ToolResults(bucket.r2, "olga", "chat1", KEY, () => clock.now), files: new UserFiles(bucket.r2, "olga", KEY) };
}

/** The text saved at `path`, null for none. */
async function text(results: ToolResults, path: string): Promise<string | null> {
  return (await results.get(path))?.text() ?? null;
}

describe("ToolResults", () => {
  it("keeps a result outside the owner's files, encrypted, and reads it back by the path it gave", async () => {
    const { bucket, results, files } = setup();
    const path = await results.put("crm/list deals", "x".repeat(40_000));
    expect(path).toMatch(new RegExp(`^${TOOL_RESULTS}crm_list_deals-[0-9a-f]{16}\\.txt$`));
    expect(await text(results, path)).toBe("x".repeat(40_000));
    // Never in a listing of the owner's files, nor in their folder.
    expect(await files.list()).toEqual([]);
    expect([...bucket.objects.keys()].every((key) => key.startsWith("users/olga/tool-results/chat1/"))).toBe(true);
    expect(bucket.calls.filter((call) => call.op === "put").every((call) => call.ssecKey === KEY)).toBe(true);
  });

  it("is one file for the same result read again, and reads no path outside its own", async () => {
    const { bucket, results } = setup();
    const a = await results.put("tool", "same");
    expect(await results.put("tool", "same")).toBe(a);
    expect(bucket.objects.size).toBe(1);
    expect(await text(results, `${TOOL_RESULTS}../files/uploads/q3.csv`)).toBeNull();
    expect(await text(results, `${TOOL_RESULTS}tool-0123456789abcdef.txt`)).toBeNull();
    // Only by the path put gave: not by its bare name.
    expect(await text(results, a.slice(TOOL_RESULTS.length))).toBeNull();
  });

  it("keeps at most MAX_TOOL_RESULTS a chat, the newest, and none older than TOOL_RESULT_MS", async () => {
    const { bucket, clock, results } = setup();
    const paths: string[] = [];
    for (let i = 0; i < MAX_TOOL_RESULTS + 5; i++) {
      clock.now += 1_000;
      paths.push(await results.put("tool", `result ${i}`));
    }
    expect(bucket.objects.size).toBe(MAX_TOOL_RESULTS);
    expect(await text(results, paths[0])).toBeNull();
    expect(await text(results, paths.at(-1)!)).toBe(`result ${MAX_TOOL_RESULTS + 4}`);
    clock.now += TOOL_RESULT_MS + 1;
    const fresh = await results.put("tool", "new");
    expect([...bucket.objects.keys()]).toEqual([`users/olga/tool-results/chat1/${fresh.slice(TOOL_RESULTS.length)}`]);
  });

  it("drops every result of the chat, and only its own", async () => {
    const { bucket, results } = setup();
    await results.put("tool", "a");
    await new ToolResults(bucket.r2, "olga", "chat2", KEY).put("tool", "b");
    await results.deleteAll();
    expect([...bucket.objects.keys()].map((key) => key.split("/")[3])).toEqual(["chat2"]);
  });
});
