import type { EntryRecord } from "@earendil-works/pi-durable";
import { describe, expect, it } from "vitest";
import { CHAT_AGENT_KIND, CHAT_HISTORY_TOOL, CHAT_TURN_KIND } from "../shared/agents.ts";
import { CHAT_MESSAGE_KIND } from "../shared/protocol.ts";
import type { McpToolInfo } from "../worker/agent/mcp.ts";
import { historyExtension, historyQuery, searchHistory, type HistoryQuery, type HistoryReader } from "../worker/agents/history.ts";
import { allowedTools, runTools } from "../worker/agents/turns.ts";

const RADU = { uid: "radu", name: "Radu" };
const ANA = { uid: "ana", name: "Ana" };
const T0 = Date.UTC(2026, 10, 7, 9, 0);

/** A chat's log, oldest first: people's messages, agents' replies, and what the history never shows. */
function chatLog(): EntryRecord[] {
  const entries: object[] = [];
  const at = (n: number) => T0 + n * 60_000;
  const say = (who: { uid: string; name: string }, text: string) => ({ kind: CHAT_MESSAGE_KIND, data: { ...who, text, sentAt: at(entries.length) } });
  const reply = (agentId: string, name: string, ownerUid: string, text: string) => ({
    kind: CHAT_AGENT_KIND,
    data: { agentId, name, ownerUid, text, turn: entries.length, endedAt: at(entries.length), calledBy: { name: "Radu" } },
  });
  entries.push(say(RADU, "We need last quarter's signups by region."));
  entries.push(reply("r1", "research", RADU.uid, "Q3 has 41,200 signups in 7 regions."));
  entries.push({ kind: CHAT_TURN_KIND, data: { turn: 1, calledBy: { name: "Radu" }, hop: 0 } });
  entries.push({ kind: "chat.action", data: { action: { id: "x", tool: "update_deal" } } });
  entries.push(say(ANA, "Does North match the August campaign?"));
  entries.push(reply("p1", "planner", ANA.uid, "Mostly: the week 34 spike is the campaign."));
  entries.push(say(RADU, "Thanks, the signups look right."));
  return entries.map((entry, id) => ({ id, conversationId: 0, ...entry }) as unknown as EntryRecord);
}

/** The log as the chat object pages it: newest first, within the query's range. */
async function* pagesOf(log: readonly EntryRecord[], query: Pick<HistoryQuery, "after" | "before">, size = 2) {
  const inRange = log.filter((entry) => (query.before === undefined || entry.id < query.before) && (query.after === undefined || entry.id > query.after));
  const newest = [...inRange].reverse();
  for (let i = 0; i < newest.length; i += size) yield newest.slice(i, i + size);
}

const search = (query: Partial<HistoryQuery>, reader: HistoryReader = { self: "r1", owner: RADU.uid }, log = chatLog()) => {
  const full = historyQuery(query);
  return searchHistory(pagesOf(log, full), full, reader);
};

describe("chat_history", () => {
  it("lists what was said, newest first, labelled as the catch-ups label it, with each entry's number and time", async () => {
    const text = await search({});
    expect(text).toMatch(/^5 entries of the chat, newest first:/);
    const lines = text.split("\n\n").slice(1);
    expect(lines.map((line) => line.split(" ")[0])).toEqual(["#6", "#5", "#4", "#1", "#0"]);
    // Only its owner's lines are marked as theirs; its own reply shows too, which its catch-ups leave out.
    expect(lines[0]).toBe("#6 2026-11-07 09:06 [Radu · person · your owner]: Thanks, the signups look right.");
    expect(lines[2]).toContain("[Ana · person]: Does North");
    expect(lines[3]).toContain("[research · agent]: Q3 has 41,200");
    // Turn inputs and held actions never show.
    expect(text).not.toContain("update_deal");
  });

  it("marks a member's agent's owner as theirs only from where it joined, and Radu as a person", async () => {
    const text = await search({}, { self: "p1", owner: { uid: ANA.uid, chatOwner: RADU.uid, from: 3 } });
    expect(text).toContain("[Ana · person · your owner]: Does North");
    expect(text).toContain("[Radu · person]: Thanks");
    expect(text).not.toContain("Radu · person · your owner");
  });

  it("narrows by words and by who said it, a person by name or an agent by its handle", async () => {
    expect(await search({ text: "SIGNUPS" })).toMatch(/^3 entries of the chat matching "SIGNUPS"/);
    const byAna = await search({ author: "ana" });
    expect(byAna).toMatch(/^1 entry of the chat matching by ana/);
    expect(await search({ author: "@planner" })).toContain("#5");
    expect(await search({ author: "nobody" })).toBe("No entries of the chat match by nobody in this range.");
  });

  it("pages back with before, never repeating an entry, and keeps within after", async () => {
    const first = await search({ limit: 2 });
    expect(first).toContain("call again with before: 5");
    const second = await search({ limit: 2, before: 5 });
    expect(second.split("\n\n").slice(1, 3).map((line) => line.split(" ")[0])).toEqual(["#4", "#1"]);
    const last = await search({ limit: 2, before: 1 });
    expect(last).toMatch(/^1 entry/);
    expect(last).not.toContain("call again");
    expect((await search({ after: 4 })).split("\n\n").slice(1).map((line) => line.split(" ")[0])).toEqual(["#6", "#5"]);
  });

  it("cuts a long message and stops before the lines grow too long, saying where to go on", async () => {
    const long = "x".repeat(5_000);
    const log = Array.from({ length: 30 }, (_, id) => ({ id, conversationId: 0, kind: CHAT_MESSAGE_KIND, data: { ...ANA, text: long } }) as unknown as EntryRecord);
    const text = await search({ limit: 50 }, undefined, log);
    expect(text).toContain("… (cut)");
    expect(text.length).toBeLessThan(30_000);
    const next = /before: (\d+)/.exec(text)?.[1];
    const shown = text.split("\n\n").slice(1, -1);
    expect(Number(next)).toBe(Number(shown.at(-1)!.split(" ")[0].slice(1)));
  });

  it("refuses arguments that are not a search", () => {
    expect(() => historyQuery({ limit: 0 })).toThrow("limit is 1 to 50");
    expect(() => historyQuery({ before: -1 })).toThrow("the number (#) of an entry");
    expect(() => historyQuery({ text: "x".repeat(201) })).toThrow("at most 200");
    expect(historyQuery({ text: "  ", author: "@pi" })).toEqual({ author: "pi", limit: 20 });
  });

  it("asks the chat for the conversation the tool runs in", async () => {
    const asked: [string, HistoryQuery][] = [];
    const tool = historyExtension({
      history: async (session, query) => {
        asked.push([session, query]);
        return "found";
      },
    }).tools!.find((one) => one.name === CHAT_HISTORY_TOOL)!;
    const run = tool.execute as unknown as (args: unknown, api: unknown) => Promise<{ output: { text: string }[] }>;
    const result = await run({ text: "signups", before: 9 }, { conversationId: 7 });
    expect(result.output[0].text).toBe("found");
    expect(asked).toEqual([["7", { text: "signups", before: 9, limit: 20 }]]);
  });

  it("is a read tool every turn may use, but no run: a run's report reaches other chats", () => {
    const tools = ["artifact_read", CHAT_HISTORY_TOOL, "files_write"];
    const mcp = new Map<string, McpToolInfo>();
    expect(allowedTools(tools, mcp, {}, false, () => false, { unprompted: true })).toContain(CHAT_HISTORY_TOOL);
    expect(runTools(tools, mcp, {})).toEqual(["artifact_read"]);
  });
});
