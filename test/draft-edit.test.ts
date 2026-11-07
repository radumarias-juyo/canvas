import { describe, expect, it } from "vitest";
import { checkAgent, type AgentDefinition } from "../shared/agents.ts";
import {
  applyRowEdit,
  applySentenceEdit,
  daysOf,
  daysWords,
  linkedSegments,
  listWords,
  lockedServers,
  replaceStep,
  rewriteNames,
  rewriteSchedule,
  rowsFromSentence,
  type Known,
} from "../src/agents/draft-edit.ts";
import { glanceRows } from "../src/agents/glance.ts";

const T0 = 1_000_000;
const INSTRUCTIONS = [
  "Every day at 07:00, for each region:",
  "1. Look at signups-db and forecast.",
  "2. Work out where the month lands, with the forecasting skill.",
  "3. Tell the leads by email: lead@example.com.",
].join("\n");

/** The mockup's draft, as the model would save it: its schedule and delivery guessed. */
function draft(over: Partial<AgentDefinition> = {}): AgentDefinition {
  return {
    id: "a1",
    name: "brief",
    avatar: "br",
    color: "teal",
    job: "Where each region's month will land",
    instructions: INSTRUCTIONS,
    servers: ["signups-db", "forecast", "mail"],
    trigger: { kind: "schedule", at: "07:00", tz: "Europe/Bucharest" },
    scope: { list: { kind: "look", server: "signups-db", tool: "regions", input: {} }, each: true },
    workflow: [
      { kind: "look", server: "signups-db", tool: "signups", input: { region: "{{item}}" } },
      { kind: "look", server: "forecast", tool: "month", input: {} },
      { kind: "work", prompt: "Where does the month land?", skill: "forecasting" },
      { kind: "tell", to: ["lead@example.com"], via: { server: "mail", tool: "send" } },
    ],
    autonomy: 1,
    assumed: ["tells", "trigger"],
    origin: "agent",
    enabled: false,
    version: 1,
    createdAt: T0,
    updatedAt: T0,
    ...over,
  };
}

const known: Known = { servers: ["signups-db", "forecast", "mail", "crm"], skills: ["forecasting", "summaries"], people: ["Ana"] };
/** The input checked as the server would save it: a row edit never makes a definition it refuses. */
const saved = (input: Parameters<typeof checkAgent>[0]) => checkAgent(input);

describe("the instructions' linked words", () => {
  it("links each word that names a row, a guessed row's words as assumed", () => {
    const linked = linkedSegments(INSTRUCTIONS, draft(), known).filter((segment) => segment.row);
    expect(linked.map((segment) => [segment.text, segment.row, segment.assumed])).toEqual([
      ["Every day", "runs", true],
      ["07:00", "runs", true],
      ["signups-db", "reads", false],
      ["forecast", "reads", false],
      ["forecasting", "knows", false],
      ["lead@example.com", "tells", true],
    ]);
    // Every character is kept, in order.
    expect(
      linkedSegments(INSTRUCTIONS, draft(), known)
        .map((segment) => segment.text)
        .join(""),
    ).toBe(INSTRUCTIONS);
  });

  it("takes a name only as a whole word, the longest where two overlap", () => {
    const text = "Read crm-eu, then crm.";
    const linked = linkedSegments(text, draft({ instructions: text }), { ...known, servers: ["crm", "crm-eu"] }).filter((segment) => segment.row);
    expect(linked.map((segment) => segment.text)).toEqual(["crm-eu", "crm"]);
  });
});

