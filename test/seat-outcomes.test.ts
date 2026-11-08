import type { EntryRecord } from "@earendil-works/pi-durable";
import { describe, expect, it } from "vitest";
import type { PendingActionView } from "../shared/limits.ts";
import { CHAT_MESSAGE_KIND } from "../shared/protocol.ts";
import { outcomeWord } from "../src/chat/ActionCard.tsx";
import { endedSeat, outcomesAfter } from "../src/chat/entries.ts";

let id = 0;
const said = (sentAt: number): EntryRecord =>
  ({ id: ++id, conversationId: 1, kind: CHAT_MESSAGE_KIND, data: { uid: "ana", name: "ana", text: "hi", sentAt } }) as never;
const forModel = (): EntryRecord => ({ id: ++id, conversationId: 1, kind: "chat.aside" }) as never;

const card = (fields: Partial<PendingActionView>): PendingActionView => ({
  id: "0000000000000001",
  chatId: "room",
  seat: true,
  kind: "approval",
  actor: { name: "clerk", agentId: "c1" },
  server: "crm",
  tool: "update_deal",
  input: { id: "d3", stage: "lost" },
  why: "A rule asks for your approval.",
  createdAt: 100,
  expiresAt: 10_000,
  status: "pending",
  ...fields,
});

describe("the outcome of a seat's card, for its agent's owner", () => {
  it("is a line once the card ended, in a word", () => {
    expect(endedSeat(card({}))).toBe(false);
    expect(endedSeat(card({ status: "running" }))).toBe(false);
    for (const status of ["done", "failed", "declined", "expired"] as const) expect(endedSeat(card({ status }))).toBe(true);
    expect(outcomeWord(card({ status: "done" }))).toBe("Ran");
    expect(outcomeWord(card({ status: "failed" }))).toBe("Failed");
    expect(outcomeWord(card({ status: "declined" }))).toBe("Declined");
    expect(outcomeWord(card({ status: "declined", kind: "proposal" }))).toBe("Dismissed");
    expect(outcomeWord(card({ status: "expired" }))).toBe("Expired");
  });

  it("shows after the last entry shown at or before it was decided, and waits for older entries it predates", () => {
    const entries = [said(50), said(150), forModel(), said(300)];
    const ran = card({ id: "0000000000000002", status: "done", decidedAt: 200 });
    const expired = card({ id: "0000000000000003", status: "expired", expiresAt: 400 });
    const early = card({ id: "0000000000000004", status: "declined", decidedAt: 10 });
    const placed = outcomesAfter(entries, [ran, expired, early]);
    expect(placed.get(entries[1].id as number)).toEqual([ran]);
    // Expired: at its expiry, after the newest entry.
    expect(placed.get(entries[3].id as number)).toEqual([expired]);
    // Decided before the first entry loaded: nowhere yet, never after an entry the app does not show.
    expect([...placed.values()].flat()).not.toContainEqual(early);
    expect(placed.has(entries[2].id as number)).toBe(false);
    expect(outcomesAfter(entries, []).size).toBe(0);
  });
});
