import { describe, expect, it } from "vitest";
import type { AgentStep } from "../shared/agents.ts";
import { agentPath, agentPlace } from "../src/agents/nav.ts";
import { stepSummary, type RunItemView } from "../shared/runs.ts";
import { deliveryLabel, deliveryStatusLabel, itemGroups, itemLine, itemsLabel, runStatusLabel, signInWayOut, usedParts, whyLabel } from "../src/agents/runs.ts";
import { ASSUMED_FIELDS, withoutAssumed } from "../src/agents/glance.ts";
import { assumedAfter, moveItem, newStep, withKeys, withoutKeys } from "../src/agents/workflow.ts";

const steps: AgentStep[] = [
  { kind: "look", server: "crm", tool: "weekly_sales", input: {}, as: "sales" },
  { kind: "if", condition: "sales.total < 10", then: [{ kind: "work", prompt: "Say why." }], else: [] },
  { kind: "tell", to: ["owner"], via: "notify" },
];

describe("the Workflow tab's steps", () => {
  it("keys every step, its branches too, and gives the steps back as they were (an empty otherwise left out)", () => {
    const keyed = withKeys(steps);
    expect(new Set([keyed[0].key, keyed[1].key, keyed[1].then![0].key]).size).toBe(3);
    expect(withoutKeys(keyed)).toEqual([steps[0], { kind: "if", condition: "sales.total < 10", then: [{ kind: "work", prompt: "Say why." }] }, steps[2]]);
  });

  it("moves a step, makes new ones empty, and sums each up", () => {
    expect(moveItem(["a", "b", "c"], 2, 0)).toEqual(["c", "a", "b"]);
    expect(moveItem(["a", "b", "c"], 0, 1)).toEqual(["b", "a", "c"]);
    expect(newStep("tell")).toEqual({ kind: "tell", to: ["owner"], via: "chat" });
    expect(stepSummary(steps[0])).toBe("crm.weekly_sales as sales");
    expect(stepSummary(steps[2])).toBe("owner as a notification");
    expect(stepSummary(newStep("work"))).toBe("(not set)");
    expect(stepSummary({ kind: "work", prompt: "\n  Say which channel fell.\nThen why." })).toBe("Say which channel fell.");
    expect(stepSummary({ kind: "handOver", agent: "finance" })).toBe("to @finance");
  });
});

