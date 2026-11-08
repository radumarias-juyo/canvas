import { describe, expect, it } from "vitest";
import type { ArtifactManifest, ArtifactMeta } from "../shared/protocol.ts";
import { changeRefusal, liveCallRefusal, piCreateReach, reachRefusal, SessionDrafts, withReach, type CreateReach } from "../worker/agent/create-reach.ts";
import { checkDraft, publishDraft, writeDraft, type PublishScope } from "../worker/agent/publish.ts";
import type { McpHub } from "../worker/mcp/hub.ts";
import type { ArtifactStore } from "../worker/storage/artifacts.ts";
import { ChatDrafts } from "../worker/storage/drafts.ts";
import { FakeBucket } from "./fakes.ts";

// The chat's servers: crm is shared with the chat; vault signs in each user (the owner's alone).
const CHAT = "0123456789abcdef";
const crm = [{ server: "crm", tools: ["list_deals"] }];
const vault = [{ server: "vault", tools: ["read_notes"] }];
// Sessions: the owner's own turn ("own"), a member's ask of the owner's agent and a hand-off ("asked").
const ASKED: CreateReach = { servers: ["crm"], newOnly: true, drafts: "asked:1" };

const page = (id: string, latest = 1): ArtifactMeta => ({
  id,
  title: `Page ${id}`,
  ownerUid: "ada",
  chatId: CHAT,
  createdAt: 0,
  updatedAt: latest,
  latest,
  versions: Array.from({ length: latest }, (_, i) => ({ version: i + 1, publishedAt: i + 1, manifest: { mcp: { servers: crm } } })),
});

/**
 * Ada's chat: one page of hers ("signups"), crm and vault, and what the scope's sessions may reach. pi's one session
 * ("pi") answers Ada's own message in run 1 and a member's in run 2 (`piRun`), which is new-only on run 2's drafts.
 */
function chat() {
  const piRun = { run: 1 };
  const drafts = new ChatDrafts(new FakeBucket().r2, "ada", CHAT, new ArrayBuffer(32));
  const published: { id?: string; manifest: ArtifactManifest }[] = [];
  const checked: string[] = [];
  const pages = [page("signups")];
  const scope: PublishScope = {
    uid: "ada",
    chatId: CHAT,
    hub: {
      servers: () => [{ name: "crm" }, { name: "vault" }],
      tools: async (server: string) => [{ name: server === "crm" ? "list_deals" : "read_notes", inputSchema: {}, annotations: { readOnlyHint: true } }],
      tool: async () => ({ name: "x", inputSchema: {}, annotations: { readOnlyHint: true } }),
    } as unknown as McpHub,
    artifacts: {
      readMeta: async (id: string) => pages.find((one) => one.id === id) ?? null,
      readHtml: async () => "<p>signups v1</p>",
      publishVersion: async (input: { id?: string; title: string; manifest: ArtifactManifest }) => {
        published.push({ id: input.id, manifest: input.manifest });
        return { ...(pages.find((one) => one.id === input.id) ?? page("new0000000000001", 0)), latest: 1, title: input.title };
      },
    } as unknown as ArtifactStore,
    onPublished: async () => {},
    checkPage: async (input) => {
      checked.push(input.html);
      return { errors: [], warnings: [], calls: [], tests: [], text: "", screenshot: "", thumb: "", width: 1280, height: 800 };
    },
    chatArtifacts: async () => [{ id: "signups", title: "Page signups", latest: 1, updatedAt: 1, chatId: CHAT }],
    drafts: async () => drafts,
    skillSets: async () => new Map(),
    readSkillFile: async () => null,
    publishUnchecked: false,
    createReach: async (session) =>
      session === "asked" ? ASKED : session === "pi" ? piCreateReach(piRun.run === 2, ["crm", "vault"], (server) => server === "crm", `pi:${piRun.run}`) : undefined,
    sessionDrafts: new SessionDrafts(),
  };
  return { scope, published, checked, pages, piRun };
}

