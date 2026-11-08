import { createModels, fauxAssistantMessage, fauxToolCall, type Message } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { assistantText as said } from "../worker/agents/turns.ts";
import { agentProfile, cosine, INTEREST_THRESHOLD } from "../worker/agents/funnel.ts";
import { scriptEmbedder, scriptGapMs, scriptModel, scriptOn, scriptPauseMs, scriptReply, scriptSteps, scriptWorkflow } from "../worker/dev-model.ts";
import { compilePrompt, compileWorkflow, type ServerTools } from "../worker/agents/runs/compile.ts";
import type { AgentDefinition } from "../shared/agents.ts";

const user = (text: string): Message => ({ role: "user", content: text, timestamp: 0 });
const system = (text: string, sections?: Record<string, string>): Message => ({ role: "system", content: text, ...(sections && { sections }), timestamp: 0 });
const called = (name: string, input = {}): Message => fauxAssistantMessage(fauxToolCall(name, input, { id: "c1" }), { stopReason: "toolUse" });
const result = (name: string, text: string, isError = false): Message => ({
  role: "toolResult",
  toolCallId: "c1",
  toolName: name,
  content: [{ type: "text", text }],
  isError,
  timestamp: 0,
});

describe("the scripted dev model", () => {
  it("is on only with DEV_MODEL=script and DEV_TOOLS=true", () => {
    expect(scriptOn({ DEV_MODEL: "script", DEV_TOOLS: "true" })).toBe(true);
    expect(scriptOn({ DEV_MODEL: "script", DEV_TOOLS: "false" })).toBe(false);
    expect(scriptOn({ DEV_MODEL: "", DEV_TOOLS: "true" })).toBe(false);
    expect(scriptOn({})).toBe(false);
  });

  it("reads /say and /tool lines, after other text too", () => {
    expect(scriptSteps("@helper /say hello from the agent")).toEqual([{ say: "hello from the agent" }]);
    expect(scriptSteps('/tool crm.list_deals {"stage":"won"}\n/say done')).toEqual([{ tool: "crm__list_deals", input: { stage: "won" } }, { say: "done" }]);
    expect(scriptSteps("/tool checklist")).toEqual([{ tool: "checklist", input: {} }]);
    expect(scriptSteps("/tool crm.update_deal {oops")[0]).toEqual({ say: expect.stringContaining("the input is not JSON") });
    // A marker inside a /tool line's JSON is part of its input.
    expect(scriptSteps('/tool crm.note {"text":"see /say this"}\n/say done')).toEqual([{ tool: "crm__note", input: { text: "see /say this" } }, { say: "done" }]);
    expect(scriptSteps("a path like x/say is no script")).toEqual([]);
    // A turn's ask indents a message's further lines: the reply has them as written.
    expect(scriptSteps("[ada · person · your owner]: /say Summary ready.\n  Next step: Send this every Monday?")).toEqual([
      { say: "Summary ready.\nNext step: Send this every Monday?" },
    ]);
    // In instructions, only lines that start with one.
    expect(scriptSteps("Say /say hi when asked", true)).toEqual([]);
    expect(scriptSteps("Your owner wrote:\n/say from the\ninstructions\n\nThe rules: …", true)).toEqual([{ say: "from the\ninstructions" }]);
  });

  it("says, calls a tool, then names it with the start of its result", () => {
    expect(said(scriptReply([user("/say hi there")]))).toBe("hi there");
    const call = scriptReply([user('/tool crm.update_deal {"id":"d1","stage":"won"}')]);
    expect(call.stopReason).toBe("toolUse");
    expect(call.content).toEqual([expect.objectContaining({ type: "toolCall", name: "crm__update_deal", arguments: { id: "d1", stage: "won" } })]);
    const after = scriptReply([user("/tool crm.update_deal {}"), called("crm__update_deal"), result("crm__update_deal", "Tool not allowed", true)]);
    expect(said(after)).toBe("crm__update_deal failed: Tool not allowed");
    const next = scriptReply([user("/tool crm.list_deals {}\n/say listed them"), called("crm__list_deals"), result("crm__list_deals", "{}")]);
    expect(said(next)).toBe("listed them");
  });

  it("answers anything else with ok and the message, and never follows an earlier turn's script", () => {
    expect(said(scriptReply([user("[ada · person]: how are the deals?")]))).toBe("ok: how are the deals?");
    const earlier = [user("/tool crm.list_deals {}"), called("crm__list_deals"), result("crm__list_deals", "{}"), fauxAssistantMessage("crm__list_deals: {}")];
    expect(said(scriptReply([...earlier, user("thanks")]))).toBe("ok: thanks");
  });

  it("falls back to script lines in the instructions", () => {
    const instructions = system("You are an agent.", {
      agent: 'Your owner wrote these instructions for you:\n/tool agent_propose {"name":"weekly"}\n\nHow the chat works for you: …',
    });
    const reply = scriptReply([instructions, user("Yes to the next step your message offers")]);
    expect(reply.content).toEqual([expect.objectContaining({ type: "toolCall", name: "agent_propose", arguments: { name: "weekly" } })]);
    // The message's own script wins.
    expect(said(scriptReply([instructions, user("/say mine")]))).toBe("mine");
    // An agent's catch-up comes before its turn's message: a script in it is only what someone else said.
    const catchUp = user("What was said in the chat since your last turn:\n\n[ada · person]: @helper /say not for you");
    const relay = system("Instructions:\n/say @pi please summarise");
    expect(said(scriptReply([relay, catchUp, user("Your turn: ada asked you.\n\n[ada · person]: @relay over to you")]))).toBe("@pi please summarise");
  });

  it("answers every call through pi-ai's models", async () => {
    const { provider, model } = scriptModel();
    const models = createModels();
    models.setProvider(provider);
    for (const text of ["one", "two", "three"]) {
      const reply = await models.completeSimple(model, { messages: [user(`/say ${text}`)] });
      expect(said(reply)).toBe(text);
    }
  });

  it("stands in for the interest model: texts are as close as the words they share", async () => {
    const signal = AbortSignal.timeout(1_000);
    const profile = (name: string, job: string, instructions: string) => agentProfile({ name, job, instructions });
    const [subject, same, tracker, dispatch, planner, short] = await scriptEmbedder.embed(
      [
        "Shipping delays at the warehouse\nok: Shipping delays at the warehouse",
        "shipping DELAYS, warehouse!",
        profile("tracker", "Shipping delays at the warehouse", "/say Shipping delays at the warehouse: two orders are past due."),
        profile("dispatch", "Warehouse shipping", "/say Noted: warehouse shipping."),
        profile("planner", "Plans the recurring reports", "1. List the deals."),
        "at the a of",
      ],
      signal,
    );
    expect(cosine(subject, same)).toBeCloseTo(1);
    // What the e2e suite's speak-up flow counts on: the closer agent wins, and the other is past the threshold too.
    expect(cosine(subject, tracker)).toBeGreaterThan(cosine(subject, dispatch));
    expect(cosine(subject, dispatch)).toBeGreaterThanOrEqual(INTEREST_THRESHOLD);
    expect(cosine(subject, planner)).toBe(0);
    // Words under four letters do not count.
    expect(short.every((n) => n === 0)).toBe(true);
  });

  it("shortens the pause before speaking up only on the scripted model", () => {
    expect(scriptPauseMs({ DEV_MODEL: "script", DEV_TOOLS: "true", DEV_PAUSE_MS: "1500" })).toBe(1500);
    expect(scriptPauseMs({ DEV_MODEL: "", DEV_TOOLS: "true", DEV_PAUSE_MS: "1500" })).toBeUndefined();
    expect(scriptPauseMs({ DEV_MODEL: "script", DEV_TOOLS: "false", DEV_PAUSE_MS: "1500" })).toBeUndefined();
    expect(scriptPauseMs({ DEV_MODEL: "script", DEV_TOOLS: "true" })).toBeUndefined();
    expect(scriptPauseMs({ DEV_MODEL: "script", DEV_TOOLS: "true", DEV_PAUSE_MS: "soon" })).toBeUndefined();
    expect(scriptGapMs({ DEV_MODEL: "script", DEV_TOOLS: "true", DEV_GAP_MS: "1000" })).toBe(1000);
    expect(scriptGapMs({ DEV_MODEL: "", DEV_TOOLS: "true", DEV_GAP_MS: "1000" })).toBeUndefined();
  });
});

