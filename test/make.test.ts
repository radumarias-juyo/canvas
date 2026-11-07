import { describe, expect, it } from "vitest";
import { autoMake, makeNote, MAKE_CHOICES, MAKE_KINDS, parseMake, resolveMake } from "../shared/make.ts";

describe("the composer's Make choice", () => {
  it("takes a schedule or a watch for an agent on Auto", () => {
    for (const text of [
      "Every morning, send me where each region's month will land.",
      "each Monday summarise the open deals",
      "Post a daily digest of new signups here",
      "every 2 hours check the queue length",
      "On weekdays at 9 give me the support backlog",
      "When signups drop 5% behind last year, tell me",
      "whenever a deal closes let me know",
      "Tell me when the error rate goes above 2%",
      "notify me as soon as a new invoice arrives",
      "If the backlog is over 50, ping the team",
      "let us know once the import is done",
    ]) {
      expect(autoMake(text), text).toBe("agent");
    }
  });

  it("leaves questions, one-off asks and the past to the model on Auto", () => {
    for (const text of [
      "What were sales every day last week?",
      "How did signups do each month so far this year?",
      "Chart the revenue from yesterday",
      "When did West start falling? Tell me why.",
      "If you can, tell me what the forecast says",
      "Tell me when the meeting is",
      "Build a page with this quarter's signups by region",
      "What is the weather like?",
      "",
    ]) {
      expect(autoMake(text), text).toBeNull();
    }
  });

  it("goes with the choice made, and on Auto with what the message reads as", () => {
    expect(resolveMake(undefined, "every morning send me the numbers")).toBeNull();
    expect(resolveMake("auto", "every morning send me the numbers")).toBe("agent");
    expect(resolveMake("auto", "what is 2+2")).toBeNull();
    // A choice made stands, whatever the words say.
    expect(resolveMake("answer", "every morning send me the numbers")).toBe("answer");
    expect(resolveMake("page", "what is 2+2")).toBe("page");
  });

  it("says each choice to the model through the tool that makes it, and nothing on an Auto that reads as nothing", () => {
    expect(makeNote("agent", "x")).toContain("agent_propose");
    expect(makeNote("auto", "every morning tell me the numbers")).toContain("agent_propose");
    expect(makeNote("page", "x")).toContain("artifact_publish");
    expect(makeNote("tool", "x")).toContain("skill_propose");
    expect(makeNote("answer", "x")).toMatch(/reply here/);
    expect(makeNote("auto", "hello")).toBe("");
    expect(makeNote(undefined, "every morning tell me")).toBe("");
  });

  it("reads only its own kinds from a client, and lists each once with Auto first", () => {
    expect(MAKE_KINDS.map(parseMake)).toEqual([...MAKE_KINDS]);
    for (const value of ["Agent", "workflow", 3, null, undefined, {}]) expect(parseMake(value)).toBeUndefined();
    expect(MAKE_CHOICES.map((choice) => choice.kind)).toEqual(["auto", "answer", "page", "agent", "tool"]);
  });
});
