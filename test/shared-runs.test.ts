import { describe, expect, it } from "vitest";
import type { SharedAgentView } from "../shared/agents.ts";
import { postedInto, type AgentRunDetail, type RunDelivery } from "../shared/runs.ts";
import { postedRunDetail, postedRunView, postIn, readPostedRuns, runsAccess, type PostedRunsDeps } from "../worker/agents/runs/posted.ts";
import { AgentRuns } from "../worker/agents/runs/store.ts";
import { memorySql } from "./fakes.ts";

const GROUP = "groupchat1";
const OTHER = "otherchat1";
const HOME = "homechat01";

const toGroup: RunDelivery = {
  kind: "chat",
  to: "its chat, Weekly numbers",
  text: "5 regions will land below target.\nWest is furthest behind.",
  status: "sent",
  sentAt: 10,
  chat: { id: HOME, kind: "private" },
  chats: [HOME, GROUP],
};
const toOwner: RunDelivery = { kind: "notify", to: "you", text: "Private: the vault says 12 deals slipped.", status: "sent", chat: { id: HOME, kind: "private" }, chats: [HOME] };
const toTool: RunDelivery = { kind: "tool", to: "mail.send", text: "To the leads", status: "sent" };

function detail(deliveries: RunDelivery[]): AgentRunDetail {
  return {
    agentId: "a1",
    dueAt: 1_000,
    why: "schedule",
    status: "sent",
    startedAt: 1_000,
    endedAt: 2_000,
    cost: 0.04,
    items: { total: 7, acted: 5, notToday: 2, blocked: 0, failed: 0, waiting: 0 },
    summary: "Private: the owner's summary",
    when: "Every day at 07:00 (UTC)",
    itemsList: [{ item: "west", label: "West", status: "acted", steps: [{ kind: "look", label: "Look at vault.deals", detail: "secret rows", ok: true, ms: 1 }], text: "secret", cost: 0.01, startedAt: 1_000, session: "s1" }],
    deliveries,
    used: { skills: ["forecasting"], servers: ["crm", "vault"], models: ["m"], notes: 4 },
  };
}