describe("the scripted dev model compiles a workflow", () => {
  const agent: AgentDefinition = {
    id: "a1b2c3d4e5f60718",
    name: "brief",
    avatar: "br",
    color: "blue",
    job: "Where the deals stand",
    instructions: "1. Every weekday at 07:00, look at the deals in crm.\n2. Work out which deals moved.\n3. Say why they moved.\n\nTells: You, in the chat.",
    servers: ["crm", "vault"],
    autonomy: 1,
    origin: "agent",
    enabled: false,
    version: 1,
    createdAt: 1,
    updatedAt: 1,
  };
  const listed: ServerTools[] = [
    {
      server: "crm",
      tools: [
        { name: "update_deal", description: "Move a deal.", inputSchema: { type: "object" } },
        { name: "list_deals", description: "List deals.", inputSchema: { type: "object" }, annotations: { readOnlyHint: true } },
      ],
    },
    { server: "vault", tools: [{ name: "read_notes", description: "Notes.", annotations: { readOnlyHint: true } }] },
  ];

  it("answers the compile request with steps from the instructions' words, which the app takes as the agent's workflow", async () => {
    const { provider, model } = scriptModel();
    const models = createModels();
    models.setProvider(provider);
    const { workflow } = await compileWorkflow(models, model, agent, listed);
    // A look at each server the words name (its first read-only tool), the work the other steps say, and a tell.
    expect(workflow).toEqual([
      { kind: "look", server: "crm", tool: "list_deals", input: {} },
      { kind: "work", prompt: "Work out which deals moved.\nSay why they moved." },
      { kind: "tell", to: ["owner"], via: "chat" },
    ]);
    // Words edited: the steps follow them.
    const edited = { ...agent, instructions: "1. Read the notes in vault.\n2. Sum them up.\n\nTells: You, by a notification." };
    expect((await compileWorkflow(models, model, edited, listed)).workflow).toEqual([
      { kind: "look", server: "vault", tool: "read_notes", input: {} },
      { kind: "work", prompt: "Sum them up." },
      { kind: "tell", to: ["owner"], via: "notify" },
    ]);
  });

  it("answers only the compile request so: any other conversation goes by its script", () => {
    expect(scriptWorkflow("no sections here")).toBeNull();
    expect(said(scriptReply([system("You are pi."), user(compilePrompt(agent, listed))]))).toMatch(/^ok: /);
    expect(JSON.parse(scriptWorkflow(compilePrompt({ ...agent, instructions: "Just say hi." }, listed))!)).toEqual([
      { kind: "work", prompt: "Just say hi." },
      { kind: "tell", to: ["owner"], via: "chat" },
    ]);
  });
});
