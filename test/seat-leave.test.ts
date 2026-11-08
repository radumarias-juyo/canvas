// A member's agent leaves a room: its seat object for that room is cleaned up, keeping what its replies posted there,
// and the room asks again until the seat answers.

import type { EntryRecord } from "@earendil-works/pi-durable";
import { describe, expect, it } from "vitest";
import { CHAT_AGENT_KIND } from "../shared/agents.ts";
import { CHAT_MESSAGE_KIND } from "../shared/protocol.ts";
import { leaveRetryMs, postedBy, SeatLeaves, seatLeftovers, type SeatLeave } from "../worker/agents/seats/leaving.ts";
import { FollowStore } from "../worker/feed/store.ts";
import { memorySql } from "./fakes.ts";

const ANA = "ana";
const AGENT = "0123456789abcdef";

const reply = (agentId: string, ownerUid: string, published: string[], saved: string[] = []) =>
  ({
    kind: CHAT_AGENT_KIND,
    data: { agentId, ownerUid, name: "planner", text: "Here.", published: published.map((artifactId) => ({ artifactId, title: "T", version: 1 })), saved },
  }) as unknown as EntryRecord;

describe("what a seat keeps when its agent leaves the room", () => {
  it("keeps the pages and files its agent's replies posted there, and nothing another agent or person posted", () => {
    const log = [
      reply(AGENT, ANA, ["p1"], ["out/plan.csv"]),
      reply(AGENT, ANA, ["p2", "p1"]),
      // Another person's agent with the same id, and another agent of Ana's: not this seat's.
      reply(AGENT, "mia", ["p9"], ["out/mia.csv"]),
      reply("fedcba9876543210", ANA, ["p8"]),
      { kind: CHAT_MESSAGE_KIND, data: { uid: ANA, name: "Ana", text: "p7", published: [{ artifactId: "p7" }] } } as unknown as EntryRecord,
    ];
    const keeps = postedBy(log, AGENT, ANA);
    expect(keeps.pages.sort()).toEqual(["p1", "p2"]);
    expect(keeps.files).toEqual(["out/plan.csv"]);
    // Read a page of the log at a time, newest first: the lists add up.
    expect(postedBy(log.slice(0, 1), AGENT, ANA, postedBy(log.slice(1), AGENT, ANA)).pages.sort()).toEqual(["p1", "p2"]);
  });

  it("removes what its sessions made that no posted reply named: a page held for review and discarded, a scratch file", () => {
    const folder = "out/seat-a/";
    const made = { pages: ["p1", "p2", "draft-only"], files: ["out/seat-a/plan.csv", "out/seat-a/scratch.txt"] };
    expect(seatLeftovers(made, { pages: ["p1", "p2"], files: ["out/seat-a/plan.csv"] }, folder)).toEqual({ pages: ["draft-only"], files: ["out/seat-a/scratch.txt"] });
    // Nothing posted: all of it goes; everything posted: nothing does.
    expect(seatLeftovers(made, { pages: [], files: [] }, folder)).toEqual(made);
    expect(seatLeftovers(made, made, folder)).toEqual({ pages: [], files: [] });
  });

  it("never removes a file outside the seat chat's own folder: it may be one of its owner's it wrote over", () => {
    const made = { pages: [], files: ["notes/plan.md", "out/seat-a/scratch.txt", "out/seat-b/other.txt", "out/seat-a"] };
    expect(seatLeftovers(made, { pages: [], files: [] }, "out/seat-a/").files).toEqual(["out/seat-a/scratch.txt"]);
  });
});

describe("the room's outbox of seats to clean up", () => {
  const leave = { ownerUid: ANA, agentId: AGENT, seat: `seat-${AGENT}-aaaaaaaaaaaaaaaa`, keeps: { pages: ["p1"], files: [] } };

  it("asks a seat until it answers, waiting longer each time, and forgets it once it did", async () => {
    const leaves = new SeatLeaves(memorySql());
    leaves.add(leave);
    let reachable = false;
    const asked: SeatLeave[] = [];
    const ask = async (one: SeatLeave) => {
      asked.push(one);
      if (!reachable) throw new Error("unreachable");
    };
    expect(await leaves.flush(ask)).toBe(leaveRetryMs(1));
    expect(await leaves.flush(ask)).toBe(leaveRetryMs(2));
    expect(leaves.list()).toEqual([{ ...leave, attempts: 2 }]);
    reachable = true;
    expect(await leaves.flush(ask)).toBeUndefined();
    expect(leaves.list()).toEqual([]);
    expect(asked.map((one) => one.keeps)).toEqual([leave.keeps, leave.keeps, leave.keeps]);
    // Nothing left: nothing asked.
    expect(await leaves.flush(ask)).toBeUndefined();
    expect(asked).toHaveLength(3);
  });

  it("keeps the newer list for a seat left twice, from the first try again, and lets one go that is back in the room", () => {
    const leaves = new SeatLeaves(memorySql());
    leaves.add(leave);
    leaves.failed(leave);
    leaves.add({ ...leave, keeps: { pages: ["p1", "p2"], files: ["out/a.csv"] } });
    expect(leaves.list()).toEqual([{ ...leave, keeps: { pages: ["p1", "p2"], files: ["out/a.csv"] }, attempts: 0 }]);
    leaves.add({ ...leave, agentId: "fedcba9876543210", seat: "seat-fedcba9876543210-aaaaaaaaaaaaaaaa" });
    // The agent came back to the room before its seat was cleaned up: that seat is in use again.
    leaves.done(leave);
    expect(leaves.list().map((one) => one.agentId)).toEqual(["fedcba9876543210"]);
  });

  it("waits at most an hour between asks", () => {
    expect([1, 2, 3].map(leaveRetryMs)).toEqual([30_000, 60_000, 120_000]);
    expect(leaveRetryMs(30)).toBe(60 * 60_000);
  });
});

describe("followers of an agent that left a room", () => {
  it("are those who follow it through that room; its followers through another room stay", () => {
    const follows = new FollowStore(memorySql());
    follows.addFollower("agent", AGENT, { uid: "radu", via: { ownerUid: "radu", chatId: "room-a" } });
    follows.addFollower("agent", AGENT, { uid: "mia", via: { ownerUid: "radu", chatId: "room-a" } });
    follows.addFollower("agent", AGENT, { uid: "cy", via: { ownerUid: "cy", chatId: "room-b" } });
    expect(follows.dropFollowersThrough("agent", AGENT, "radu", "room-a").sort()).toEqual(["mia", "radu"]);
    expect(follows.followersOf("agent", AGENT).map((one) => one.uid)).toEqual(["cy"]);
    // Asked again (the room retries): nobody is left to drop.
    expect(follows.dropFollowersThrough("agent", AGENT, "radu", "room-a")).toEqual([]);
  });
});
