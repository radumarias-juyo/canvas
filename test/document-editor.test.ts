import { describe, expect, it } from "vitest";
import { checkDocument, DOCUMENT_SCHEMA, type DocNode } from "../shared/document.ts";
import { csvRows, dateLabel, dropdownOptions } from "../src/documents/chips.ts";
import { diffBlocks, documentDetails, mergeBlocks, textOf, withTab, type Block } from "../src/documents/model.ts";
import { documentSchema, imageUrl, missingExtensions, safeHref } from "../src/documents/schema.ts";

const p = (id: string, text: string, h?: string): Block => ({
  type: "paragraph",
  attrs: { id, ...(h && { h }) },
  ...(text && { content: [{ type: "text", text }] }),
});

/** A tab's blocks as stored (checkDocument fills defaults and hashes), the way the editor receives them. */
const stored = (content: DocNode[]) => checkDocument({ title: "Plan", rev: 1, tabs: [{ id: "t1", title: "Tab 1", content }] }).tabs[0]!.content;

/** Everything the model allows, once: what the editor must read and give back unchanged. */
const EVERYTHING: DocNode[] = [
  { type: "heading", attrs: { id: "b1", level: 1 }, content: [{ type: "text", text: "Plan" }] },
  {
    type: "paragraph",
    attrs: { id: "b2" },
    content: [
      { type: "text", text: "Owner ", marks: [{ type: "bold" }] },
      { type: "mention", attrs: { uid: "u1", name: "Ana" } },
      { type: "text", text: " due " },
      { type: "date", attrs: { value: "2026-11-20" } },
      { type: "text", text: " docs", marks: [{ type: "link", attrs: { href: "https://example.com" } }] },
    ],
  },
  { type: "bulletList", attrs: { id: "b3" }, content: [{ type: "listItem", attrs: { id: "b3a" }, content: [{ type: "paragraph", attrs: { id: "b3b" }, content: [{ type: "text", text: "one" }] }] }] },
  { type: "orderedList", attrs: { id: "b4", start: 3 }, content: [{ type: "listItem", attrs: { id: "b4a" }, content: [{ type: "paragraph", attrs: { id: "b4b" }, content: [{ type: "text", text: "two" }] }] }] },
  {
    type: "taskList",
    attrs: { id: "b5" },
    content: [{ type: "taskItem", attrs: { id: "b5a", checked: true }, content: [{ type: "paragraph", attrs: { id: "b5b" }, content: [{ type: "text", text: "done" }] }] }],
  },
  {
    type: "table",
    attrs: { id: "b6" },
    content: [
      { type: "tableRow", attrs: { id: "r1" }, content: [{ type: "tableHeader", attrs: { id: "c1" }, content: [{ type: "paragraph", attrs: { id: "c1p" }, content: [{ type: "text", text: "Status" }] }] }] },
      {
        type: "tableRow",
        attrs: { id: "r2" },
        content: [{ type: "tableCell", attrs: { id: "c2" }, content: [{ type: "paragraph", attrs: { id: "c2p" }, content: [{ type: "dropdown", attrs: { options: ["Open", "Done"], value: "Open" } }] }] }],
      },
    ],
  },
  { type: "codeBlock", attrs: { id: "b7", language: "ts" }, content: [{ type: "text", text: "let a = 1;" }] },
  { type: "csv", attrs: { id: "b8" }, content: [{ type: "text", text: "a,b\n1,2" }] },
  { type: "latex", attrs: { id: "b9" }, content: [{ type: "text", text: "e^{i\\pi}+1=0" }] },
  { type: "image", attrs: { id: "b10", src: "image:abc", alt: "chart" } },
  { type: "embed", attrs: { id: "b11", kind: "chart", spec: "{}", title: "Signups" } },
  { type: "pending", attrs: { id: "b12", intent: "Risks: what could slip" } },
];

