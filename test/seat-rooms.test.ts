// One member's agent seated in two rooms with different people: whatever its seat keeps per chat object (pages, drafts,
// saved results, the sandbox, held actions, the kind its pages go out as) stays with the room it was made for.

import type { EntryRecord } from "@earendil-works/pi-durable";
import { describe, expect, it } from "vitest";
import { CHAT_AGENT_KIND } from "../shared/agents.ts";
import { SEAT_CHAT_PATTERN, type ArtifactMeta } from "../shared/protocol.ts";
import { pageOwner, postedVersion, readableVersion, upTo, versionRefusal } from "../worker/agent/page-authors.ts";
import { seatChatId } from "../worker/agents/seats/names.ts";
import { AgentSeats, type SeatHost } from "../worker/agents/seats/seat.ts";
import { ChatDrafts } from "../worker/storage/drafts.ts";
import { ToolResults } from "../worker/storage/tool-results.ts";
import { FakeBucket, memorySql } from "./fakes.ts";

const ANA = "ana";
const AGENT = "0123456789abcdef";
const ROOM_A = { ownerUid: "radu", chatId: "aaaaaaaaaaaaaaaa" };
const ROOM_B = { ownerUid: "mia", chatId: "bbbbbbbbbbbbbbbb" };

describe("a member's agent's seat chat", () => {
  it("is one per room: the same agent's seats in two rooms are two chat objects", async () => {
    const [a, again, b] = await Promise.all([seatChatId(AGENT, ROOM_A), seatChatId(AGENT, ROOM_A), seatChatId(AGENT, ROOM_B)]);
    expect(a).toBe(again);
    expect(a).not.toBe(b);
    // Two owners' chats can share an id (an import keeps its own): the room is its owner and chat.
    expect(await seatChatId(AGENT, { ownerUid: "mia", chatId: ROOM_A.chatId })).not.toBe(a);
    expect(await seatChatId("fedcba9876543210", ROOM_A)).not.toBe(a);
  });

  it("is never a chat id a route takes, and is one the seat's drafts take", async () => {
    const id = await seatChatId(AGENT, ROOM_A);
    expect(id).toMatch(SEAT_CHAT_PATTERN);
    expect(id).toContain("-");
    expect(() => new ChatDrafts(new FakeBucket().r2, ANA, id, new ArrayBuffer(32))).not.toThrow();
    expect(() => new ChatDrafts(new FakeBucket().r2, ANA, "seat-../x", new ArrayBuffer(32))).toThrow("Invalid chat id");
  });
});

describe("what a seat made for one room, from the other", () => {
  const versions = [{ version: 1, publishedAt: 1, manifest: {} }];

  it("never publishes over room A's page from room B, nor reads it there unless room B was shown it", async () => {
    const [seatA, seatB] = await Promise.all([seatChatId(AGENT, ROOM_A), seatChatId(AGENT, ROOM_B)]);
    const page: ArtifactMeta = { id: "p1", title: "Plan", ownerUid: ANA, chatId: seatA, createdAt: 0, updatedAt: 1, latest: 1, versions };
    // From room A's seat it is its own; from room B's, another chat's page.
    expect(pageOwner(page, ANA, seatA)).toBe("chat");
    expect(pageOwner(page, ANA, seatB)).toBe("owner");
    expect(versionRefusal(page, ANA, seatB, "Not saved:")).toMatch(/a page of another chat/);
    // Room B reads it only as posted there: its log has room A's reply nowhere.
    const roomB = [
      { kind: CHAT_AGENT_KIND, data: { ownerUid: ANA, agentId: AGENT, text: "Other work.", published: [{ artifactId: "p2", version: 1, title: "P2" }] } },
    ] as unknown as EntryRecord[];
    const readable = await readableVersion(page, ROOM_B, { shown: async () => 1, posted: async () => postedVersion(roomB, page) });
    expect(upTo(page, readable)).toBeNull();
  });

  it("keeps room A's drafts and saved results out of room B's seat", async () => {
    const bucket = new FakeBucket().r2;
    const key = new ArrayBuffer(32);
    const [seatA, seatB] = await Promise.all([seatChatId(AGENT, ROOM_A), seatChatId(AGENT, ROOM_B)]);
    const draftsA = new ChatDrafts(bucket, ANA, seatA, key);
    const draft = await draftsA.save({ id: "d1d1d1d1d1d1d1d1", html: "<p>room A</p>", manifest: {} }, null);
    const draftsB = new ChatDrafts(bucket, ANA, seatB, key);
    expect(await draftsB.list()).toEqual([]);
    expect(await draftsB.get(draft.id)).toBeNull();
    expect((await draftsA.list()).map((one) => one.id)).toEqual([draft.id]);
    // The fake bucket dates what it keeps at 0: a clock there keeps it fresh.
    const results = (chatId: string) => new ToolResults(bucket, ANA, chatId, key, () => 0);
    const path = await results(seatA).put("query", "room A's rows");
    expect(await results(seatB).get(path)).toBeNull();
    expect(await results(seatA).get(path)).not.toBeNull();
  });
});

describe("the kind a seat's pages go out as", () => {
  const host = { uid: ANA, later: () => {}, waitUntil: () => {} } as unknown as SeatHost;

  it("is its room's, off the record until the room said it, and none for a chat with no seats", () => {
    const seats = new AgentSeats(memorySql(), host);
    expect(seats.publishKind()).toBeNull();
    const sql = memorySql();
    const seated = new AgentSeats(sql, host);
    sql.exec("INSERT INTO agent_seats (room_owner, room_chat, agent_id, session, created_at) VALUES (?, ?, ?, ?, ?)", ROOM_A.ownerUid, ROOM_A.chatId, AGENT, "s1", 0);
    expect(seated.publishKind()).toBe("off_record");
    seated.setKind(ROOM_A, "group");
    expect(seated.publishKind()).toBe("group");
    seated.setKind(ROOM_A, "off_record");
    expect(seated.publishKind()).toBe("off_record");
  });
});
