import { createModels, fauxAssistantMessage, fauxToolCall, type Message } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { assistantText as said } from "../worker/agents/turns.ts";
import { agentProfile, cosine, INTEREST_THRESHOLD } from "../worker/agents/funnel.ts";
import { scriptEmbedder, scriptModel, scriptOn, scriptPauseMs, scriptReply, scriptSteps, stepsFor } from "../worker/dev-model.ts";

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

  it("gives each speaker its own part of a script (/for), as its instructions name it, and pi the rest", () => {
    const steps = scriptSteps("@alpha @beta /say for all /for alpha /say A /for beta /recall alpha · agent");
    expect(stepsFor(steps, "alpha")).toEqual([{ say: "for all" }, { say: "A" }]);
    expect(stepsFor(steps, "beta")).toEqual([{ say: "for all" }, { recall: "alpha · agent" }]);
    expect(stepsFor(steps, "pi")).toEqual([{ say: "for all" }]);
    const ask = user("Your turn: ada asked you.\n\n[ada · person · your owner]: @alpha @beta /for alpha /say Alpha found 41 rows. /for beta /say B");
    expect(said(scriptReply([system("In this chat you are @alpha, one of its agents"), ask]))).toBe("Alpha found 41 rows.");
    expect(said(scriptReply([system("You are an agent.", { agent: "In this chat you are @beta, one of its agents" }), ask]))).toBe("B");
    // pi has no part of its own here: nothing for it, so ok.
    expect(said(scriptReply([ask]))).toMatch(/^ok: /);
  });

  it("recalls the newest line it read before its turn that holds the text, never a script line", () => {
    const catchUp = user("What was said in the chat since your last turn:\n\n[ada · person]: @alpha /recall alpha · agent\n\n[alpha · agent]: Alpha found 41 rows.");
    const turn = user("Your turn: ada asked you.\n\n[ada · person]: /recall alpha · agent");
    expect(said(scriptReply([catchUp, turn]))).toBe("recalled: [alpha · agent]: Alpha found 41 rows.");
    expect(said(scriptReply([user("[ada · person]: hi"), user("/recall code word")]))).toBe('recalled nothing for "code word"');
  });

  it("pads a reply with filler, and puts the draft an earlier write answered with into a tool's input", () => {
    const padded = said(scriptReply([user("/pad 1000 @beta over to you")]));
    expect(padded.startsWith("@beta over to you\n\nfiller filler")).toBe(true);
    expect(padded.length).toBe("@beta over to you\n\n".length + 1000);
    const script = user('/tool artifact_write {"html":"<p>x</p>"}\n/tool artifact_publish {"title":"T","draft_id":"{{draft}}"}');
    const publish = scriptReply([script, called("artifact_write"), result("artifact_write", 'Saved as draft "0a1b2c3d4e5f6a7b" (1 KB).')]);
    expect(publish.content).toEqual([expect.objectContaining({ name: "artifact_publish", arguments: { title: "T", draft_id: "0a1b2c3d4e5f6a7b" } })]);
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
  });
});