describe("a row changed rewrites the sentence it came from", () => {
  it("changes a schedule's time and days in its sentence, and confirms the guess", () => {
    const weekdays = ["mon", "tue", "wed", "thu", "fri"] as const;
    const trigger = { kind: "schedule" as const, at: "08:30", tz: "Europe/Bucharest", days: [...weekdays] };
    const { input, rewrite } = applyRowEdit(draft(), { key: "runs", trigger });
    expect(rewrite).toBe("sentence");
    expect(input.instructions.split("\n")[0]).toBe("Every weekday at 08:30, for each region:");
    expect(input.trigger).toEqual({ kind: "schedule", at: "08:30", tz: "Europe/Bucharest", days: ["mon", "tue", "wed", "thu", "fri"] });
    expect(input.assumed).toEqual(["tells"]);
    expect(saved(input).trigger).toEqual(input.trigger);
  });

  it("replaces the servers a sentence lists, as one list in words", () => {
    const { input, rewrite } = applyRowEdit(draft(), { key: "reads", servers: ["signups-db", "forecast", "crm", "mail"] });
    expect(rewrite).toBe("sentence");
    expect(input.instructions.split("\n")[1]).toBe("1. Look at signups-db, forecast, crm and mail.");
    expect(saved(input).servers).toEqual(["signups-db", "forecast", "crm", "mail"]);
  });

  it("swaps the skill its work step uses, there and in the sentence", () => {
    const { input } = applyRowEdit(draft(), { key: "knows", skill: "summaries" });
    expect(input.instructions).toContain("with the summaries skill.");
    expect(input.workflow?.find((step) => step.kind === "work")).toMatchObject({ skill: "summaries" });
    const rows = glanceRows({ ...draft(), ...saved(input) });
    expect(rows.find((row) => row.key === "knows")?.value).toBe("summaries skill");
  });

  it("changes who it tells through the same tool, and the scope's tool", () => {
    const tells = applyRowEdit(draft(), { key: "tells", to: ["boss@example.com"], via: { server: "mail", tool: "send" } });
    expect(tells.rewrite).toBe("sentence");
    expect(tells.input.instructions).toContain("Tell the leads by email: boss@example.com.");
    expect(tells.input.assumed).toEqual(["trigger"]);
    const scope = applyRowEdit(draft({ instructions: "1. For each of the regions, look at signups-db." }), {
      key: "scope",
      list: { server: "signups-db", tool: "areas" },
    });
    expect(scope.input.scope?.list).toMatchObject({ server: "signups-db", tool: "areas" });
    expect(scope.rewrite).toBe("sentence");
    expect(scope.input.instructions).toBe("1. For each of the areas, look at signups-db.");
  });

  it("adds a short line when no sentence names the row, and replaces its own line the next time", () => {
    const plain = draft({ instructions: "1. Sum up the week." });
    const once = applyRowEdit(plain, { key: "tells", to: ["owner"], via: "notify" });
    expect(once.rewrite).toBe("line");
    expect(once.input.instructions).toBe("1. Sum up the week.\n\nTells: You, by a notification.");
    const twice = applyRowEdit({ ...plain, ...saved(once.input) }, { key: "tells", to: ["owner"], via: "chat" });
    expect(twice.input.instructions).toBe("1. Sum up the week.\n\nTells: You, in the chat.");
    // A sentence it cannot rewrite as a list (the names are apart): a line, never a broken sentence.
    const apart = draft({ instructions: "1. Read signups-db first; when that is done, compare with forecast." });
    const reads = applyRowEdit(apart, { key: "reads", servers: ["crm", "mail", "signups-db", "forecast"] });
    expect(reads.rewrite).toBe("line");
    expect(reads.input.instructions).toBe(
      "1. Read signups-db first; when that is done, compare with forecast.\n\nReads: Crm, mail, signups-db and forecast.",
    );
  });

  it("changes nothing in the text for a row set to what it was", () => {
    const { input, rewrite } = applyRowEdit(draft(), { key: "reads", servers: ["mail", "forecast", "signups-db"] });
    expect(rewrite).toBe("none");
    expect(input.instructions).toBe(INSTRUCTIONS);
  });

  it("keeps the servers a step reads: the Reads row cannot drop them", () => {
    expect(lockedServers(draft()).sort()).toEqual(["forecast", "mail", "signups-db"]);
  });
});