describe("the document editor's schema", () => {
  const schema = documentSchema();

  it("is DOCUMENT_SCHEMA: every node and mark it names, nothing else, with its content, groups and attributes", () => {
    expect(missingExtensions()).toEqual([]);
    expect(Object.keys(schema.nodes).sort()).toEqual(Object.keys(DOCUMENT_SCHEMA.nodes).sort());
    expect(Object.keys(schema.marks).sort()).toEqual(Object.keys(DOCUMENT_SCHEMA.marks).sort());
    for (const [name, spec] of Object.entries(DOCUMENT_SCHEMA.nodes)) {
      const type = schema.nodes[name]!;
      expect(type.spec.content ?? "", name).toBe(spec.content ?? "");
      expect(type.spec.group, name).toBe(spec.group);
      expect(Object.keys(type.spec.attrs ?? {}).sort(), name).toEqual(Object.keys(spec.attrs ?? {}).sort());
      expect(!!type.spec.atom, `${name} atom`).toBe(!!spec.atom);
      expect(!!type.spec.code, `${name} code`).toBe(!!spec.code);
    }
    for (const [name, spec] of Object.entries(DOCUMENT_SCHEMA.marks)) expect(Object.keys(schema.marks[name]!.spec.attrs ?? {}), name).toEqual(Object.keys(spec.attrs ?? {}));
  });

  it("refuses what the model leaves out: an unknown node or mark, a block in a table cell, a heading in a list item", () => {
    expect(() => schema.nodeFromJSON({ type: "doc", content: [{ type: "blockquote", content: [] }] })).toThrow();
    expect(() => schema.nodeFromJSON({ type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "x", marks: [{ type: "underline" }] }] }] })).toThrow();
    const cellWithList = {
      type: "doc",
      content: [{ type: "table", content: [{ type: "tableRow", content: [{ type: "tableCell", content: [{ type: "bulletList", content: [{ type: "listItem", content: [{ type: "paragraph" }] }] }] }] }] }],
    };
    expect(() => schema.nodeFromJSON(cellWithList).check()).toThrow();
    const itemWithHeading = { type: "doc", content: [{ type: "bulletList", content: [{ type: "listItem", content: [{ type: "paragraph" }, { type: "heading", attrs: { level: 2 } }] }] }] };
    expect(() => schema.nodeFromJSON(itemWithHeading).check()).toThrow();
    // Headings 1 to 3 from pasted HTML, nothing deeper.
    expect((schema.nodes.heading!.spec.parseDOM ?? []).map((rule) => rule.tag)).toEqual(["h1", "h2", "h3"]);
  });

  it("reads everything the model allows and gives it back as checkDocument takes it", () => {
    const content = stored(EVERYTHING);
    const node = schema.nodeFromJSON({ type: "doc", content });
    node.check();
    const back = (node.toJSON() as { content: DocNode[] }).content;
    // Unchanged through the editor: the same document, and nothing checkDocument would refuse.
    expect(() => checkDocument({ title: "Plan", rev: 1, tabs: [{ id: "t1", title: "Tab 1", content: back }] })).not.toThrow();
    expect(diffBlocks("t1", content as Block[], back as Block[], 1)).toEqual([]);
  });

  it("lets no mark or chip into a code, csv or latex block", () => {
    for (const type of ["codeBlock", "csv", "latex"]) {
      const bad = { type: "doc", content: [{ type, attrs: { id: "x" }, content: [{ type: "text", text: "a", marks: [{ type: "bold" }] }] }] };
      expect(() => schema.nodeFromJSON(bad).check(), type).toThrow();
    }
  });

  it("links only to the web or mail, and shows only images stored with the document", () => {
    expect(safeHref("https://example.com/a")).toBe("https://example.com/a");
    expect(safeHref("mailto:a@example.com")).toBe("mailto:a@example.com");
    for (const bad of ["javascript:alert(1)", "data:text/html,x", "//evil.example", "/relative", 3]) expect(safeHref(bad)).toBeNull();
    expect(imageUrl("d1", "image:abc")).toBe("/api/documents/d1/images/abc");
    for (const bad of ["https://evil.example/a.png", "/api/documents/d1/images/abc", "data:image/png;base64,AAA", "image:../x", null]) expect(imageUrl("d1", bad)).toBeNull();
  });
});

