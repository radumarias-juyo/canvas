import type { EntryRecord } from "@earendil-works/pi-durable";
import { describe, expect, it } from "vitest";
import { CHAT_AGENT_KIND } from "../shared/agents.ts";
import { CHAT_MESSAGE_KIND, type ArtifactMeta } from "../shared/protocol.ts";
import { pageOwner, postedVersion, readableVersion, upTo, versionRefusal } from "../worker/agent/page-authors.ts";
import { checkDraft, publishDraft, writeDraft, type PublishScope } from "../worker/agent/publish.ts";
import type { McpHub } from "../worker/mcp/hub.ts";
import type { ArtifactStore } from "../worker/storage/artifacts.ts";
import { ChatDrafts } from "../worker/storage/drafts.ts";
import { FakeBucket } from "./fakes.ts";

const CHAT = "0123456789abcdef";
const versions = (n: number) => Array.from({ length: n }, (_, i) => ({ version: i + 1, publishedAt: i + 1, manifest: {} }));
const page = (id: string, ownerUid: string, chatId: string, latest = 3): ArtifactMeta => ({
  id,
  title: `Page ${id}`,
  ownerUid,
  chatId,
  createdAt: 0,
  updatedAt: latest,
  latest,
  versions: versions(latest),
});

describe("whose a page is", () => {
  it("tells this chat's pages from the owner's other chats' and from another person's", () => {
    expect(pageOwner(page("p1", "ada", CHAT), "ada", CHAT)).toBe("chat");
    expect(pageOwner(page("p1", "ada", "other"), "ada", CHAT)).toBe("owner");
    // A member's agent publishes in the member's own object: another person's, whatever chat it names.
    expect(pageOwner(page("p1", "bob", CHAT), "ada", CHAT)).toBe("other");
  });

  it("lets only this chat's pages take a new version, and says what to do instead", () => {
    expect(versionRefusal(page("p1", "ada", CHAT), "ada", CHAT, "Not saved:")).toBeNull();
    expect(versionRefusal(page("p1", "ada", "other"), "ada", CHAT, "Not saved:")).toMatch(/^Not saved: artifact p1 is a page of another chat.*new artifact/);
    const other = versionRefusal(page("p1", "bob", CHAT), "ada", CHAT, "Not published:")!;
    expect(other).toMatch(/^Not published: artifact p1 \("Page p1"\) is a page another person's agent published/);
    expect(other).toContain("Only that person's own agents publish new versions of it");
    expect(other).toContain("artifact_read");
    expect(other).toContain("new_artifact: true");
  });
});

describe("another person's page posted in a chat", () => {
  const reply = (ownerUid: string, published: { artifactId: string; version: number }[]) => ({
    kind: CHAT_AGENT_KIND,
    data: { ownerUid, agentId: "a1", name: "planner", text: "Here.", published: published.map((one) => ({ ...one, title: "T" })) },
  });

  it("reads up to the newest version its owner's agents' replies posted, and nothing else", () => {
    const meta = page("p1", "bob", "seat");
    const log = [
      reply("bob", [{ artifactId: "p1", version: 1 }]),
      reply("bob", [
        { artifactId: "p2", version: 7 },
        { artifactId: "p1", version: 2 },
      ]),
      // Another person's reply naming it does not post it: only its owner's agents' replies do.
      reply("ada", [{ artifactId: "p1", version: 3 }]),
      { kind: CHAT_MESSAGE_KIND, data: { uid: "bob", name: "Bob", text: "p1 v3", published: [{ artifactId: "p1", version: 3 }] } },
      { kind: CHAT_AGENT_KIND, data: { ownerUid: "bob", text: "no pages" } },
    ] as unknown as Pick<EntryRecord, "kind" | "data">[];
    expect(postedVersion(log, meta)).toBe(2);
    expect(postedVersion([], meta)).toBe(0);
    expect(postedVersion(log, page("p9", "bob", "seat"))).toBe(0);
  });

  it("shows the page as the chat has it: the versions up to the one posted, none when none was", () => {
    const meta = page("p1", "bob", "seat", 3);
    const shown = upTo(meta, 2)!;
    expect([shown.latest, shown.versions.map((version) => version.version)]).toEqual([2, [1, 2]]);
    expect(upTo(meta, 5)).toEqual(meta);
    expect(upTo(meta, 0)).toBeNull();
  });
});

describe("what a member's agent reads of the room's pages", () => {
  const room = { ownerUid: "ada", chatId: CHAT };
  const ways = { shown: async () => 2, posted: async () => 5 };

  it("reads the room's own pages as its owner's member sees them, another person's as posted, and no other chat's", async () => {
    expect(await readableVersion(page("p1", "ada", CHAT), room, ways)).toBe(2);
    expect(await readableVersion(page("p1", "cy", "seat"), room, ways)).toBe(5);
    // The member's own other agent's page, posted here by that agent's seat: as posted, too.
    expect(await readableVersion(page("p1", "bob", "seat2"), room, ways)).toBe(5);
    expect(await readableVersion(page("p1", "ada", "other"), room, ways)).toBe(0);
  });
});

describe("publishing over a page", () => {
  /** Ada's chat, whose store knows `pages`, and the versions it published. */
  function chat(pages: ArtifactMeta[]) {
    const published: (string | undefined)[] = [];
    const drafts = new ChatDrafts(new FakeBucket().r2, "ada", CHAT, new ArrayBuffer(32));
    const scope: PublishScope = {
      uid: "ada",
      chatId: CHAT,
      hub: { servers: () => [] } as unknown as McpHub,
      artifacts: {
        readMeta: async (id: string) => pages.find((one) => one.id === id) ?? null,
        publishVersion: async (input: { id?: string; title: string }) => {
          published.push(input.id);
          return { ...(pages.find((one) => one.id === input.id) ?? page("new0000000000001", "ada", CHAT, 0)), latest: 1, title: input.title };
        },
      } as unknown as ArtifactStore,
      onPublished: async () => {},
      checkPage: async () => ({ errors: [], warnings: [], calls: [], tests: [], text: "", screenshot: "", thumb: "", width: 1280, height: 800 }),
      chatArtifacts: async () => [],
      drafts: async () => drafts,
      skillSets: async () => new Map(),
      readSkillFile: async () => null,
      publishUnchecked: false,
    };
    const checked = async () => {
      const { id } = await writeDraft(scope, { html: "<p>signups</p>" });
      await checkDraft(scope, id, {});
      return id;
    };
    return { scope, published, checked };
  }

  it("refuses a new version of another person's page, by its id, with what to do instead; nothing is published", async () => {
    const made = chat([page("bobs", "bob", "seat")]);
    const draftId = await made.checked();
    await expect(publishDraft(made.scope, { title: "Signups", draftId, artifactId: "bobs" })).rejects.toThrow(
      /Not published: artifact bobs \("Page bobs"\) is a page another person's agent published/,
    );
    expect(made.published).toEqual([]);
    // As a new artifact it goes, and the draft can still be published.
    await publishDraft(made.scope, { title: "Signups", draftId, newArtifact: true });
    expect(made.published).toEqual([undefined]);
  });

  it("refuses another chat's page of the owner's too, and publishes over a page of this chat, whoever of the owner's made it", async () => {
    const made = chat([page("elsewhere", "ada", "other"), page("mine", "ada", CHAT)]);
    const draftId = await made.checked();
    await expect(publishDraft(made.scope, { title: "Signups", draftId, artifactId: "elsewhere" })).rejects.toThrow(/is a page of another chat/);
    // pi's page or one of the owner's agents': one chat, one owner, so any of them builds on it.
    await publishDraft(made.scope, { title: "Signups", draftId, artifactId: "mine" });
    expect(made.published).toEqual(["mine"]);
  });
});
