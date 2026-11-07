import type { EntryRecord } from "@earendil-works/pi-durable";
import { describe, expect, it } from "vitest";
import { AGENT_PROPOSE_TOOL, CHAT_AGENT_KIND } from "../shared/agents.ts";
import { MAX_OFFER, OFFER_PREFIX, OFFER_RULE, offerOf, offerYes } from "../shared/offers.ts";
import { CHAT_MESSAGE_KIND } from "../shared/protocol.ts";
import { assistantOffer, entryOffer, liveOffer } from "../src/chat/entries.ts";

describe("offerOf", () => {
  it("takes a plain last line that starts with the prefix", () => {
    expect(offerOf("Signups fell 6% this week.\n\nNext step: Send this to Maria every Monday?")).toEqual({
      body: "Signups fell 6% this week.",
      offer: "Send this to Maria every Monday?",
    });
  });

  it("reads the prefix in any case", () => {
    expect(offerOf("Done.\nNEXT STEP: run it daily?")?.offer).toBe("run it daily?");
    expect(offerOf("Done.\nnext step:run it daily?")?.offer).toBe("run it daily?");
  });

  it("allows Markdown emphasis round the prefix or the whole line", () => {
    const want = { body: "Here is the summary.", offer: "Check this every morning?" };
    expect(offerOf("Here is the summary.\n**Next step:** Check this every morning?")).toEqual(want);
    expect(offerOf("Here is the summary.\n**Next step**: Check this every morning?")).toEqual(want);
    expect(offerOf("Here is the summary.\n_Next step:_ Check this every morning?")).toEqual(want);
    expect(offerOf("Here is the summary.\n_Next step: Check this every morning?_")).toEqual(want);
    expect(offerOf("Here is the summary.\n***Next step:*** **Check this every morning?**")).toEqual(want);
  });

  it("allows a leading quote mark", () => {
    expect(offerOf("Here is the summary.\n\n> Next step: Check this every morning?")).toEqual({
      body: "Here is the summary.",
      offer: "Check this every morning?",
    });
    expect(offerOf("Here is the summary.\n> **Next step:** Check it hourly?")?.offer).toBe("Check it hourly?");
  });

  it("is null when the offer is not the last line", () => {
    expect(offerOf("Next step: send it weekly?\nAnything else?")).toBeNull();
    expect(offerOf("Done.\nNext step: send it weekly?\n\nLet me know.")).toBeNull();
  });

  it("is null when it asks nothing, or for an empty text", () => {
    expect(offerOf("Done.\nNext step:")).toBeNull();
    expect(offerOf("Done.\n**Next step:** ** ")).toBeNull();
    expect(offerOf("")).toBeNull();
    expect(offerOf("  \n\n ")).toBeNull();
  });

  it("is null when the offer is the whole text", () => {
    expect(offerOf("Next step: send it weekly?")).toBeNull();
    expect(offerOf("\n\n  Next step: send it weekly?  \n")).toBeNull();
  });

  it("is null for a last line that only mentions a next step", () => {
    expect(offerOf("Done.\nThe next step: none.")).toBeNull();
    expect(offerOf("Done.\nNext steps: none.")).toBeNull();
  });

  it("ignores trailing spaces and newlines, and trims the body", () => {
    expect(offerOf("\n  Report ready.  \n\nNext step:   Send it on Fridays?   \n\n  \n")).toEqual({
      body: "Report ready.",
      offer: "Send it on Fridays?",
    });
    expect(offerOf("Report ready.\r\nNext step: Send it on Fridays?\r\n")?.body).toBe("Report ready.");
  });

  it("never cuts an offer: a last line longer than MAX_OFFER is no offer, and stays in the text", () => {
    const long = `Next step: Send this every Monday? ${"Also write the totals into the shared sheet and email the team. ".repeat(4)}`;
    expect(long.length).toBeGreaterThan(MAX_OFFER);
    expect(offerOf(`Report ready.\n${long}`)).toBeNull();
    const fits = `Send it ${"on Monday ".repeat(10)}?`;
    expect(offerOf(`Report ready.\nNext step: ${fits}`)?.offer).toBe(fits);
  });

  it("answers Yes with the offer as it was read, asking only for a draft routine", () => {
    const said = offerYes("Send this summary every Monday at 09:00?");
    expect(said).toContain('"Send this summary every Monday at 09:00?"');
    expect(said).toContain(AGENT_PROPOSE_TOOL);
    expect(said).toMatch(/Don't do anything else/);
  });

  it("states the rule with the prefix and the tool that drafts a routine", () => {
    expect(OFFER_RULE).toContain(OFFER_PREFIX);
    expect(OFFER_RULE).toContain(AGENT_PROPOSE_TOOL);
  });
});

let nextId = 1;
const pi = (...content: unknown[]) =>
  ({ id: nextId++, conversationId: 0, kind: "pi.assistant", model: [{ role: "assistant", content, timestamp: 0 }] }) as unknown as EntryRecord;
const text = (value: string) => ({ type: "text", text: value });
const agent = (value: string) => ({ id: nextId++, conversationId: 0, kind: CHAT_AGENT_KIND, data: { text: value } }) as unknown as EntryRecord;
const replyTo = (id: number) =>
  ({ id: nextId++, conversationId: 0, kind: CHAT_MESSAGE_KIND, data: { text: "Yes", replyTo: { id } } }) as unknown as EntryRecord;
const OFFERED = "Report ready.\nNext step: Send it every Monday?";

describe("offers in the transcript", () => {
  it("finds pi's offer in its last text, unless a tool call comes after it", () => {
    expect(
      assistantOffer([text("Looking."), { type: "thinking", thinking: "…" }, text(OFFERED), { type: "thinking", thinking: "done" }] as never),
    ).toEqual({
      block: 2,
      body: "Report ready.",
      offer: "Send it every Monday?",
    });
    expect(assistantOffer([text(OFFERED), { type: "toolCall", id: "1", name: "x", arguments: {} }] as never)).toBeNull();
    expect(entryOffer(agent(OFFERED))).toBe("Send it every Monday?");
    expect(entryOffer(agent("No offer here."))).toBeUndefined();
  });

  it("keeps only the latest offer live, until someone replies to it", () => {
    const first = pi(text(OFFERED));
    const second = agent(OFFERED);
    const after = pi(text("Something else."));
    expect(liveOffer([first, second, after])).toBe(second.id);
    expect(liveOffer([first, after])).toBe(first.id);
    expect(liveOffer([first, second, replyTo(second.id as number)])).toBeUndefined();
    expect(liveOffer([first, second, replyTo(first.id as number)])).toBe(second.id);
    expect(liveOffer([after])).toBeUndefined();
  });
});
