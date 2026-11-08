import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { EntryRecord } from "@earendil-works/pi-durable";
import { DocumentCard, documentOf } from "../src/documents/DocumentCard.tsx";
import { DocumentsList } from "../src/documents/DocumentsNav.tsx";
import { EditRequestCard, opChanges, stateLabel } from "../src/documents/EditRequests.tsx";
import { HistoryPanel } from "../src/documents/HistoryPanel.tsx";
import { LinkForm } from "../src/documents/Toolbar.tsx";
import { MergePrompt } from "../src/documents/MergePrompt.tsx";
import { StaticBlocks } from "../src/documents/StaticBlocks.tsx";
import type { Block, DocOp, EditRequest } from "../src/documents/model.ts";

const p = (id: string, text: string, h = "aaaa"): Block => ({ type: "paragraph", attrs: { id, h }, content: [{ type: "text", text }] });
const blocks = [p("a", "The launch is in week 41."), p("b", "West has no campaign.")];
const replace: DocOp = { op: "replace", tab: "t1", target: { id: "a" }, with: { blocks: [p("a", "The launch moved to week 43.")] }, ifHash: "aaaa", ifRev: 4 };
const request = (more: Partial<EditRequest> = {}): EditRequest => ({ rid: "r1", by: "ana", byName: "Ana", at: Date.now() - 60_000, ops: [replace], state: "pending", ...more });

describe("an edit request's card", () => {
  it("shows the change word by word, and Approve and Decline only to the owner while it waits", () => {
    const owner = renderToStaticMarkup(<EditRequestCard request={request({ note: "Dates moved" })} blocks={blocks} owner mine={false} onDecide={async () => {}} />);
    expect(owner).toContain("Ana asks for a change");
    expect(owner).toContain("“Dates moved”");
    expect(owner).toMatch(/<del>41<\/del>/);
    expect(owner).toMatch(/<ins>43<\/ins>/);
    expect(owner).toContain(">Approve<");
    expect(owner).toContain(">Decline<");
    expect(owner).toContain("Waits for you");
    // The person who asked sees it as requested, with nothing to decide.
    const asker = renderToStaticMarkup(<EditRequestCard request={request()} blocks={blocks} owner={false} mine />);
    expect(asker).toContain("You asked for a change");
    expect(asker).toContain(">Requested<");
    expect(asker).not.toContain("Approve");
    // Decided: no buttons, the outcome.
    const done = renderToStaticMarkup(<EditRequestCard request={request({ state: "approved" })} blocks={blocks} owner mine={false} onDecide={async () => {}} />);
    expect(done).not.toContain(">Approve<");
    expect(done).toContain("Approved");
  });

  it("reads each kind of op, and says when the document changed under it", () => {
    const ops: DocOp[] = [
      replace,
      { op: "insert", tab: "t1", at: { after: "a" }, with: { blocks: [p("n", "A new line.")] } },
      { op: "delete", tab: "t1", target: { id: "b" }, ifHash: "aaaa", ifRev: 4 },
      { op: "delete", tab: "t1", target: { id: "gone" }, ifHash: "aaaa", ifRev: 4 },
      { op: "table", tab: "t1", table: "a", action: "addRow" },
    ];
    const changes = opChanges(ops, blocks);
    expect(changes.map((change) => change.kind)).toEqual(["changed", "added", "removed", "removed", "changed"]);
    expect(changes[1]!.parts).toEqual([{ text: "A new line.", added: true }]);
    expect(changes[3]!.missing).toBe(true);
    expect(changes[4]!.parts[0]!.text).toBe("Adds a table row");
    expect(stateLabel("pending", true, true)).toBe("Needs a re-check");
    expect(stateLabel("stale", false, false)).toBe("Out of date: ask again");
  });
});

describe("the toolbar's link form and the history panel", () => {
  it("takes only web and mail addresses for a link, and offers to remove one", () => {
    const bad = renderToStaticMarkup(<LinkForm current="javascript:alert(1)" onDone={() => {}} />);
    expect(bad).toContain("Only web (https) and mail addresses.");
    expect(bad).toMatch(/<button type="submit" class="primary" disabled="">Update<\/button>/);
    expect(bad).toContain(">Remove link<");
    const fresh = renderToStaticMarkup(<LinkForm current="" onDone={() => {}} />);
    expect(fresh).not.toContain("Only web");
    expect(fresh).not.toContain("Remove link");
  });

  it("says it is reading the versions before they come", () => {
    const html = renderToStaticMarkup(
      <HistoryPanel documentId="d1" rev={3} owner dirty={false} onClose={() => {}} onRestored={() => {}} api={{ versions: () => new Promise(() => {}), version: () => new Promise(() => {}), restore: () => new Promise(() => {}) }} />,
    );
    expect(html).toContain("Version history");
    expect(html).toContain("Reading its versions…");
    expect(html).toContain('aria-label="Close version history"');
  });
});

