import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { DreamRecord, DreamsView } from "../shared/dream.ts";
import type { MemoryNoteView } from "../shared/memory.ts";
import { citesText, dreamCost, dreamLine, LearnedOvernight } from "../src/memory/Dreams.tsx";

const AGENT = "a".repeat(16);
const NIGHT = Date.UTC(2026, 10, 7, 1, 0);

const record = (fields: Partial<DreamRecord> = {}): DreamRecord => ({
  subject: AGENT,
  day: "2026-11-06",
  status: "dreamt",
  at: NIGHT,
  learned: [],
  retired: [],
  waiting: [],
  costUsd: 0.0021,
  tokens: 6840,
  ...fields,
});

const note = (fields: Partial<MemoryNoteView>): MemoryNoteView => ({
  id: "a1a1a1a1a1a1",
  scope: "agent",
  agentId: AGENT,
  text: "Answer comparisons as a table.",
  source: "overnight",
  kind: "preference",
  learnedBy: "research",
  uses: 0,
  pinned: false,
  confirmed: true,
  createdAt: NIGHT,
  updatedAt: NIGHT,
  ...fields,
});

const view = (dreams: Record<string, DreamRecord[]> = {}): DreamsView => ({ settings: { piLearns: true, timeZone: "Europe/Bucharest" }, nextAt: null, dreams, nowAfter: {} });

describe("a dream's summary", () => {
  it("says what it learned, left to confirm and retired, and what it cost", () => {
    expect(dreamLine(record({ learned: ["x"], waiting: ["y", "z"], retired: ["w"] }))).toBe("Learned 1 note, 2 notes to confirm, retired 1 note.");
    expect(dreamLine(record({ status: "quiet", reason: "Nothing happened that day." }))).toBe("Nothing happened that day.");
    expect(dreamLine(record({ status: "skipped", reason: "past the cap" }))).toBe("Skipped: past the cap");
    expect(dreamLine(record())).toBe("Nothing worth keeping.");
    expect(dreamCost(record())).toBe("$0.0021 · 6,840 tokens");
    expect(dreamCost(record({ costUsd: 0, tokens: 0 }))).toBe("no model call");
  });

  it("names where a note came from: its messages and signals, and its chat when known", () => {
    const why = { text: "asked twice", cites: [{ chatId: "c1", seq: 4 }, { chatId: "c1", seq: 6 }, { chatId: "c1", signal: "corrected" as const }] };
    expect(citesText(why, { chatId: "c1", chatTitle: "Weekly numbers" })).toBe("From 2 messages and corrected in “Weekly numbers”");
    expect(citesText(why, {})).toBe("From 2 messages and corrected in a chat");
  });
});

describe("Learned overnight", () => {
  const render = (props: Partial<Parameters<typeof LearnedOvernight>[0]>) =>
    renderToStaticMarkup(
      <LearnedOvernight subject={AGENT} who="@research" notes={[]} dreams={view()} learns={true} onLearns={async () => {}} about="About." {...props} />,
    );

  it("shows the newest dream, the notes it wrote with Keep, Edit and Forget, and those waiting first", () => {
    const html = render({
      dreams: view({ [AGENT]: [record({ summary: "Tables, not prose.", learned: ["a1a1a1a1a1a1"], waiting: ["b2b2b2b2b2b2"] })] }),
      notes: [
        note({ confidence: 0.86, why: { text: "asked twice", cites: [{ chatId: "c1", seq: 4 }] } }),
        note({ id: "b2b2b2b2b2b2", text: "Facts wait.", kind: "fact", confirmed: false }),
        // Another agent's, and one a person wrote: not this section's.
        note({ id: "c3c3c3c3c3c3", agentId: "b".repeat(16), text: "Someone else's." }),
        note({ id: "d4d4d4d4d4d4", source: "person", text: "Written by hand." }),
      ],
    });
    expect(html).toContain("Tables, not prose.");
    expect(html).toContain("Learned 1 note, 1 note to confirm.");
    expect(html).toContain("86% sure");
    expect(html).toContain("To confirm");
    expect(html.indexOf("Facts wait.")).toBeLessThan(html.indexOf("Answer comparisons"));
    expect(html).not.toContain("Someone else");
    expect(html).not.toContain("Written by hand");
    expect(html.match(/>Keep</g)).toHaveLength(2);
    expect(html).toContain(">Forget<");
    expect(html).toContain("Dream now");
  });

  it("shows pi's own notes for pi: the owner's, learned by pi", () => {
    const html = render({
      subject: "pi",
      who: "pi",
      notes: [note({ id: "e5e5e5e5e5e5", scope: "user", agentId: undefined, learnedBy: "pi", text: "Three bullets." }), note({ text: "An agent's." })],
    });
    expect(html).toContain("Three bullets.");
    expect(html).not.toContain("An agent");
    expect(html).toContain("pi learns overnight");
  });

  it("holds Dream now while it is rate-limited, and says when nothing dreamt yet", () => {
    const html = render({ dreams: { ...view(), nowAfter: { [AGENT]: Date.now() + 60_000 } } });
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Dream now<\/button>/);
    expect(html).toContain("No dream yet");
    expect(render({ learns: false })).toContain("does not learn overnight");
  });
});
