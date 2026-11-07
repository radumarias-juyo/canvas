import { describe, expect, it } from "vitest";
import { checkAgent, CHAT_TURN_KIND, type StepInput } from "../shared/agents.ts";
import {
  checkRule,
  checkRules,
  GuardrailError,
  inQuietRange,
  kindsFor,
  matchesValue,
  strictest,
  toolArgs,
  violation,
  type GuardrailRule,
  type PendingActionView,
} from "../shared/limits.ts";
import { CHAT_MESSAGE_KIND } from "../shared/protocol.ts";
import { ChatActions, type NewAction } from "../worker/agents/limits/actions.ts";
import { LimitsDirectory } from "../worker/agents/limits/directory.ts";
import { fillFromCall, WriteGate, type Caller, type GateContext, type GateHost } from "../worker/agents/limits/gate.ts";
import { inputLevel, lowestLevel, turnLevel } from "../worker/agents/limits/levels.ts";
import { toolInput } from "../worker/agents/limits/tell.ts";
import { CallHeld, McpHub, type McpConnection, type RawToolResult } from "../worker/mcp/hub.ts";
import type { ToolInfo } from "../shared/protocol.ts";
import { memorySql } from "./fakes.ts";

const T0 = Date.UTC(2026, 10, 7, 9, 0);

const rule = (over: Partial<GuardrailRule> & Pick<GuardrailRule, "kind">): GuardrailRule =>
  ({ id: "r1", server: "crm", tool: "update_deal", effect: "block", value: 10, ...over }) as GuardrailRule;

const call = (input: StepInput, at = T0) => ({ server: "crm", tool: "update_deal", input, at });

