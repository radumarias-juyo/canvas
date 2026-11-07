import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  CHAT_CHECKLIST_KIND,
  checkChecklist,
  CHECKLIST_ID_PATTERN,
  checklistAt,
  checklistEntry,
  ChecklistError,
  foldChecklists,
  MAX_CHECKLIST_STEPS,
  MAX_NOTE_CHARS,
  MAX_STEP_CHARS,
  MAX_TITLE_CHARS,
  newChecklistId,
  type ChatChecklistData,
  type ChecklistInput,
  type ChecklistStep,
} from "../shared/checklist.ts";
import { CHECKLIST_TOOL, checklistExtension, type ChecklistScope } from "../worker/agent/checklist.ts";
import { ChecklistCard, countLine } from "../src/chat/ChecklistCard.tsx";
import { inReply } from "../src/chat/entries.ts";
import { stepRuns } from "../src/chat/stepRuns.ts";

const PI = { name: "pi" };
const RESEARCH = { name: "research", agentId: "0123456789abcdef", avatar: "Re", color: "teal" as const };
const steps = (...statuses: ChecklistStep["status"][]): ChecklistStep[] => statuses.map((status, i) => ({ text: `Stage ${i + 1}`, status }));
const entry = (id: number, data: ChatChecklistData) => ({ id, kind: CHAT_CHECKLIST_KIND, data });