describe("a shared agent's runs, for someone other than its owner", () => {
  it("names the chats a delivery posted its report into: a sent chat post or notification only", () => {
    expect(postedInto(toGroup)).toEqual([HOME, GROUP]);
    expect(postedInto(toOwner)).toEqual([HOME]);
    expect(postedInto(toTool)).toEqual([]);
    expect(postedInto({ ...toGroup, status: "recorded" })).toEqual([]);
    expect(postedInto({ ...toGroup, status: "refused" })).toEqual([]);
    // A delivery from before `chats`: its one chat.
    const { chats: _chats, ...older } = toGroup;
    expect(postedInto(older)).toEqual([HOME]);
  });

  it("shows a run only to a chat it posted in, with only that post: no items, trace, cost, notes or other deliveries", () => {
    const run = detail([toOwner, toGroup, toTool]);
    expect(postIn(run.deliveries, GROUP)).toBe(toGroup);
    expect(postedRunDetail(run, OTHER)).toBeNull();
    const seen = postedRunDetail(run, GROUP)!;
    expect(seen).toMatchObject({ status: "sent", cost: 0, itemsList: [], summary: "5 regions will land below target." });
    expect(seen.deliveries).toEqual([{ kind: "chat", to: "this chat", text: toGroup.text, status: "sent", sentAt: 10 }]);
    expect(seen.used).toEqual({ skills: ["forecasting"], servers: ["crm", "vault"], models: [], notes: 0 });
    expect(seen.items.total).toBe(0);
    const json = JSON.stringify(seen);
    for (const secret of ["Private", "secret", "vault.deals", "mail.send", HOME, "s1"]) expect(json).not.toContain(secret);
  });

  it("hides a test run's recorded report and a run that posted only to its owner", () => {
    expect(postedRunDetail(detail([{ ...toGroup, status: "recorded" }]), GROUP)).toBeNull();
    expect(postedRunDetail(detail([toOwner]), GROUP)).toBeNull();
    expect(postedRunView(detail([toGroup]), [toGroup], GROUP)?.summary).toBe("5 regions will land below target.");
  });

  it("answers its owner with every run in full, from a chat too, and anyone else only with the posted runs, never a trace", () => {
    expect(runsAccess(true, null, false)).toBe("owner");
    expect(runsAccess(true, GROUP, false)).toBe("owner");
    expect(runsAccess(true, GROUP, true)).toBe("owner");
    expect(runsAccess(false, GROUP, false)).toBe("posted");
    expect(runsAccess(false, GROUP, true)).toBe("refused");
    // No chat named: the owner's way, whose checks find no such agent of theirs.
    expect(runsAccess(false, null, false)).toBe("owner");
  });

  describe("who may read them (readPostedRuns)", () => {
    const view = (ownerUid: string): SharedAgentView =>
      ({ id: "a1", name: "brief", version: 1, ownerUid, ownerName: ownerUid, turns: [] }) as unknown as SharedAgentView;
    /** Ana asks; Radu owns the agent and the chat GROUP, which Ana is in and where he shares it. */
    function deps(over: Partial<PostedRunsDeps> = {}) {
      const calls: string[] = [];
      const base: PostedRunsDeps = {
        chatOwner: async (id) => (calls.push(`owner:${id}`), id === GROUP ? "radu" : null),
        sharedAgent: async (owner, id) => (calls.push(`shared:${owner}:${id}`), view("radu")),
        agentHome: async (owner) => (calls.push(`home:${owner}`), HOME),
        list: async (owner, home) => (calls.push(`list:${owner}:${home}`), { runs: [], nextRunAt: 5, homeChatId: null }),
        run: async (owner, home, dueAt) => (calls.push(`run:${owner}:${home}:${dueAt}`), detail([toGroup])),
      };
      return { deps: { ...base, ...over }, calls };
    }

    it("reads the runs posted in the chat from the agent's home, for someone in it it is shared with", async () => {
      const { deps: d, calls } = deps();
      expect(await readPostedRuns(d, GROUP)).toEqual({ runs: [], nextRunAt: 5, homeChatId: null });
      expect(calls).toEqual([`owner:${GROUP}`, `shared:radu:${GROUP}`, "home:radu", `list:radu:${HOME}`]);
      expect(await readPostedRuns(d, GROUP, 1_000)).toMatchObject({ dueAt: 1_000 });
    });

    it("refuses someone not in the chat, a malformed chat, and a chat the agent is not shared in", async () => {
      const outside = deps();
      expect(await readPostedRuns(outside.deps, OTHER)).toEqual({ status: 404, error: "No such chat." });
      expect(outside.calls).toEqual([`owner:${OTHER}`]);
      const malformed = deps();
      expect(await readPostedRuns(malformed.deps, "../x")).toMatchObject({ status: 404 });
      expect(malformed.calls).toEqual([]);
      const unshared = deps({ sharedAgent: async () => ({ status: 403, error: "@brief's owner does not share it in this chat." }) });
      expect(await readPostedRuns(unshared.deps, GROUP, 1_000)).toEqual({ status: 403, error: "@brief's owner does not share it in this chat." });
      expect(unshared.calls).not.toContainEqual(expect.stringMatching(/^(home|list|run):/));
    });

    it("reads nothing from a chat someone other than the agent's owner owns: its runs never post there", async () => {
      const { deps: d, calls } = deps({ sharedAgent: async () => view("bea") });
      expect(await readPostedRuns(d, GROUP)).toEqual({ runs: [], nextRunAt: null, homeChatId: null });
      expect(await readPostedRuns(d, GROUP, 1_000)).toMatchObject({ status: 404 });
      expect(calls.some((call) => /^(home|list|run):/.test(call))).toBe(false);
    });
  });

  it("lists, of the runs kept, only those that posted in the chat, newest first", () => {
    const runs = new AgentRuns(memorySql(), () => 0);
    for (const [dueAt, deliveries] of [
      [1, [toGroup]],
      [2, [toOwner]],
      [3, [toGroup, toTool]],
    ] as const) {
      runs.begin("a1", dueAt, "schedule", false);
      runs.update("a1", dueAt, { status: "sent", detail: { deliveries: [...deliveries] } });
    }
    const listed = runs.list("a1", 50, (run) => postIn(run.detail.deliveries, GROUP) !== undefined);
    expect(listed.map((run) => run.dueAt)).toEqual([3, 1]);
    expect(runs.list("a1", 1, (run) => postIn(run.detail.deliveries, GROUP) !== undefined).map((run) => run.dueAt)).toEqual([3]);
    expect(runs.list("a1").map((run) => run.dueAt)).toEqual([3, 2, 1]);
  });
});