describe("guardrail rules", () => {
  it("checks a rule's shape and says what to fix", () => {
    expect(checkRule({ id: "a", server: "crm", tool: "update_deal", arg: "discount", kind: "max", value: 10, effect: "approve" })).toEqual({
      id: "a",
      server: "crm",
      tool: "update_deal",
      arg: "discount",
      kind: "max",
      value: 10,
      effect: "approve",
    });
    expect(() => checkRule({ id: "a", server: "crm", tool: "*", arg: "discount", kind: "max", value: 10 })).toThrow(/names one tool/);
    expect(() => checkRule({ id: "a", server: "crm", tool: "x", kind: "max", value: 10 })).toThrow(/names an argument/);
    expect(() => checkRule({ id: "a", server: "crm", tool: "x", kind: "quietDates", value: [{ from: "12-24", to: "2026-12-26" }] })).toThrow(
      GuardrailError,
    );
    expect(() => checkRule({ id: "a", server: "crm", tool: "x", arg: "n", kind: "maxChange", value: 5 })).toThrow(/current value/);
    expect(() => checkRules([rule({ kind: "callsPerDay" }), rule({ kind: "callsPerDay" })])).toThrow(/same id/);
    // Quiet dates and call counts may hold for every tool of every server.
    expect(
      checkRule({ id: "q", server: "*", tool: "*", kind: "quietDates", value: [{ from: "12-24", to: "12-26" }], tz: "Europe/Bucharest" }),
    ).toMatchObject({
      tz: "Europe/Bucharest",
    });
  });

  it("are stored with an agent, checked with it", () => {
    const base = { name: "deals", job: "Keeps deals tidy.", instructions: "Do it." };
    const checked = checkAgent({
      ...base,
      guardrails: [{ id: "a", server: "crm", tool: "update_deal", arg: "discount", kind: "max", value: 10 }],
      approvalHours: 24,
    });
    expect(checked.guardrails).toEqual([{ id: "a", server: "crm", tool: "update_deal", arg: "discount", kind: "max", value: 10, effect: "block" }]);
    expect(checked.approvalHours).toBe(24);
    expect(() => checkAgent({ ...base, guardrails: [{ id: "a", kind: "nope" }] })).toThrow(/limits/);
    expect(() => checkAgent({ ...base, approvalHours: 0 })).toThrow(/hours/);
  });

  it("min and max read every value of the argument, and hold one that is not a number", () => {
    expect(violation(rule({ kind: "max", arg: "discount" }), call({ discount: 12 }))).toMatch(/over 10/);
    expect(violation(rule({ kind: "max", arg: "discount" }), call({ discount: 10 }))).toBeNull();
    expect(violation(rule({ kind: "min", arg: "lines.0.qty", value: 1 }), call({ lines: [{ qty: 0 }] }))).toMatch(/under 1/);
    expect(violation(rule({ kind: "max", arg: "discount" }), call({ discount: "lots" }))).toMatch(/not a number/);
    // A call that does not set the argument is not about it.
    expect(violation(rule({ kind: "max", arg: "discount" }), call({ other: 99 }))).toBeNull();
  });

  it("maxChange compares with the current value, as an amount or a percentage, and holds when it cannot be read", () => {
    const change = rule({ kind: "maxChange", arg: "price", value: 10, percent: true, current: { tool: "get_deal", input: {}, path: "price" } });
    expect(violation(change, call({ price: 105 }), { current: 100 })).toBeNull();
    expect(violation(change, call({ price: 120 }), { current: 100 })).toMatch(/20%/);
    expect(violation({ ...change, percent: undefined }, call({ price: 120 }), { current: 100 })).toMatch(/change of 20, over 10/);
    expect(violation(change, call({ price: 105 }), { current: null })).toMatch(/could not be read/);
  });

  it("never matches text without case, with * for any characters", () => {
    expect(matchesValue("*@example.com", "Ana@Example.com")).toBe(true);
    expect(matchesValue("*@example.com", "ana@example.org")).toBe(false);
    expect(matchesValue("a.b", "aXb")).toBe(false);
    expect(violation(rule({ kind: "never", arg: "to", value: ["*@example.com"] }), call({ to: ["x@else.org", "y@example.com"] }))).toMatch(
      /y@example.com/,
    );
  });

  it("quiet dates hold every year, across the new year too, in the rule's time zone", () => {
    expect(inQuietRange("2026-12-25", { from: "12-24", to: "12-26" })).toBe(true);
    expect(inQuietRange("2027-01-01", { from: "12-30", to: "01-02" })).toBe(true);
    expect(inQuietRange("2026-06-01", { from: "12-30", to: "01-02" })).toBe(false);
    expect(inQuietRange("2026-12-25", { from: "2026-12-25", to: "2026-12-25" })).toBe(true);
    // 23:30 UTC on the 23rd is already the 24th in Bucharest.
    const late = Date.UTC(2026, 11, 23, 23, 30);
    const quiet = rule({ kind: "quietDates", server: "*", tool: "*", value: [{ from: "12-24", to: "12-26" }] });
    expect(violation(quiet, call({}, late))).toBeNull();
    expect(violation({ ...quiet, tz: "Europe/Bucharest" }, call({}, late))).toMatch(/quiet date/);
  });

  it("the strictest rule wins: block, then approve, then warn", () => {
    const hit = (effect: GuardrailRule["effect"]) => ({ rule: rule({ kind: "max", effect }), reason: "" });
    expect(strictest([hit("warn"), hit("approve")])).toBe("approve");
    expect(strictest([hit("warn"), hit("block"), hit("approve")])).toBe("block");
    expect(strictest([])).toBeNull();
  });

  it("the editor's choices come from the tool's input schema", () => {
    const schema = {
      type: "object",
      properties: {
        discount: { type: "number", description: "Percent off" },
        to: { type: "array", items: { type: "string" } },
        stage: { type: "string", enum: ["open", "won", "lost"] },
        deal: { type: "object", properties: { amount: { type: ["integer", "null"] } } },
      },
    };
    expect(toolArgs(schema)).toEqual([
      { path: "discount", type: "number", description: "Percent off" },
      { path: "to", type: "array" },
      { path: "stage", type: "string", values: ["open", "won", "lost"] },
      { path: "deal.amount", type: "integer" },
    ]);
    expect(kindsFor("integer")).toEqual(["min", "max", "maxChange", "never"]);
    expect(kindsFor("string")).toEqual(["never"]);
  });

  it("fills a current value's read from the call's input", () => {
    expect(fillFromCall({ id: "{{input.deal.id}}", note: "for {{input.deal.id}}" }, { deal: { id: 7 } })).toEqual({ id: 7, note: "for 7" });
  });
});

