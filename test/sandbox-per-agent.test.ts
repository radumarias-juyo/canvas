import { describe, expect, it } from "vitest";
import { agentSandboxName, sandboxFor, sandboxName, workspaceFresh } from "../worker/agent/sandbox-names.ts";
import { seatChatId } from "../worker/agents/seats/names.ts";

describe("a sandbox per agent in a chat", () => {
  it("runs pi's sessions in the chat's sandbox and each agent's in one of its own, apart from pi's and each other's", () => {
    const pi = sandboxFor(null, "radu", "c1");
    const planner = sandboxFor({ agentId: "planner000000000" }, "radu", "c1");
    const writer = sandboxFor({ agentId: "writer0000000000" }, "radu", "c1");
    // pi's is the chat's, as it always was: its container and what it keeps carry on.
    expect(pi).toBe("radu-c1");
    expect(pi).toBe(sandboxName("radu", "c1"));
    expect(planner).toBe(agentSandboxName("radu", "c1", "planner000000000"));
    expect(new Set([pi, planner, writer]).size).toBe(3);
    // The same agent in another chat of the owner's has another.
    expect(sandboxFor({ agentId: "planner000000000" }, "radu", "c2")).not.toBe(planner);
  });

  it("runs no code in a session nobody is known of", () => {
    expect(sandboxFor(undefined, "radu", "c1")).toBeNull();
  });

  it("gives a member's agent one per room: its seat's object is per room, and so is its sandbox there", async () => {
    const agentId = "helper0000000000";
    const [roomA, roomB] = await Promise.all([
      seatChatId(agentId, { ownerUid: "radu", chatId: "c1" }),
      seatChatId(agentId, { ownerUid: "radu", chatId: "c2" }),
    ]);
    expect(sandboxFor({ agentId }, "ana", roomA)).not.toBe(sandboxFor({ agentId }, "ana", roomB));
  });

  it("starts a run of another session than the one before with an empty /workspace, and keeps a session's own", () => {
    expect(workspaceFresh(undefined, "fork-1", false)).toBe(true);
    expect(workspaceFresh("fork-1", "fork-1", false)).toBe(false);
    // The agent's next turn, in a fork of its own: what the last one left is gone.
    expect(workspaceFresh("fork-1", "fork-2", false)).toBe(true);
    // A container that just started is empty anyway.
    expect(workspaceFresh("fork-1", "fork-1", true)).toBe(true);
  });
});