describe("a page made on someone else's ask", () => {
  it("is made, checked and published as a new page by a member's ask or a hand-off, calling the chat's shared servers", async () => {
    const { scope, published } = chat();
    const draft = await writeDraft(scope, { html: "<p>deals for Mia</p>", mcp: crm, session: "asked" });
    await checkDraft(scope, draft.id, {}, undefined, "asked");
    const { meta } = await publishDraft(scope, { title: "Deals", draftId: draft.id, session: "asked" }, undefined, "asked");
    expect(meta.latest).toBe(1);
    // A new page (no id), never "Page signups" by its title; the version keeps the servers it may call.
    expect(published).toEqual([{ id: undefined, manifest: { mcp: { servers: crm }, reach: ["crm"] } }]);
  });

  it("is refused when it declares a server only the owner reads, before the browser runs it, and at publish", async () => {
    const { scope, published, checked } = chat();
    await expect(writeDraft(scope, { html: "<p>notes</p>", mcp: [...crm, ...vault], session: "asked" })).rejects.toThrow(
      /Not saved: the page calls vault, which only your owner's own message may build a page on.*calls only crm/,
    );
    // A draft the owner's own turn saved with vault is not this turn's to check or publish either.
    const owners = await writeDraft(scope, { html: "<p>notes</p>", mcp: vault, session: "own" });
    await expect(checkDraft(scope, owners.id, {}, undefined, "asked")).rejects.toThrow(/Not checked: draft "\w+" is not one this turn wrote/);
    await expect(publishDraft(scope, { title: "Notes", draftId: owners.id }, undefined, "asked")).rejects.toThrow(/Not published: draft/);
    expect([checked, published]).toEqual([[], []]);
  });

  it("changes no page the chat has: no edits to it, no version of it by id, and the refusal says what to do", async () => {
    const { scope, published, pages } = chat();
    await expect(writeDraft(scope, { edits: [{ old: "v1", new: "v2" }], artifact: pages[0], session: "asked" })).rejects.toThrow(
      /Not saved: changing a page the chat already has .* is for your owner's own message.*new_artifact: true/,
    );
    const draft = await writeDraft(scope, { html: "<p>signups, Mia's way</p>", mcp: crm, session: "asked" });
    await checkDraft(scope, draft.id, {}, undefined, "asked");
    await expect(publishDraft(scope, { title: "Page signups", draftId: draft.id, artifactId: "signups" }, undefined, "asked")).rejects.toThrow(
      /Not published: changing a page the chat already has/,
    );
    expect(published).toEqual([]);
  });

  it("is new-only for pi on a run that answers a member too: no edit, no version by id, no title match onto a page", async () => {
    const { scope, published, pages, piRun } = chat();
    piRun.run = 2;
    await expect(writeDraft(scope, { edits: [{ old: "v1", new: "v2" }], artifact: pages[0], session: "pi" })).rejects.toThrow(
      /Not saved: changing a page the chat already has/,
    );
    const draft = await writeDraft(scope, { html: "<p>signups for Mia</p>", mcp: crm, session: "pi" });
    await checkDraft(scope, draft.id, {}, undefined, "pi");
    await expect(publishDraft(scope, { title: "Page signups", draftId: draft.id, artifactId: "signups" }, undefined, "pi")).rejects.toThrow(
      /Not published: changing a page the chat already has.*new_artifact: true/,
    );
    // By its title it goes as a new page, never onto "Page signups".
    await publishDraft(scope, { title: "Page signups", draftId: draft.id }, undefined, "pi");
    expect(published).toEqual([{ id: undefined, manifest: { mcp: { servers: crm }, reach: ["crm"] } }]);
  });

  it("builds only on drafts of its own run: pi's earlier run for the owner left one it may not touch", async () => {
    const { scope, published, checked, piRun } = chat();
    // Run 1, the owner's own: a page with what only they see in its html, on crm alone.
    const owners = await writeDraft(scope, { html: "<p>Ada's salary: 120k</p>", mcp: crm, session: "pi" });
    piRun.run = 2;
    // Run 2 answers a member, in the same session: the owner's draft is not this run's, whatever it declares.
    await expect(writeDraft(scope, { draftId: owners.id, edits: [{ old: "120k", new: "a lot" }], session: "pi" })).rejects.toThrow(
      /Not saved: draft "\w+" is not one this turn wrote/,
    );
    await expect(checkDraft(scope, owners.id, {}, undefined, "pi")).rejects.toThrow(/Not checked: draft/);
    await expect(publishDraft(scope, { title: "Salary", draftId: owners.id }, undefined, "pi")).rejects.toThrow(/Not published: draft/);
    // An agent's later turn in the same session is another turn too.
    const mine = await writeDraft(scope, { html: "<p>deals</p>", mcp: crm, session: "asked" });
    scope.createReach = async () => ({ ...ASKED, drafts: "asked:2" });
    await expect(checkDraft(scope, mine.id, {}, undefined, "asked")).rejects.toThrow(/Not checked: draft/);
    expect([checked, published]).toEqual([[], []]);
  });

  it("leaves the owner's own turn as it was: any server, a new version of the chat's page, no reach kept", async () => {
    const { scope, published } = chat();
    const draft = await writeDraft(scope, { html: "<p>notes</p>", mcp: [...crm, ...vault], session: "own" });
    await checkDraft(scope, draft.id, {}, undefined, "own");
    await publishDraft(scope, { title: "Page signups", draftId: draft.id, artifactId: "signups" }, undefined, "own");
    expect(published).toEqual([{ id: "signups", manifest: { mcp: { servers: [...crm, ...vault] } } }]);
  });
});