describe("levels in a chat", () => {
  const OWNER = "owner-uid";
  const message = (uid: string, name = "Mia") => ({ kind: CHAT_MESSAGE_KIND, data: { uid, name, text: "", sentAt: 1 } });
  const handOff = (turn: number) => ({ kind: CHAT_TURN_KIND, data: { turn, calledBy: { name: "atlas", agentId: "a" }, hop: 1 } });

  it("pi runs on its owner's own message, and only proposes on anyone else's", () => {
    expect(inputLevel(message(OWNER), OWNER, () => null).level).toBe(4);
    expect(inputLevel(message("mia-uid"), OWNER, () => null)).toEqual({ level: 2, because: "on Mia's message" });
    expect(inputLevel({ kind: "pi.user" }, OWNER, () => null).level).toBe(2);
    // One run answering both goes no further than the member's.
    expect(lowestLevel([inputLevel(message(OWNER), OWNER, () => null), inputLevel(message("mia-uid"), OWNER, () => null)])?.level).toBe(2);
  });

  it("a hand-off to pi goes no further than the turn that handed it", () => {
    expect(inputLevel(handOff(1), OWNER, () => ({ byOwner: true })).level).toBe(4);
    expect(inputLevel(handOff(1), OWNER, () => ({ byOwner: false })).level).toBe(2);
    // A run's chain never does, whoever's it is; nor a turn the chat no longer has.
    expect(inputLevel(handOff(1), OWNER, () => ({ byOwner: true, unattended: true })).level).toBe(2);
    expect(inputLevel(handOff(1), OWNER, () => null).level).toBe(2);
  });

  it("an agent runs on its owner's own turn and proposes on any other", () => {
    expect(turnLevel({ byOwner: true, calledBy: { name: "Radu" } }).level).toBe(4);
    expect(turnLevel({ byOwner: false, calledBy: { name: "Mia" } })).toEqual({ level: 2, because: "on a turn Mia gave it" });
  });
});

/** An MCP server with a read tool and a write tool, recording every call that reaches it. */
function fakeServer(
  tools: ToolInfo[] = [
    { name: "get_deal", description: "", annotations: { readOnlyHint: true } },
    { name: "update_deal", description: "", inputSchema: { type: "object", properties: { discount: { type: "number" } } } },
  ],
) {
  const calls: { name: string; args: unknown }[] = [];
  const connection: McpConnection = {
    listTools: async () => tools,
    callTool: async (name, args): Promise<RawToolResult> => {
      calls.push({ name, args });
      return { content: [{ type: "text", text: JSON.stringify(name === "get_deal" ? { price: 100 } : { ok: true }) }] };
    },
    close: async () => {},
  };
  return { calls, connector: async () => connection };
}

/** The chat a gate guards: real actions over SQLite, callers by session name, a log. */
function guarded(callers: Record<string, Partial<Caller>>, userRules: GuardrailRule[] = []) {
  const clock = { now: T0 };
  const server = fakeServer();
  const hub = new McpHub([{ name: "crm", url: "https://example.invalid/mcp" }], server.connector, () => clock.now);
  const actions = new ChatActions(
    memorySql(),
    () => "chat-1",
    () => clock.now,
  );
  const logged: { outcome: string; detail?: string }[] = [];
  const held: PendingActionView[] = [];
  let calls = 0;
  const host: GateHost = {
    now: () => clock.now,
    caller: async (context: GateContext) => {
      const found = context.kind === "session" ? callers[context.session] : context.kind === "run" ? callers.run : undefined;
      if (!found) throw new Error("this session has no turn that may change anything.");
      return { actor: { name: "pi" }, level: 4, because: "on your own message", origin: {}, ...found } as Caller;
    },
    userRules: async () => userRules,
    agent: async () => null,
    readValue: async (_server, tool, input, path) => {
      const { result } = await hub.read("crm", tool, input, { staleMs: 0, viewer: "owner" });
      return (result.payload as Record<string, unknown>)[path];
    },
    callsSince: async () => calls,
    dayStart: (at) => at - (at % 86_400_000),
    log: (entry) => {
      logged.push(entry);
      if (entry.outcome === "ran" || entry.outcome === "warned") calls++;
    },
    hold: async (action: NewAction) => {
      const view = actions.add(action);
      held.push(view);
      return view;
    },
    approved: (id) => {
      const action = actions.get(id);
      const origin = actions.origin(id);
      return action?.status === "running" && origin ? { action, origin } : null;
    },
  };
  const gate = new WriteGate(host);
  hub.guard(gate);
  const write = (session: string, input: StepInput) => hub.call("crm", "update_deal", input, { kind: "session", session });
  const approve = async (id: string, input?: StepInput) => {
    const action = actions.move(id, "pending", "running")!;
    return hub.call("crm", action.tool, input ?? action.input, { kind: "approved", actionId: id });
  };
  return { clock, server, hub, actions, logged, held, write, approve };
}

