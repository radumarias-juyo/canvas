import type { AgentEvent } from "@earendil-works/pi-durable";
import { describe, expect, it } from "vitest";
import { steerLine, windowText, MAX_WINDOW_TEXT } from "../shared/agent-window.ts";
import { sessionLabel, steerNote } from "../src/chat/AgentWindow.tsx";
import { snapshotState } from "../src/chat/useChat.ts";

describe("an agent's window, in the app", () => {
  it("names each session by what it served and who asked", () => {
    expect(sessionLabel({ id: "s", kind: "shared", running: false })).toBe("Shared with the chat");
    expect(sessionLabel({ id: "f", kind: "fork", turn: 4, askedBy: "Ana", running: true })).toBe("Turn #4 · Ana");
    expect(sessionLabel({ id: "f", kind: "fork", turn: 5, askedBy: "Ana", window: true, running: false })).toBe("Turn #5 · you, from here");
    expect(sessionLabel({ id: "r", kind: "run", running: false })).toBe("A run");
    expect(sessionLabel({ id: "r", kind: "run", turn: 9, askedBy: "Ana", running: false })).toBe("Reply to a run #9");
  });

  it("says what the owner's words did, and takes only a non-empty instruction within the limit", () => {
    expect(steerNote({ mode: "steered", turn: 1 })).toContain("at its next step");
    expect(steerNote({ mode: "queued", turn: 2 })).toContain("right after");
    expect(steerNote({ mode: "started", turn: 3 })).toContain("only its reply posts");
    expect([windowText("  go  "), windowText(""), windowText(3), windowText("x".repeat(MAX_WINDOW_TEXT + 1))]).toEqual(["go", null, null, null]);
    expect(steerLine("Ana", "go")).toBe("[Ana · your owner, steering this turn from your window]: go");
  });

  it("reads a session's snapshot as the chat reads its own, busy while a run goes", () => {
    const entry = { id: 1, conversationId: 2, kind: "pi.user", model: [{ role: "user", content: "hi", timestamp: 0 }] };
    const snapshot = { type: "snapshot", entries: [entry], run: { inputs: [] }, tools: [], nestedTools: [], compactions: [], inbox: [] };
    const state = snapshotState(snapshot as unknown as AgentEvent, 10_000, 4_000);
    expect(state).toMatchObject({ busy: true, runStartedAt: 6_000, entries: [entry] });
  });
});