describe("the merge prompt", () => {
  it("offers to merge or drop, and gives back my text where both sides changed a block", () => {
    const mine = [p("a", "My own wording")];
    const html = renderToStaticMarkup(<MergePrompt rev={9} merged={{ blocks: [p("a", "Theirs")], conflicts: ["a"] }} mine={mine} saving onMerge={() => {}} onDiscard={() => {}} />);
    expect(html).toContain("A newer version is here (version 9)");
    expect(html).toContain("yours was not saved yet");
    expect(html).toContain("One block was changed on both sides");
    expect(html).toContain("My own wording");
    expect(html).toContain(">Merge my changes<");
    expect(html).toContain(">Drop my changes<");
  });
});

describe("a document drawn without the editor", () => {
  it("draws the blocks and chips, links only to safe addresses, images only from the document", () => {
    const html = renderToStaticMarkup(
      <StaticBlocks
        documentId="d1"
        blocks={[
          { type: "heading", attrs: { id: "h", level: 2 }, content: [{ type: "text", text: "Goals" }] },
          {
            type: "paragraph",
            attrs: { id: "p" },
            content: [
              { type: "text", text: "safe", marks: [{ type: "link", attrs: { href: "https://example.com" } }] },
              { type: "text", text: " bad", marks: [{ type: "link", attrs: { href: "javascript:alert(1)" } }] },
              { type: "mention", attrs: { uid: "u", name: "Ana" } },
              { type: "dropdown", attrs: { options: ["Open", "Done"], value: null } },
            ],
          },
          { type: "image", attrs: { id: "i", src: "image:abc", alt: "A chart" } },
          { type: "image", attrs: { id: "j", src: "https://evil.example/x.png", alt: "x" } },
          { type: "csv", attrs: { id: "c" }, content: [{ type: "text", text: "a,b\n1,2" }] },
          { type: "pending", attrs: { id: "w", intent: "Risks" } },
        ]}
      />,
    );
    expect(html).toContain("<h2>");
    expect(html).toContain('href="https://example.com"');
    expect(html).not.toContain("javascript:");
    expect(html).toContain("@Ana");
    expect(html).toContain("—");
    expect(html).toContain('src="/api/documents/d1/images/abc"');
    expect(html).not.toContain("evil.example");
    expect(html).toContain("<th scope=\"col\">a</th>");
    expect(html).toContain("pi is writing");
    expect(html).toContain("Risks");
  });
});

describe("the document in the chat and the sidebar", () => {
  const result = (toolName: string, details: unknown, isError = false) =>
    ({ id: 1, kind: "pi.tool-result", model: [{ role: "toolResult", toolName, toolCallId: "c", content: [], details, isError, timestamp: 0 }] }) as unknown as EntryRecord;

  it("shows a card for a document tool's result, which opens the document, and says when an edit was requested", () => {
    const made = documentOf(result("document_create", { documentId: "d1", title: "Q3 plan", rev: 2 }))!;
    const html = renderToStaticMarkup(<DocumentCard details={made} />);
    expect(html).toContain('href="/d/d1"');
    expect(html).toContain("Q3 plan");
    expect(html).toContain("Document · version 2 · open");
    const asked = documentOf(result("document_update", { documentId: "d1", title: "Q3 plan", requested: "r7" }))!;
    expect(renderToStaticMarkup(<DocumentCard details={asked} />)).toContain("edit requested, waits for its owner");
    // Not a document's result, or a failed one: no card.
    expect(documentOf(result("artifact_publish", { artifactId: "a", version: 1, title: "x" }))).toBeUndefined();
    expect(documentOf(result("document_create", { documentId: "d1", title: "x" }, true))).toBeUndefined();
  });

  it("lists the documents in the sidebar, newest first as given, the open one marked, and says when there are none", () => {
    const html = renderToStaticMarkup(
      <DocumentsList
        documents={[
          { id: "d2", title: "Brief", chatId: "c", ownerUid: "u", rev: 3, updatedAt: 2, unread: true },
          { id: "d1", title: "", chatId: "c", ownerUid: "u", rev: 1, updatedAt: 1 },
        ]}
        error={null}
        openId="d1"
        navigate={() => {}}
      />,
    );
    expect(html).toContain("Documents");
    expect(html).toMatch(/class="nav-item unread"[^>]*>.*Brief/);
    expect(html).toMatch(/class="nav-item active"[^>]*>.*Untitled document/);
    expect(renderToStaticMarkup(<DocumentsList documents={[]} error={null} navigate={() => {}} />)).toContain("None yet");
    expect(renderToStaticMarkup(<DocumentsList documents={null} error="x" navigate={() => {}} />)).toContain("Could not read your documents");
  });
});
