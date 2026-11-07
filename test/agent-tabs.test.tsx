import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { AgentDefinition } from "../shared/agents.ts";
import { AgentTabs } from "../src/agents/AgentTabs.tsx";
import { keptBy, SETUP_FIELDS } from "../src/agents/tab-fields.ts";

const tabs = [
  { id: "setup", label: "Setup" },
  { id: "workflow", label: "Workflow" },
  { id: "runs", label: "Runs" },
];

describe("the agent page's tabs", () => {
  it("hold the other tabs while the open one has changes not saved", () => {
    const open = () => {};
    expect(renderToStaticMarkup(<AgentTabs tabs={tabs} current="setup" dirty={false} open={open} />)).not.toContain("disabled");
    const dirty = renderToStaticMarkup(<AgentTabs tabs={tabs} current="setup" dirty open={open} />);
    // Every tab but the open one is held, with the reason.
    expect(dirty.match(/disabled=""/g)).toHaveLength(2);
    expect(dirty).toContain('title="Save or undo your changes first"');
    expect(dirty).toMatch(/aria-selected="true"[^>]*>Setup</);
  });

  it("let Setup turn speaking up and review before posting off: its save keeps neither as it was, and another tab's keeps both", () => {
    const agent = {
      id: "a1",
      name: "planner",
      avatar: "pl",
      color: "teal",
      job: "Plans.",
      instructions: "Plan.",
      autonomy: 1,
      origin: "user",
      enabled: true,
      version: 3,
      createdAt: 0,
      updatedAt: 0,
      speaksUp: true,
      reviewBeforePosting: true,
      assumed: ["model"],
    } as AgentDefinition;
    // The Setup form leaves a box that is off out of what it saves: what it keeps of the agent must not bring it back.
    const setup = keptBy(SETUP_FIELDS, agent);
    for (const field of ["speaksUp", "reviewBeforePosting", "assumed", "name"]) expect(setup).not.toHaveProperty(field);
    const workflow = keptBy(["trigger", "scope", "workflow"], agent);
    expect(workflow).toMatchObject({ speaksUp: true, reviewBeforePosting: true, assumed: ["model"], name: "planner" });
  });
});
