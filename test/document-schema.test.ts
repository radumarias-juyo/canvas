import { describe, expect, it } from "vitest";
import {
  blockHash,
  blockText,
  checkBlocks,
  checkDocument,
  DOCUMENT_SCHEMA,
  DocumentError,
  emptyDocument,
  findBlock,
  findByQuote,
  idsIn,
  MAX_DEPTH,
  MAX_DOCUMENT_BYTES,
  MAX_TABS,
  outline,
  outlineText,
  tabDoc,
  TOP_BLOCK_TYPES,
  type DocDocument,
  type DocNode,
} from "../shared/document.ts";

const t = (text: string, marks?: DocNode["marks"]): DocNode => (marks ? { type: "text", text, marks } : { type: "text", text });
const p = (id: string, ...content: DocNode[]): DocNode => ({ type: "paragraph", attrs: { id }, ...(content.length && { content }) });
const cell = (id: string, text: string, header = false): DocNode => ({ type: header ? "tableHeader" : "tableCell", attrs: { id }, content: [p(`${id}p`, t(text))] });

/** A node as the tests change it: any shape, so they can break the schema on purpose. */
type Loose = any;

/** A document with every block kind, mark and chip of the schema. */
function sample(): Record<string, unknown> {
  return {
    title: "Quarterly plan",
    rev: 3,
    tabs: [
      {
        id: "tab1",
        title: "Plan",
        content: [
          { type: "heading", attrs: { id: "h1", level: 1 }, content: [t("Goals")] },
          p("p1", t("Ship "), t("fast", [{ type: "bold" }]), t(" and "), t("safe", [{ type: "link", attrs: { href: "https://example.com" } }]), t(".")),
          p("p2", t("Owner: "), { type: "mention", attrs: { uid: "u1", name: "Ana" } }, t(" by "), { type: "date", attrs: { value: "2026-12-01" } }),
          {
            type: "bulletList",
            attrs: { id: "l1" },
            content: [
              { type: "listItem", attrs: { id: "li1" }, content: [p("lp1", t("First")), { type: "orderedList", attrs: { id: "l2", start: 3 }, content: [{ type: "listItem", attrs: { id: "li2" }, content: [p("lp2", t("Nested"))] }] }] },
            ],
          },
          { type: "taskList", attrs: { id: "tl" }, content: [{ type: "taskItem", attrs: { id: "ti", checked: true }, content: [p("tp", t("Done thing"))] }] },
          {
            type: "table",
            attrs: { id: "tb" },
            content: [
              { type: "tableRow", attrs: { id: "r1" }, content: [cell("c11", "Item", true), cell("c12", "Status", true)] },
              {
                type: "tableRow",
                attrs: { id: "r2" },
                content: [cell("c21", "Renewal"), { type: "tableCell", attrs: { id: "c22" }, content: [p("c22p", { type: "dropdown", attrs: { options: ["Open", "Done"], value: "Open" } })] }],
              },
            ],
          },
          { type: "codeBlock", attrs: { id: "cb", language: "python" }, content: [t("print(1)")] },
          { type: "csv", attrs: { id: "cs" }, content: [t("a,b\n1,2")] },
          { type: "latex", attrs: { id: "lx" }, content: [t("e = mc^2")] },
          { type: "image", attrs: { id: "im", src: "image:abc123", alt: "A chart" } },
          { type: "embed", attrs: { id: "em", kind: "chart", spec: "{}", title: "Revenue" } },
          { type: "pending", attrs: { id: "pd", intent: "Risks: what could slip" } },
        ],
      },
    ],
  };
}

/** `sample()` with `change` applied to its first tab's content. */
function variant(change: (content: Loose[]) => void): Record<string, unknown> {
  const doc = sample();
  change((doc.tabs as { content: Loose[] }[])[0]!.content);
  return doc;
}

const refuses = (value: unknown, reason: RegExp) => expect(() => checkDocument(value)).toThrow(reason);