describe("the document model's edits", () => {
  it("says a block's text, chips by their label", () => {
    expect(textOf({ type: "paragraph", content: [{ type: "text", text: "Hi " }, { type: "mention", attrs: { name: "Ana", uid: "u" } }] })).toBe("Hi @Ana");
    expect(textOf({ type: "pending", attrs: { intent: "Goals" } })).toBe("Goals");
  });

  it("turns an edit into ops by block id: replace with the hash read, insert by its neighbour, delete", () => {
    const base = [p("a", "one", "h1"), p("b", "two", "h2"), p("c", "three", "h3")];
    const mine = [p("a", "one", "h1"), p("b", "TWO", "h2"), p("n", "new")];
    expect(diffBlocks("t1", base, mine, 7)).toEqual([
      { op: "delete", tab: "t1", target: { id: "c" }, ifHash: "h3", ifRev: 7 },
      { op: "replace", tab: "t1", target: { id: "b" }, with: { blocks: [p("b", "TWO")] }, ifHash: "h2", ifRev: 7 },
      { op: "insert", tab: "t1", at: { after: "b" }, with: { blocks: [p("n", "new")] } },
    ]);
    // Nothing changed: no ops (a stale hash, or attributes in another order, are no change).
    const reordered = base.map((block) => ({ content: block.content, attrs: { h: "other", id: block.attrs.id }, type: block.type }) as Block);
    expect(diffBlocks("t1", base, reordered, 7)).toEqual([]);
    // A block added first goes before the first one kept; into an empty tab, at the end.
    expect(diffBlocks("t1", base, [p("z", "first"), ...base], 7)).toEqual([{ op: "insert", tab: "t1", at: { before: "a" }, with: { blocks: [p("z", "first")] } }]);
    expect(diffBlocks("t1", [], [p("z", "only")], 7)).toEqual([{ op: "insert", tab: "t1", at: { end: true }, with: { blocks: [p("z", "only")] } }]);
  });

  it("merges my edits onto a newer save block by block, keeping theirs where we both changed one", () => {
    const base = [p("a", "one"), p("b", "two"), p("c", "three"), p("d", "four")];
    // Mine: changed a and b; deleted d; added m after a.
    const mine = [p("a", "ONE"), p("m", "mine"), p("b", "TWO-mine"), p("c", "three")];
    // Theirs: changed b and c; added t at the end.
    const theirs = [p("a", "one"), p("b", "TWO-theirs"), p("c", "THREE"), p("d", "four"), p("t", "theirs")];
    const merged = mergeBlocks(base, mine, theirs);
    expect(merged.blocks.map((block) => `${block.attrs.id}:${textOf(block)}`)).toEqual(["a:ONE", "m:mine", "b:TWO-theirs", "c:THREE", "t:theirs"]);
    expect(merged.conflicts).toEqual(["b"]);
  });

  it("keeps a block I deleted when they changed it meanwhile, and says so", () => {
    const merged = mergeBlocks([p("a", "one"), p("b", "two")], [p("a", "one")], [p("a", "one"), p("b", "TWO")]);
    expect(merged.blocks.map((block) => block.attrs.id)).toEqual(["a", "b"]);
    expect(merged.conflicts).toEqual(["b"]);
  });

  it("swaps one tab's blocks for a save, and reads a document tool's card details", () => {
    const doc = { title: "Plan", rev: 2, tabs: [{ id: "t1", title: "Tab 1", content: [p("a", "x")] }, { id: "t2", title: "Tab 2", content: [] }] };
    expect(withTab(doc, "t2", [p("b", "y")]).tabs.map((tab) => tab.content.length)).toEqual([1, 1]);
    expect(documentDetails({ documentId: "d1", title: "Plan", rev: 3 })).toEqual({ documentId: "d1", title: "Plan", rev: 3 });
    expect(documentDetails({ documentId: "d1", title: "Plan", requested: "r1" })).toMatchObject({ requested: "r1" });
    expect(documentDetails({ artifactId: "a", version: 1 })).toBeUndefined();
    expect(documentDetails(null)).toBeUndefined();
  });
});

describe("the document's chips and blocks", () => {
  it("reads CSV with quotes, commas and new lines in a cell", () => {
    expect(csvRows('Name,Note\nAna,"likes, commas"\n"Bo ""B""","two\nlines"\n\n')).toEqual([
      ["Name", "Note"],
      ["Ana", "likes, commas"],
      ['Bo "B"', "two\nlines"],
    ]);
    expect(csvRows("")).toEqual([]);
  });

  it("shows a date in the reader's format, and a dropdown's options as typed", () => {
    expect(dateLabel("2026-11-20", "en-US")).toBe("Nov 20, 2026");
    expect(dateLabel("soon")).toBe("soon");
    expect(dateLabel("")).toBe("No date");
    expect(dropdownOptions(" Open, Done ,, Open ")).toEqual(["Open", "Done"]);
  });
});
