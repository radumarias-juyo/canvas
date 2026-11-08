// artifact_read and artifact_diff never reach a version the page's own chat withholds (one a turn apart published with
// its reply not posted), by name or by default: a member's seat reading the room's page, the room reading a member's
// page, and a page brought in from another of the owner's chats. The page is as ownArtifact (worker/agent/tools.ts)
// gives it to the tools: postedPage for another person's, shownOf for a brought-in one; the reading chat's own rules
// know nothing of the page's chat.

import { describe, expect, it } from "vitest";
import type { ArtifactMeta } from "../shared/protocol.ts";
import { postedPage } from "../worker/agent/page-authors.ts";
import { diffVersions, versionToRead, type SessionRules } from "../worker/agent/publish.ts";
import { shownOf, type HeldPage } from "../worker/agents/roster.ts";

const versions = (n: number) => Array.from({ length: n }, (_, i) => ({ version: i + 1, publishedAt: i + 1, manifest: {} }));
const page = (ownerUid: string, chatId: string): ArtifactMeta => ({
  id: "p1",
  title: "Signups",
  ownerUid,
  chatId,
  createdAt: 0,
  updatedAt: 3,
  latest: 3,
  versions: versions(3),
});
/** v2 was published by a turn apart in the page's chat, its reply not posted; v3 was posted. */
const V2_HELD: HeldPage = { page: false, versions: [2] };
/** The reading conversation's own rules: they hide nothing of another chat's page. */
const OWN_RULES = { hidden: new Set<string>(), hiddenVersion: () => false } as unknown as SessionRules;

const cases: { name: string; meta: ArtifactMeta }[] = [
  // A member's seat reads the room's page, posted in the room up to v3.
  { name: "a member's seat reading the room's page", meta: postedPage(page("ada", "room0000"), { upTo: 3, held: V2_HELD })! },
  // The room reads a member's page (made in their seat object), posted in the room up to v3.
  { name: "the room reading a member's page", meta: postedPage(page("finn", "seat-0123456789abcdef-0123456789abcdef"), { upTo: 3, held: V2_HELD })! },
  // The owner's chat reads their page from another of their chats, named here with "@".
  { name: "a page brought in from another of the owner's chats", meta: shownOf(page("ada", "other000"), V2_HELD)! },
];

describe("a diff never reaches a version the page's own chat withholds", () => {
  for (const { name, meta } of cases) {
    it(`${name}: the default diff goes from v1 to v3, never through v2`, () => {
      expect(diffVersions(meta, {}, OWN_RULES)).toEqual({ from: 1, to: 3 });
      expect(diffVersions(meta, {}, undefined)).toEqual({ from: 1, to: 3 });
      expect(diffVersions(meta, { to: 3 }, OWN_RULES)).toEqual({ from: 1, to: 3 });
    });

    it(`${name}: v2 named by a read or a diff is refused, and a read's default is v3`, () => {
      expect(() => versionToRead(meta, 2, OWN_RULES)).toThrow("has no version 2 in this chat yet");
      expect(() => diffVersions(meta, { from: 2 }, OWN_RULES)).toThrow("has no version 2 in this chat yet");
      expect(() => diffVersions(meta, { to: 2 }, OWN_RULES)).toThrow("has no version 2 in this chat yet");
      expect(versionToRead(meta, undefined, OWN_RULES)).toBe(3);
    });
  }
});

describe("versionToRead's default", () => {
  const shown = shownOf(page("ada", "room0000"), V2_HELD)!;

  it("takes only a version the page lists, whatever the reader's own rules say", () => {
    expect(versionToRead(shown, undefined)).toBe(3);
    expect(versionToRead(shown, undefined, undefined, 2)).toBe(1);
  });

  it("refuses when the page lists none up to where it looks, rather than guessing version 1", () => {
    const onlyThree = shownOf(page("ada", "room0000"), { page: false, versions: [1, 2] })!;
    expect(() => diffVersions(onlyThree, {}, OWN_RULES)).toThrow("has no version before v3 in this chat yet");
    // The reader's own rules hide the last one it lists, too.
    const rules = { hiddenVersion: (_id: string, version: number) => version === 3 } as unknown as SessionRules;
    expect(() => versionToRead(onlyThree, undefined, rules)).toThrow("has no version in this chat yet");
  });

  it("still leaves out what the reader's own rules hide, of the chat's own page", () => {
    const own = page("ada", "room0000");
    const rules = { hiddenVersion: (_id: string, version: number) => version === 3 } as unknown as SessionRules;
    expect(diffVersions(own, {}, rules)).toEqual({ from: 1, to: 2 });
  });
});