/** The verdict a held or refused call came with. */
async function heldBy(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    if (error instanceof CallHeld) return error.verdict;
    throw error;
  }
  throw new Error("the call ran");
}

describe("the write gate", () => {
  const discountRule = (effect: GuardrailRule["effect"]): GuardrailRule => rule({ kind: "max", arg: "discount", effect });

  it("lets read-only tools through without asking", async () => {
    const chat = guarded({});
    await chat.hub.call("crm", "get_deal", { id: 1 });
    expect(chat.server.calls).toEqual([{ name: "get_deal", args: { id: 1 } }]);
    expect(chat.logged).toEqual([]);
  });

  it("refuses a call from no session it knows, before it reaches the server", async () => {
    const chat = guarded({});
    expect(await heldBy(chat.write("stray", { discount: 1 }))).toMatchObject({ outcome: "refused" });
    expect(await heldBy(chat.hub.call("crm", "update_deal", {}))).toMatchObject({ outcome: "refused" });
    expect(chat.server.calls).toEqual([]);
  });

  it("a blocked guardrail never reaches the server, whatever the level", async () => {
    const chat = guarded({ owner: { level: 4 }, member: { level: 2 } }, [discountRule("block")]);
    expect(await heldBy(chat.write("owner", { discount: 25 }))).toMatchObject({
      outcome: "refused",
      message: expect.stringMatching(/rule blocks it.*over 10/),
    });
    // Not even proposed: a call a rule blocks would never run.
    expect(await heldBy(chat.write("member", { discount: 25 }))).toMatchObject({ outcome: "refused" });
    expect(chat.server.calls).toEqual([]);
    expect(chat.held).toEqual([]);
    expect(chat.logged.map((entry) => entry.outcome)).toEqual(["refused", "refused"]);
  });

  it("goes by level: Inform refuses, Recommend proposes, Approve queues, Run runs and logs", async () => {
    const chat = guarded({ one: { level: 1, because: "on its own, in a run" }, two: { level: 2 }, three: { level: 3 }, four: { level: 4 } });
    expect(await heldBy(chat.write("one", { discount: 1 }))).toMatchObject({ outcome: "refused", message: expect.stringMatching(/at Inform/) });
    expect(await heldBy(chat.write("two", { discount: 2 }))).toMatchObject({ outcome: "held", action: { kind: "proposal", input: { discount: 2 } } });
    expect(await heldBy(chat.write("three", { discount: 3 }))).toMatchObject({
      outcome: "held",
      action: { kind: "approval", input: { discount: 3 } },
    });
    await chat.write("four", { discount: 4 });
    expect(chat.server.calls).toEqual([{ name: "update_deal", args: { discount: 4 } }]);
    expect(chat.logged.map((entry) => entry.outcome)).toEqual(["refused", "held", "held", "ran"]);
  });

  it("at Run, a rule that asks for approval holds the call, and one that warns lets it through with the warning", async () => {
    const chat = guarded({ four: { level: 4 } }, [discountRule("approve"), { ...discountRule("warn"), id: "w", value: 5 }]);
    const held = await heldBy(chat.write("four", { discount: 12 }));
    expect(held).toMatchObject({ outcome: "held", action: { kind: "approval", why: expect.stringMatching(/rule asks for your approval/) } });
    await chat.write("four", { discount: 7 });
    expect(chat.server.calls).toEqual([{ name: "update_deal", args: { discount: 7 } }]);
    expect(chat.logged.at(-1)).toMatchObject({ outcome: "warned", detail: expect.stringMatching(/over 5/) });
  });

  it("an approved call runs exactly as stored, once, and only its own call", async () => {
    const chat = guarded({ two: { level: 2 } });
    const held = await heldBy(chat.write("two", { discount: 8 }));
    if (held.outcome !== "held") throw new Error("not held");
    // A call that is not the stored one is not run under its approval, nor one that was never approved.
    expect(await heldBy(chat.hub.call("crm", "update_deal", { discount: 80 }, { kind: "approved", actionId: held.action.id }))).toMatchObject({
      outcome: "refused",
    });
    await chat.approve(held.action.id);
    expect(chat.server.calls).toEqual([{ name: "update_deal", args: { discount: 8 } }]);
    // A second press finds it no longer pending.
    expect(chat.actions.move(held.action.id, "pending", "running")).toBeNull();
  });

  it("an approval is checked once more against the rules that block: a quiet date may have begun", async () => {
    const quiet = rule({ id: "q", kind: "quietDates", server: "*", tool: "*", value: [{ from: "11-08", to: "11-08" }] });
    const rules: GuardrailRule[] = [];
    const chat = guarded({ three: { level: 3 } }, rules);
    const held = await heldBy(chat.write("three", { discount: 3 }));
    if (held.outcome !== "held") throw new Error("not held");
    rules.push(quiet);
    chat.clock.now = Date.UTC(2026, 10, 8, 12);
    expect(await heldBy(chat.approve(held.action.id))).toMatchObject({ outcome: "refused", message: expect.stringMatching(/blocks it now/) });
    expect(chat.server.calls).toEqual([]);
  });

  it("maxChange reads the current value through the named read tool", async () => {
    const change = rule({
      kind: "maxChange",
      tool: "update_deal",
      arg: "discount",
      value: 10,
      percent: true,
      current: { tool: "get_deal", input: { id: "{{input.id}}" }, path: "price" },
    });
    const chat = guarded({ four: { level: 4 } }, [change]);
    expect(await heldBy(chat.write("four", { id: 3, discount: 150 }))).toMatchObject({ outcome: "refused" });
    expect(chat.server.calls).toEqual([{ name: "get_deal", args: { id: 3 } }]);
    await chat.write("four", { id: 3, discount: 105 });
    expect(chat.server.calls.at(-1)).toEqual({ name: "update_deal", args: { id: 3, discount: 105 } });
  });

  it("callsPerDay counts the calls that ran today", async () => {
    const chat = guarded({ four: { level: 4 } }, [rule({ kind: "callsPerDay", value: 2 })]);
    await chat.write("four", {});
    await chat.write("four", {});
    expect(await heldBy(chat.write("four", {}))).toMatchObject({ outcome: "refused", message: expect.stringMatching(/2 times today/) });
    expect(chat.server.calls).toHaveLength(2);
  });

  it("a test run changes nothing", async () => {
    const chat = guarded({ run: { level: 4 } });
    const verdict = await heldBy(chat.hub.call("crm", "update_deal", {}, { kind: "run", agentId: "a", dueAt: 1, item: "", step: "0", test: true }));
    expect(verdict).toMatchObject({ outcome: "refused", message: expect.stringMatching(/test/) });
    expect(chat.server.calls).toEqual([]);
  });

  it("a page cannot wait for an approval: what would be held is refused", async () => {
    const chat = guarded({ page: { level: 4, noHold: true } }, [discountRule("approve")]);
    expect(await heldBy(chat.write("page", { discount: 50 }))).toMatchObject({ outcome: "refused", message: expect.stringMatching(/cannot wait/) });
    expect(chat.held).toEqual([]);
  });
});