describe("checkDocument", () => {
  it("takes every block kind, mark and chip of the schema, filling defaults and every block's hash", () => {
    const doc = checkDocument(sample());
    expect(doc.rev).toBe(3);
    const heading = doc.tabs[0]!.content[0]!;
    expect(heading.attrs).toEqual({ id: "h1", h: blockHash(heading), level: 1 });
    expect(findBlock(doc, "c22")!.node.attrs).toMatchObject({ colspan: 1, rowspan: 1, colwidth: null });
    expect(findBlock(doc, "im")!.node.attrs).toMatchObject({ width: null });
    // Every block has an h; inline nodes have no id.
    for (const id of idsIn(doc)) if (id !== "tab1") expect(findBlock(doc, id)!.node.attrs!.h).toMatch(/^[0-9a-f]{14}$/);
  });

  it("recomputes a hash sent with the document, never trusting it", () => {
    const doc = checkDocument(variant((content) => ((content[1]!.attrs as Record<string, unknown>).h = "0000000000000a")));
    expect(doc.tabs[0]!.content[1]!.attrs!.h).not.toBe("0000000000000a");
  });

  it("takes Tiptap's JSON as it writes it: empty marks and attrs, a link's target and rel, a doc per tab", () => {
    const doc = checkDocument(
      variant((content) => {
        content[1] = { type: "paragraph", attrs: { id: "p1" }, marks: [], content: [{ type: "text", text: "x", marks: [{ type: "bold", attrs: {} }, { type: "link", attrs: { href: "mailto:a@b.c", target: "_blank", rel: "noopener", class: null } }] }] };
      }),
    );
    expect(doc.tabs[0]!.content[1]!.content![0]!.marks).toEqual([{ type: "bold" }, { type: "link", attrs: { href: "mailto:a@b.c" } }]);
    expect(tabDoc(doc.tabs[0]!)).toEqual({ type: "doc", content: doc.tabs[0]!.content });
  });

  it.each([
    ["an unknown node type", (c: Loose[]) => c.push({ type: "blockquote", attrs: { id: "q" } }), /blockquote" is not a node type/],
    ["a doc node inside a tab", (c: Loose[]) => c.push({ type: "doc", content: [] }), /is not a node type/],
    ["an unknown attribute", (c: Loose[]) => ((c[0]!.attrs as Record<string, unknown>).color = "red"), /attrs\.color: is not an attribute of heading/],
    ["heading level 4", (c: Loose[]) => ((c[0]!.attrs as Record<string, unknown>).level = 4), /level: must be one of 1, 2, 3/],
    ["an unknown mark", (c: Loose[]) => (c[1] = p("p1", t("x", [{ type: "underline" } as never]))), /is not a mark/],
    ["a repeated mark", (c: Loose[]) => (c[1] = p("p1", t("x", [{ type: "bold" }, { type: "bold" }]))), /repeats the bold mark/],
    ["code with another mark", (c: Loose[]) => (c[1] = p("p1", t("x", [{ type: "code" }, { type: "italic" }]))), /code takes no other mark/],
    ["a javascript: link", (c: Loose[]) => (c[1] = p("p1", t("x", [{ type: "link", attrs: { href: "javascript:alert(1)" } }]))), /not a valid link/],
    ["a mark in a code block", (c: Loose[]) => (c[6] = { type: "codeBlock", attrs: { id: "cb" }, content: [t("x", [{ type: "bold" }])] }), /may carry no marks/],
    ["an empty text node", (c: Loose[]) => (c[1] = p("p1", t(""))), /must be text, not empty/],
    ["a block without an id", (c: Loose[]) => (c[1] = { type: "paragraph", content: [t("x")] }), /attrs\.id: is required/],
    ["an id used twice", (c: Loose[]) => (c[1] = p("h1", t("x"))), /"h1" is used twice/],
    ["a bad id", (c: Loose[]) => (c[1] = p("has space", t("x"))), /not a valid block id/],
    ["a list item that starts with a list", (c: Loose[]) => (c[3] = { type: "bulletList", attrs: { id: "l1" }, content: [{ type: "listItem", attrs: { id: "li1" }, content: [{ type: "bulletList", attrs: { id: "l9" }, content: [{ type: "listItem", attrs: { id: "li9" }, content: [p("x9")] }] }] }] }), /listItem may not hold bulletList/],
    ["an empty list", (c: Loose[]) => (c[3] = { type: "bulletList", attrs: { id: "l1" } }), /needs listItem/],
    ["a paragraph straight in a list", (c: Loose[]) => (c[3] = { type: "bulletList", attrs: { id: "l1" }, content: [p("x1")] }), /bulletList may not hold paragraph/],
    ["a table with ragged rows", (c: Loose[]) => (c[5] = { type: "table", attrs: { id: "tb" }, content: [{ type: "tableRow", attrs: { id: "r1" }, content: [cell("a", "1"), cell("b", "2")] }, { type: "tableRow", attrs: { id: "r2" }, content: [cell("c", "3")] }] }), /rows of different widths/],
    ["a merged cell", (c: Loose[]) => (c[5] = { type: "table", attrs: { id: "tb" }, content: [{ type: "tableRow", attrs: { id: "r1" }, content: [{ ...cell("a", "1"), attrs: { id: "a", colspan: 2 } }] }] }), /colspan: must be one of 1/],
    ["a dropdown value outside its options", (c: Loose[]) => (c[1] = p("p1", { type: "dropdown", attrs: { options: ["Open"], value: "Closed" } })), /value that is none of its options/],
    ["a date that does not exist", (c: Loose[]) => (c[1] = p("p1", { type: "date", attrs: { value: "2026-02-30" } })), /not a real date/],
    ["an image from outside the document", (c: Loose[]) => (c[9] = { type: "image", attrs: { id: "im", src: "https://tracker.example/pixel.png" } }), /image source/],
    ["an embed of an unknown kind", (c: Loose[]) => (c[10] = { type: "embed", attrs: { id: "em", kind: "iframe", spec: "x" } }), /kind: must be one of/],
    ["text with an id", (c: Loose[]) => (c[1] = p("p1", { type: "text", text: "x", attrs: { id: "t" } } as never)), /a text node has no attrs/],
    ["a key outside the node", (c: Loose[]) => (c[1] = { ...p("p1", t("x")), style: "color:red" }), /style: is not part of a node/],
    ["inline content at the top of a tab", (c: Loose[]) => c.push(t("loose")), /a tab may not hold text/],
  ])("refuses %s", (_, change, reason) => refuses(variant(change), reason));

  it("refuses a document without tabs, with an empty tab, or past its caps", () => {
    refuses({ title: "x", rev: 0, tabs: [] }, /at least one tab/);
    refuses({ title: "x", rev: 0, tabs: [{ id: "t", title: "T", content: [] }] }, /a tab needs/);
    refuses({ title: "x", rev: -1, tabs: [] }, /rev: must be a whole number/);
    refuses({ ...sample(), owner: "me" }, /owner: is not part of a document/);
    refuses({ title: "x", rev: 0, tabs: Array.from({ length: MAX_TABS + 1 }, (_, i) => ({ id: `t${i}`, title: "T", content: [p(`p${i}`)] })) }, /at most 20 tabs/);
    refuses({ title: "x", rev: 0, tabs: [{ id: "t", title: "T", content: [p("p", t("x".repeat(MAX_DOCUMENT_BYTES)))] }] }, /larger than/);
    // Lists nested past the depth cap.
    let list: DocNode = { type: "bulletList", attrs: { id: "d0" }, content: [{ type: "listItem", attrs: { id: "i0" }, content: [p("q0")] }] };
    for (let i = 1; i <= MAX_DEPTH; i++) list = { type: "bulletList", attrs: { id: `d${i}` }, content: [{ type: "listItem", attrs: { id: `i${i}` }, content: [p(`q${i}`), list] }] };
    refuses({ title: "x", rev: 0, tabs: [{ id: "t", title: "T", content: [list] }] }, /nests deeper than/);
    expect(() => checkDocument(null)).toThrow(DocumentError);
  });

  it("gives blocks without ids new ones when asked, never one in use", () => {
    const doc = checkDocument({ title: "x", rev: 0, tabs: [{ title: "T", content: [{ type: "paragraph", content: [t("a")] }, p("keep", t("b"))] }] }, { assignIds: true });
    const [first, second] = doc.tabs[0]!.content;
    expect(first!.attrs!.id).toMatch(/^b[a-z0-9]{10}$/);
    expect(second!.attrs!.id).toBe("keep");
    expect(doc.tabs[0]!.id).toMatch(/^b/);
  });
});

describe("checkBlocks", () => {
  it("checks new top-level blocks against the document: ids assigned, none taken, no nested-only kinds", () => {
    const doc = checkDocument(sample());
    const [one] = checkBlocks([{ type: "paragraph", content: [t("new")] }], doc);
    expect(idsIn(doc).has(String(one!.attrs!.id))).toBe(false);
    expect(() => checkBlocks([p("h1", t("x"))], doc)).toThrow(/"h1" is used twice/);
    expect(() => checkBlocks([{ type: "listItem", attrs: { id: "z" }, content: [p("zz")] }], doc)).toThrow(/not a top-level block/);
    expect(() => checkBlocks([], doc)).toThrow(/at least one block/);
  });
});

describe("blockHash", () => {
  it("hashes content, not where it is: the same block with other ids hashes the same; any change of content does not", () => {
    const a = p("a1", t("Same "), t("words", [{ type: "italic" }]));
    const b = p("zz", t("Same "), t("words", [{ type: "italic" }]));
    expect(blockHash(a)).toBe(blockHash(b));
    expect(blockHash({ ...a, attrs: { id: "a1", h: "whatever" } })).toBe(blockHash(a));
    expect(blockHash(p("a1", t("Same "), t("words")))).not.toBe(blockHash(a));
    expect(blockHash({ type: "heading", attrs: { id: "a1", level: 2 }, content: a.content })).not.toBe(blockHash({ type: "heading", attrs: { id: "a1", level: 3 }, content: a.content }));
    // A list's hash follows its items' content, whatever their ids.
    const list = (id: string, word: string): DocNode => ({ type: "bulletList", attrs: { id }, content: [{ type: "listItem", attrs: { id: `${id}i` }, content: [p(`${id}p`, t(word))] }] });
    expect(blockHash(list("x", "one"))).toBe(blockHash(list("y", "one")));
    expect(blockHash(list("x", "one"))).not.toBe(blockHash(list("x", "two")));
  });
});

describe("text, finding and the outline", () => {
  const doc: DocDocument = checkDocument(sample());

  it("reads a block's text with chips as words, a table as rows of cells", () => {
    expect(blockText(findBlock(doc, "p1")!.node)).toBe("Ship fast and safe.");
    expect(blockText(findBlock(doc, "p2")!.node)).toBe("Owner: @Ana by 2026-12-01");
    expect(blockText(findBlock(doc, "tb")!.node)).toBe("Item | Status\nRenewal | Open");
    expect(blockText(findBlock(doc, "l1")!.node)).toBe("First\nNested");
    expect(blockText(findBlock(doc, "im")!.node)).toBe("A chart");
    expect(blockText(findBlock(doc, "pd")!.node)).toBe("Risks: what could slip");
  });

  it("finds a block by id at any depth, with its parent and top-level block", () => {
    const found = findBlock(doc, "li2")!;
    expect(found.parent?.attrs?.id).toBe("l2");
    expect(found.index).toBe(0);
    expect(found.topId).toBe("l1");
    expect(findBlock(doc, "tb")).toMatchObject({ tabId: "tab1", index: 5, topId: "tb" });
    expect(findBlock(doc, "nope")).toBeUndefined();
  });

  it("finds the innermost blocks that hold quoted words, across marks and chips, whatever the spacing or case", () => {
    expect(findByQuote(doc, "fast  and SAFE")).toEqual([{ tabId: "tab1", id: "p1", type: "paragraph", topId: "p1" }]);
    expect(findByQuote(doc, "@Ana by")).toMatchObject([{ id: "p2" }]);
    // The paragraph in the list item, not the item or the list.
    expect(findByQuote(doc, "Nested")).toMatchObject([{ id: "lp2", topId: "l1" }]);
    // In a table cell: the cell's paragraph.
    expect(findByQuote(doc, "Renewal")).toMatchObject([{ id: "c21p", topId: "tb" }]);
    // Ambiguous: more than one.
    expect(findByQuote(doc, "a").length).toBeGreaterThan(1);
    expect(findByQuote(doc, "   ")).toEqual([]);
  });

  it("outlines each tab's top-level blocks with ids, hashes and short text", () => {
    const view = outline(doc);
    expect(view.rev).toBe(3);
    expect(view.tabs[0]!.blocks[0]).toEqual({ id: "h1", type: "heading", h: findBlock(doc, "h1")!.node.attrs!.h, level: 1, text: "Goals" });
    expect(view.tabs[0]!.blocks.find((one) => one.id === "tb")).toMatchObject({ items: 2 });
    const long = checkDocument({ title: "x", rev: 0, tabs: [{ id: "t", title: "T", content: [p("p", t("word ".repeat(40)))] }] });
    expect(outline(long).tabs[0]!.blocks[0]!.text).toHaveLength(80);
    expect(outlineText(doc)).toContain(`h1 ${findBlock(doc, "h1")!.node.attrs!.h} heading 1: Goals`);
  });

  it("starts a new document with one tab and one empty paragraph, valid as it is", () => {
    const fresh = emptyDocument("Notes");
    expect(checkDocument(fresh)).toEqual(fresh);
  });
});

describe("DOCUMENT_SCHEMA", () => {
  it("describes the same nodes and marks the check holds, as a ProseMirror SchemaSpec", () => {
    expect(Object.keys(DOCUMENT_SCHEMA.nodes)[0]).toBe("doc");
    expect(DOCUMENT_SCHEMA.nodes.doc!.content).toBe("block+");
    expect(DOCUMENT_SCHEMA.nodes.listItem!.content).toBe("paragraph (paragraph | list)*");
    expect(DOCUMENT_SCHEMA.nodes.bulletList!.group).toBe("block list");
    expect(DOCUMENT_SCHEMA.nodes.codeBlock).toMatchObject({ content: "text*", marks: "", code: true });
    // Every block carries id and h; required attrs have no default.
    expect(DOCUMENT_SCHEMA.nodes.paragraph!.attrs).toEqual({ id: {}, h: { default: null } });
    expect(DOCUMENT_SCHEMA.nodes.mention!.attrs).toEqual({ uid: {}, name: {} });
    expect(Object.keys(DOCUMENT_SCHEMA.marks)).toEqual(["bold", "italic", "strike", "code", "link"]);
    expect(TOP_BLOCK_TYPES).toEqual(["paragraph", "heading", "bulletList", "orderedList", "taskList", "table", "codeBlock", "csv", "latex", "image", "embed", "pending"]);
  });
});
