import { createModels, fauxAssistantMessage, fauxToolCall, type Message } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { assistantText as said } from "../worker/agents/turns.ts";
import { scriptModel, scriptOn, scriptReply, scriptSteps } from "../worker/dev-model.ts";

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
});