describe("the Runs tab's words", () => {
  it("says a run's state, what started it, its items and where it sent", () => {
    expect(runStatusLabel({ status: "sent" })).toEqual({ text: "Sent", tone: "on" });
    expect(runStatusLabel({ status: "sent", test: true }).text).toBe("Would send");
    expect(runStatusLabel({ status: "not_today", test: true }).text).toBe("Not today");
    expect(whyLabel("watch")).toBe("Its watch fired");
    expect(whyLabel("manual")).toBe("Run by hand");
    expect(itemsLabel({ total: 1, acted: 1, notToday: 0, failed: 0, waiting: 0 })).toBe("");
    expect(itemsLabel({ total: 6, acted: 3, notToday: 3, failed: 0, waiting: 0 })).toBe("3 of 6 acted · 3 not today");
    expect(itemsLabel({ total: 3, acted: 1, notToday: 0, failed: 0, waiting: 2 })).toBe("1 of 3 acted · 2 wait for you");
    expect(runStatusLabel({ status: "waiting" })).toEqual({ text: "Waits for you", tone: "draft" });
    expect(deliveryLabel({ kind: "chat", to: "its chat", status: "sent" })).toBe("Posted in its chat");
    expect(deliveryLabel({ kind: "notify", to: "you", status: "recorded" })).toBe("Would notify you");
    expect(deliveryLabel({ kind: "page", to: "Signups brief", status: "failed" })).toBe("Did not update Signups brief");
    expect(deliveryStatusLabel("refused")).toEqual({ text: "Not sent", tone: "off" });
  });

  it("groups a run's items into acted on and not today, each with its line, and says what it used", () => {
    const item = (label: string, status: RunItemView["status"], more: Partial<RunItemView> = {}): RunItemView => ({
      item: label.toLowerCase(),
      label,
      status,
      steps: [{ kind: "look", label: "Look at crm.region", ok: true, ms: 10 }],
      cost: 0,
      startedAt: 0,
      ...more,
    });
    const groups = itemGroups([
      item("North", "not_today", { reason: "region.change < -5% did not hold" }),
      item("West", "acted", { text: "\nWest is furthest behind, at -12.4%.\nMostly paid search." }),
      item("East", "failed", { reason: "crm.region failed: timeout" }),
      item("South", "acted", { text: "South will land 3% short." }),
      item("Hills", "running"),
    ]);
    expect(groups.map((group) => [group.title, group.count])).toEqual([
      ["Running", "1"],
      ["Acted on", "2 of 5"],
      ["Failed", "1"],
      ["Not today", "1"],
    ]);
    expect(groups[1].items.map(({ item, line }) => [item.label, line])).toEqual([
      ["West", "West is furthest behind, at -12.4%."],
      ["South", "South will land 3% short."],
    ]);
    expect(groups[3].items[0].line).toBe("region.change < -5% did not hold");
    expect(groups[0].items[0].line).toBe("Look at crm.region");
    expect(itemLine(item("Islands", "waiting"))).toBe("Waits for you to approve a call.");
    expect(usedParts({ skills: ["forecasting"], servers: ["crm", "forecast"], models: [], notes: 4 })).toEqual([
      { what: "Skill", text: "forecasting" },
      { what: "Memory", text: "4 notes" },
      { what: "Read", text: "crm, forecast" },
    ]);
    expect(usedParts({ skills: [], servers: [], models: ["a", "b"], notes: 1 })).toEqual([
      { what: "Memory", text: "1 note" },
      { what: "Models", text: "a, b" },
    ]);
  });

  it("puts a run in the agent page's address and reads it back", () => {
    const path = agentPath({ id: "a1b2c3d4e5f60718", tab: "runs", run: 1_762_480_800_000 });
    expect(path).toBe("/agents/a1b2c3d4e5f60718?tab=runs&run=1762480800000");
    expect(agentPlace(new URL(path, "https://app.test"))).toMatchObject({ tab: "runs", run: 1_762_480_800_000 });
    expect(agentPlace(new URL("/agents/a1b2c3d4e5f60718?run=nope", "https://app.test"))).not.toHaveProperty("run");
  });
});

describe("the Workflow tab's Assumed", () => {
  const before = { trigger: { kind: "schedule", at: "07:00", tz: "Europe/Bucharest" } as const, workflow: steps };
  const assumed = ["trigger", "scope", "tells", "servers"];

  it("drops a part the user changed, and only that", () => {
    expect(assumedAfter(assumed, before, before)).toEqual(assumed);
    expect(assumedAfter(assumed, before, { ...before, trigger: { kind: "schedule", at: "08:00", tz: "Europe/Bucharest" } })).toEqual(["scope", "tells", "servers"]);
    // A tell step changed: its recipients are the user's now; other steps changing says nothing of them.
    const told: AgentStep[] = [steps[0], steps[1], { kind: "tell", to: ["owner"], via: "chat" }];
    expect(assumedAfter(assumed, before, { ...before, workflow: told })).toEqual(["trigger", "scope", "servers"]);
    expect(assumedAfter(assumed, before, { ...before, workflow: [steps[1], steps[0], steps[2]] })).toEqual(assumed);
  });

  it("drops a part said to look right, as the names assumed uses go", () => {
    expect(withoutAssumed(["Schedule", "scope"], ASSUMED_FIELDS.runs)).toEqual(["scope"]);
  });
});

describe("a run waiting for a sign-in", () => {
  it("offers Disconnect only for a server its agent does not read in a step", () => {
    const brief = { name: "brief", workflow: steps };
    expect(signInWayOut(brief, ["crm"])).toEqual([
      "No access any more? @brief reads crm in a step, so it cannot go on without it: change its steps or turn it off.",
    ]);
    expect(signInWayOut(brief, ["calendar"])).toEqual([
      "Signed in to calendar before and no access any more? Disconnect it under Sign-ins in the account menu, and runs go on without it.",
    ]);
    expect(signInWayOut(brief, ["crm", "calendar"])).toHaveLength(2);
  });
});