describe("the reach rules", () => {
  it("say which servers are outside, keep the reach on the version, and refuse a live call outside it", () => {
    expect(reachRefusal({ mcp: { servers: crm } }, ASKED, "Not saved:")).toBeNull();
    expect(reachRefusal({ mcp: { servers: vault } }, { servers: [], newOnly: true, drafts: "x" }, "Not saved:")).toContain("calls no server at all");
    expect(changeRefusal(undefined, "Not saved:")).toBeNull();
    expect(changeRefusal({ servers: [], newOnly: false, drafts: "x" }, "Not saved:")).toBeNull();
    // pi: none on the owner's own run; new-only on the servers it shares, on the run's drafts, on anyone else's.
    expect(piCreateReach(false, ["crm", "vault"], (server) => server === "crm", "pi:7")).toBeUndefined();
    expect(piCreateReach(true, ["crm", "vault"], (server) => server === "crm", "pi:7")).toEqual({ servers: ["crm"], newOnly: true, drafts: "pi:7" });
    expect(withReach({ mcp: { servers: crm } }, undefined)).toEqual({ mcp: { servers: crm } });
    const kept = withReach({ mcp: { servers: crm } }, ASKED);
    expect(liveCallRefusal(kept, "crm")).toBeNull();
    // Whatever else a version made on someone's ask declares, its live calls reach only what it kept.
    expect(liveCallRefusal({ ...kept, mcp: { servers: [...crm, ...vault] } }, "vault")).toMatch(/not one of the servers this page may call/);
    // The owner's own page calls what it declares.
    expect(liveCallRefusal({ mcp: { servers: vault } }, "vault")).toBeNull();
  });

  it("remember each conversation's drafts, the least recently written going first past the cap", () => {
    const drafts = new SessionDrafts(2);
    drafts.add("a", "d1");
    drafts.add("b", "d2");
    drafts.add("a", "d3");
    drafts.add("c", "d4");
    expect([drafts.has("a", "d1"), drafts.has("a", "d3"), drafts.has("b", "d2"), drafts.has("c", "d4"), drafts.has("c", "d1")]).toEqual([true, true, false, true, false]);
  });
});