describe("checkChecklist", () => {
  it("trims the title, the steps and their notes to one line each, and drops empty notes", () => {
    const checked = checkChecklist({
      title: "  Quarterly\n report ",
      steps: [
        { text: " Pull the numbers\n\tfrom sales ", status: "doing", note: "  " },
        { text: "Build the page", status: "todo", note: " two\nlines " },
      ],
    });
    expect(checked).toEqual({
      title: "Quarterly report",
      steps: [
        { text: "Pull the numbers from sales", status: "doing" },
        { text: "Build the page", status: "todo", note: "two lines" },
      ],
    });
  });

  it("keeps the id of the checklist it updates, and takes every status", () => {
    const checked = checkChecklist({ id: " 0a1b2c3d4e5f ", title: "Plan", steps: steps("todo", "doing", "done", "skipped") });
    expect(checked.id).toBe("0a1b2c3d4e5f");
    expect(checked.steps.map((step) => step.status)).toEqual(["todo", "doing", "done", "skipped"]);
    // An empty id is a new checklist.
    expect(checkChecklist({ id: "", title: "Plan", steps: steps("todo") })).not.toHaveProperty("id");
  });

  it("says what to fix", () => {
    const bad = (input: unknown) => () => checkChecklist(input);
    expect(bad("a plan")).toThrow(ChecklistError);
    expect(bad({ steps: steps("todo") })).toThrow(/needs a title/);
    expect(bad({ title: " ", steps: steps("todo") })).toThrow(/needs a title/);
    expect(bad({ title: "x".repeat(MAX_TITLE_CHARS + 1), steps: steps("todo") })).toThrow(new RegExp(`at most ${MAX_TITLE_CHARS}`));
    expect(bad({ title: "Plan", steps: [] })).toThrow(/needs its steps/);
    expect(bad({ title: "Plan" })).toThrow(/needs its steps/);
    expect(bad({ title: "Plan", steps: steps(...Array(MAX_CHECKLIST_STEPS + 1).fill("todo")) })).toThrow(/at most 12 steps/);
    expect(bad({ title: "Plan", steps: [{ text: "x".repeat(MAX_STEP_CHARS + 1), status: "todo" }] })).toThrow(/Step 1's text is at most 200/);
    expect(bad({ title: "Plan", steps: [{ text: "ok", status: "todo", note: "x".repeat(MAX_NOTE_CHARS + 1) }] })).toThrow(/Step 1's note/);
    expect(
      bad({
        title: "Plan",
        steps: [
          { text: "ok", status: "todo" },
          { text: " ", status: "todo" },
        ],
      }),
    ).toThrow(/Step 2 needs its text/);
    expect(bad({ title: "Plan", steps: [{ text: "ok", status: "finished" }] })).toThrow(/todo, doing, done, skipped/);
    expect(bad({ title: "Plan", steps: ["ok"] })).toThrow(/Step 1 must be an object/);
    expect(bad({ id: "nope", title: "Plan", steps: steps("todo") })).toThrow(/id is the one its first call returned/);
    expect(bad({ id: 12, title: "Plan", steps: steps("todo") })).toThrow(/id is the one/);
  });

  it("makes ids it accepts", () => {
    expect(newChecklistId()).toMatch(CHECKLIST_ID_PATTERN);
    expect(newChecklistId()).not.toBe(newChecklistId());
  });
});

describe("foldChecklists", () => {
  it("keeps each checklist where it first appeared, with its latest state", () => {
    const first = checklistEntry("aaaaaaaaaaaa", { title: "Plan", steps: steps("doing", "todo") }, PI, 1);
    const other = checklistEntry("bbbbbbbbbbbb", { title: "Research", steps: steps("todo") }, RESEARCH, 2);
    const update = checklistEntry("aaaaaaaaaaaa", { title: "Plan", steps: steps("done", "doing") }, PI, 3);
    const last = checklistEntry("aaaaaaaaaaaa", { title: "Plan", steps: steps("done", "skipped") }, PI, 4);
    const entries = [{ id: 1, kind: "pi.user" }, entry(2, first), { id: 3, kind: "pi.assistant" }, entry(4, other), entry(5, update), entry(6, last)];
    const folded = foldChecklists(entries);
    expect([...folded.keys()]).toEqual(["aaaaaaaaaaaa", "bbbbbbbbbbbb"]);
    expect(folded.get("aaaaaaaaaaaa")).toEqual({ first: 2, latest: last });
    // The latest entry's own data: a card whose checklist did not change keeps its object.
    expect(folded.get("aaaaaaaaaaaa")!.latest).toBe(last);
    expect(folded.get("bbbbbbbbbbbb")).toEqual({ first: 4, latest: other });
    // The first entry draws the card with the latest state; the updates draw nothing.
    expect(checklistAt(folded, entries[1])).toBe(last);
    expect(checklistAt(folded, entries[3])).toBe(other);
    expect(checklistAt(folded, entries[4])).toBeUndefined();
    expect(checklistAt(folded, entries[5])).toBeUndefined();
    expect(checklistAt(folded, entries[0])).toBeUndefined();
  });

  it("marks a plan final when every step is done or skipped", () => {
    expect(checklistEntry("aaaaaaaaaaaa", { title: "Plan", steps: steps("done", "doing") }, PI, 1).final).toBeUndefined();
    expect(checklistEntry("aaaaaaaaaaaa", { title: "Plan", steps: steps("done", "skipped") }, PI, 1).final).toBe(true);
  });

  it("leaves out an update by another author, and entries of another shape", () => {
    const first = checklistEntry("aaaaaaaaaaaa", { title: "Plan", steps: steps("todo") }, RESEARCH, 1);
    const folded = foldChecklists([
      entry(1, first),
      entry(2, checklistEntry("aaaaaaaaaaaa", { title: "Taken", steps: steps("done") }, PI, 2)),
      { id: 3, kind: CHAT_CHECKLIST_KIND, data: { id: "cccccccccccc", title: "Bad", steps: [{ text: "x", status: "maybe" }], by: PI } },
      { id: 4, kind: CHAT_CHECKLIST_KIND },
    ]);
    expect([...folded.keys()]).toEqual(["aaaaaaaaaaaa"]);
    expect(folded.get("aaaaaaaaaaaa")!.latest).toBe(first);
  });
});

describe("checklists in the chat", () => {
  const call = (id: string, name: string) => ({ type: "toolCall", id, name, arguments: {} });
  const assistant = (id: number, content: unknown[]) => ({ id, kind: "pi.assistant", model: [{ role: "assistant", content, timestamp: id }] });
  const result = (id: number, callId: string) => ({
    id,
    kind: "pi.tool-result",
    model: [{ role: "toolResult", toolCallId: callId, toolName: "run_bash", content: [{ type: "text", text: "ok" }], isError: false }],
  });

  it("keeps pi's own plan, and a plan's updates, inside its reply; another agent's plan ends it", () => {
    const posted = new Set<string>();
    const mine = checklistEntry("aaaaaaaaaaaa", { title: "Plan", steps: steps("todo") }, PI, 1);
    const theirs = checklistEntry("bbbbbbbbbbbb", { title: "Research", steps: steps("todo") }, RESEARCH, 2);
    expect(inReply(entry(1, mine), posted)).toBe(true);
    expect(inReply(entry(2, theirs), posted)).toBe(false);
    expect(inReply(entry(3, theirs), posted)).toBe(true);
    expect(inReply({ kind: "chat.message", data: {} }, posted)).toBe(false);
  });

  it("ends a run of steps where a plan's card shows, not where it is updated", () => {
    const plan = checklistEntry("aaaaaaaaaaaa", { title: "Plan", steps: steps("doing", "todo") }, PI, 1);
    const chat = [
      { id: 1, kind: "pi.user", model: [{ role: "user", content: "build it" }] },
      assistant(2, [call("p", CHECKLIST_TOOL)]),
      entry(3, plan),
      result(4, "p"),
      assistant(5, [call("a", "run_bash")]),
      result(6, "a"),
      assistant(7, [call("q", CHECKLIST_TOOL)]),
      entry(8, { ...plan, steps: steps("done", "doing") }),
      result(9, "q"),
      assistant(10, [call("b", "run_bash")]),
    ] as never;
    const runs = stepRuns(chat, new Set());
    expect(
      runs.byEntry
        .get(2)
        ?.get(0)
        ?.map((item) => item.key),
    ).toEqual(["p"]);
    expect(
      runs.byEntry
        .get(5)
        ?.get(0)
        ?.map((item) => item.key),
    ).toEqual(["a", "q", "b"]);
  });

  it("draws the card: who posted it, its title, how far it is, and each step's status and note", () => {
    const data = checklistEntry(
      "bbbbbbbbbbbb",
      { title: "Weekly report", steps: [...steps("done", "doing", "todo"), { text: "Email it", status: "skipped", note: "No list given" }] },
      RESEARCH,
      1,
    );
    const html = renderToStaticMarkup(createElement(ChecklistCard, { data }));
    expect(html).toContain("Weekly report");
    expect(html).toContain("@research");
    expect(html).toContain(">Re<");
    expect(html).toContain("1 of 4 done · 1 skipped");
    expect(html).toContain('class="checklist-step doing"');
    expect(html).toContain("No list given");
    expect(renderToStaticMarkup(createElement(ChecklistCard, { data: { ...data, by: PI } }))).toContain("pi&#x27;s plan");
    expect(countLine(steps("done", "done", "done", "todo", "todo"))).toBe("3 of 5 done");
  });
});

describe("the checklist tool", () => {
  const tool = (scope: ChecklistScope) => {
    const found = checklistExtension(scope).tools!.find((t) => t.name === CHECKLIST_TOOL)!;
    return (args: unknown, api: { conversationId: string; callId: string }) =>
      (found.execute as unknown as (args: unknown, api: unknown) => Promise<{ output: { text: string }[]; details: unknown }>)(args, api);
  };

  it("posts the checked checklist for its session, once per call, and says to call again with the id", async () => {
    const calls: [string, ChecklistInput, string][] = [];
    const run = tool({
      postChecklist: async (conversation, checklist, requestId) => {
        calls.push([conversation, checklist, requestId]);
        return { id: checklist.id ?? "0a1b2c3d4e5f" };
      },
    });
    const posted = await run({ title: " Plan ", steps: [{ text: "Look", status: "doing" }] }, { conversationId: "c7", callId: "call-1" });
    expect(calls).toEqual([["c7", { title: "Plan", steps: [{ text: "Look", status: "doing" }] }, "checklist:c7:call-1"]]);
    expect(posted.output[0].text).toContain('again with id "0a1b2c3d4e5f"');
    expect(posted.details).toEqual({ checklistId: "0a1b2c3d4e5f" });
    const updated = await run({ id: "0a1b2c3d4e5f", title: "Plan", steps: steps("done") }, { conversationId: "c7", callId: "call-2" });
    expect(calls[1][2]).toBe("checklist:c7:call-2");
    expect(updated.output[0].text).toContain("the plan is over");
  });

  it("throws what to fix, and why the chat did not post it", async () => {
    const run = tool({ postChecklist: async () => ({ error: "That checklist is another agent's." }) });
    await expect(run({ title: "Plan", steps: [] }, { conversationId: "c7", callId: "x" })).rejects.toThrow(/needs its steps/);
    await expect(run({ title: "Plan", steps: steps("todo") }, { conversationId: "c7", callId: "x" })).rejects.toThrow(
      "Not posted: That checklist is another agent's.",
    );
  });
});