describe("a sentence edited changes its rows", () => {
  it("moves the schedule when its sentence says another time and days", () => {
    const agent = draft({ instructions: "1. Every day at 07:00, look at signups-db.\n2. Tell me." });
    const { input, touched } = applySentenceEdit(agent, 0, "On Mon and Thu at 9:15, look at signups-db.", known);
    expect(input.instructions).toBe("1. On Mon and Thu at 9:15, look at signups-db.\n2. Tell me.");
    expect(input.trigger).toEqual({ kind: "schedule", at: "09:15", tz: "Europe/Bucharest", days: ["mon", "thu"] });
    expect(touched).toEqual(["runs"]);
    expect(input.assumed).toEqual(["tells"]);
    expect(saved(input).trigger).toEqual(input.trigger);
  });

  it("adds a server the sentence names now, and drops one it no longer names unless a step reads it", () => {
    const agent = draft({ servers: ["signups-db", "forecast", "mail", "docs"] });
    const withDocs = { ...known, servers: [...known.servers, "docs"] };
    const { changes, touched } = rowsFromSentence(agent, "Look at signups-db, forecast and docs.", "Look at signups-db and crm.", withDocs);
    // forecast stays: a step reads it. docs goes; crm comes.
    expect(changes.servers).toEqual(["signups-db", "forecast", "mail", "crm"]);
    expect(touched).toEqual(["reads"]);
  });

  it("sets the skill its work step uses, and the addresses it tells through its tool", () => {
    const skill = rowsFromSentence(draft(), "Work it out, with the forecasting skill.", "Work it out, with the summaries skill.", known);
    expect(skill.changes.workflow?.find((step) => step.kind === "work")).toMatchObject({ skill: "summaries" });
    const tell = rowsFromSentence(draft(), "Tell the leads: lead@example.com.", "Tell the leads: lead@example.com, cfo@example.com.", known);
    expect(tell.changes.workflow?.find((step) => step.kind === "tell")).toMatchObject({ to: ["lead@example.com", "cfo@example.com"] });
    expect(tell.touched).toEqual(["tells"]);
  });

  it("changes no row for an edit that names nothing new, and keeps the rest of the steps", () => {
    const { changes, touched } = rowsFromSentence(draft(), "Work out where the month lands.", "Work out where the month will land, briefly.", known);
    expect(changes).toEqual({});
    expect(touched).toEqual([]);
  });

  it("rewrites the whole text when the instructions have no numbered steps", () => {
    const agent = draft({ instructions: "Sum up the day at 07:00." });
    const { input } = applySentenceEdit(agent, 0, "Sum up the day at 18:00.", known);
    expect(input.instructions).toBe("Sum up the day at 18:00.");
    expect(input.trigger).toMatchObject({ at: "18:00" });
  });
});

describe("the words a sync uses", () => {
  it("says lists, days and replaces steps", () => {
    expect(listWords(["a"])).toBe("a");
    expect(listWords(["a", "b", "c"])).toBe("a, b and c");
    expect(daysWords(undefined)).toBe("every day");
    expect(daysWords(["sat", "sun"])).toBe("every weekend");
    expect(daysWords(["mon", "wed"])).toBe("on Mon, Wed");
    expect(daysOf("on Mondays and Wednesdays")).toEqual(["mon", "wed"]);
    expect(daysOf("weekdays")).toEqual(["mon", "tue", "wed", "thu", "fri"]);
    expect(daysOf("daily")).toBeUndefined();
    expect(daysOf("soon")).toBeNull();
    expect(replaceStep("Intro\n1. One.\n   more of one\n2. Two.", 0, "First.")).toBe("Intro\n1. First.\n2. Two.");
    expect(rewriteNames("Read a and b.", ["c"], ["d"])).toBeNull();
    expect(rewriteSchedule("Every day at 7:00.", { kind: "schedule", at: "07:00", tz: "UTC" }, { kind: "schedule", at: "06:45", tz: "UTC" })).toBe(
      "Every day at 06:45.",
    );
  });
});
