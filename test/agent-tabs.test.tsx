import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { AgentDefinition, AgentFiles } from "../shared/agents.ts";
import { AgentTabs } from "../src/agents/AgentTabs.tsx";
import { ServersTable } from "../src/agents/ServersTable.tsx";
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

  it("show the owner's private files as a row of the servers table, with the two switches and the shared-chat warning", () => {
    const table = (servers: { name: string; signsIn: boolean }[], files: AgentFiles) =>
      renderToStaticMarkup(
        <ServersTable servers={servers} error={null} own={new Set(["crm"])} shared={new Set()} name="research" onToggle={() => {}} files={files} onFiles={() => {}} />,
      );
    const row = (html: string) => html.slice(html.indexOf('class="agent-server-files"'));
    const inputs = (html: string) => [...row(html).matchAll(/<input [^>]*>/g)].map(([input]) => input);
    // The default: on for its owner's own turns, off for shared chats, and no warning.
    const byDefault = table([{ name: "crm", signsIn: false }], { own: true, shared: false });
    expect(row(byDefault)).toContain("your private files");
    expect(row(byDefault)).not.toContain("agent-server-warn");
    const [mine, theirs] = inputs(byDefault);
    expect(mine).toContain('checked=""');
    expect(mine).not.toContain("disabled");
    expect(theirs).not.toContain("checked");
    expect(theirs).not.toContain("disabled");
    // Shared: the same warning as a server that signs in as the owner.
    const shared = table([{ name: "crm", signsIn: false }], { own: true, shared: true });
    expect(row(shared)).toContain("Anyone in a shared chat can make @research read your files, and sees what it reads.");
    // Off for the agent: the shared-chat switch is off and held, as for a server it may not use.
    const off = inputs(table([{ name: "crm", signsIn: false }], { own: false, shared: false }));
    expect(off[0]).not.toContain("checked");
    expect(off[1]).toContain('disabled=""');
    // With no servers, the row still shows, under a line that says so.
    const none = table([], { own: true, shared: false });
    expect(none).toContain("no MCP servers");
    expect(none).toContain("your private files");
  });
});