describe("pending actions", () => {
  const action = (over: Partial<NewAction> = {}): NewAction => ({
    kind: "approval",
    actor: { name: "deals", agentId: "a".repeat(16) },
    server: "crm",
    tool: "update_deal",
    input: { discount: 5 },
    why: "at Approve",
    expiresAt: T0 + 3_600_000,
    origin: { session: "3", level: 3 },
    ...over,
  });

  it("end once: a press and its expiry, or two presses, decide it once", () => {
    const actions = new ChatActions(
      memorySql(),
      () => "chat-1",
      () => T0,
    );
    const one = actions.add(action());
    expect(actions.pending().map((view) => view.id)).toEqual([one.id]);
    expect(actions.move(one.id, "pending", "declined")).toMatchObject({ status: "declined", decidedAt: T0 });
    expect(actions.move(one.id, "pending", "expired")).toBeNull();
    expect(actions.get(one.id)?.status).toBe("declined");
    expect(actions.origin(one.id)).toEqual({ session: "3", level: 3 });
  });

  it("keep what an approved call came to, and find the ones a restart cut off", () => {
    const actions = new ChatActions(
      memorySql(),
      () => "chat-1",
      () => T0,
    );
    const one = actions.add(action());
    actions.move(one.id, "pending", "running");
    expect(actions.interrupted().map((view) => view.id)).toEqual([one.id]);
    expect(actions.move(one.id, "running", "done", "x".repeat(5_000))?.result).toHaveLength(2_000);
  });
});

describe("the owner's directory of limits", () => {
  const kv = () => {
    const map = new Map<string, unknown>();
    return {
      get: <T>(key: string) => map.get(key) as T | undefined,
      put: (key: string, value: unknown) => void map.set(key, value),
      delete: (key: string) => map.delete(key),
    };
  };

  it("keeps rules for all agents, checked", () => {
    const limits = new LimitsDirectory(memorySql(), kv());
    expect(limits.setRules([{ id: "x", kind: "nope" }])).toHaveProperty("error");
    expect(limits.setRules([rule({ kind: "callsPerDay", value: 3 })])).toHaveLength(1);
    expect(limits.rules()).toMatchObject([{ kind: "callsPerDay", value: 3 }]);
  });

  it("counts the calls that ran since a time, in every chat", () => {
    let now = T0;
    const limits = new LimitsDirectory(memorySql(), kv(), () => now);
    limits.log({ chatId: "c1", actor: "@deals", server: "crm", tool: "update_deal", outcome: "ran" });
    limits.log({ chatId: "c2", actor: "pi", server: "crm", tool: "update_deal", outcome: "warned" });
    limits.log({ chatId: "c2", actor: "pi", server: "crm", tool: "update_deal", outcome: "refused" });
    now += 1_000;
    expect(limits.callsSince("crm", "update_deal", T0)).toBe(2);
    expect(limits.callsSince("crm", "update_deal", T0 + 1)).toBe(0);
    expect(limits.calls("@deals")).toMatchObject([{ actor: "@deals", outcome: "ran" }]);
  });

  it("lists what waits, and drops what its chat never said expired", () => {
    let now = T0;
    const limits = new LimitsDirectory(memorySql(), kv(), () => now);
    const item = {
      id: "b".repeat(16),
      chatId: "c1",
      chatTitle: "Deals",
      kind: "approval",
      actor: { name: "pi" },
      server: "crm",
      tool: "t",
      input: {},
      why: "",
      createdAt: T0,
      expiresAt: T0 + 10,
      status: "pending",
    } as const;
    limits.addNeedsYou(item);
    expect(limits.needsYou()).toHaveLength(1);
    now += 11;
    expect(limits.needsYou()).toHaveLength(0);
  });
});

describe("telling through an outside tool", () => {
  const telling = { to: ["ana@example.com", "bo@example.com"], text: "The report.", subject: "@brief, daily" };

  it("puts the recipients and the text in the fields the tool's schema has for them", () => {
    const schema = {
      type: "object",
      properties: { to: { type: "array" }, subject: { type: "string" }, body: { type: "string" } },
      required: ["to", "body"],
    };
    expect(toolInput(schema, telling)).toEqual({ to: ["ana@example.com", "bo@example.com"], subject: "@brief, daily", body: "The report." });
    expect(toolInput({ properties: { channel: { type: "string" }, text: { type: "string" } } }, telling)).toEqual({
      channel: "ana@example.com, bo@example.com",
      text: "The report.",
    });
  });

  it("says what it cannot fill rather than guess", () => {
    expect(toolInput({ properties: { a: {}, b: {} } }, telling)).toHaveProperty("error", expect.stringMatching(/a, b/));
    expect(toolInput({ properties: { to: {}, text: {}, priority: {} }, required: ["priority"] }, telling)).toHaveProperty(
      "error",
      expect.stringMatching(/priority/),
    );
  });
});
