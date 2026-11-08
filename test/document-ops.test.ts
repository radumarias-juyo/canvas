import { describe, expect, it } from "vitest";
import { blockText, checkDocument, findBlock, type DocDocument, type DocNode } from "../shared/document.ts";
import { blockMarkdown, markdownBlocks } from "../shared/document-markdown.ts";
import { applyOps, blockReading, checkOps, normaliseOps, outlineBlocks, searchReading, type DocOp } from "../shared/document-ops.ts";

const t = (text: string, marks?: DocNode["marks"]): DocNode => (marks ? { type: "text", text, marks } : { type: "text", text });
const p = (id: string, ...content: DocNode[]): DocNode => ({ type: "paragraph", attrs: { id }, ...(content.length && { content }) });

/** A document of one tab "t1": a heading, a paragraph with a bold word and a mention, a list, a table, another section. */
function sample(): DocDocument {
  return checkDocument({
    title: "Plan",
    rev: 4,
    tabs: [
      {
        id: "t1",
        title: "Tab 1",
        content: [
          { type: "heading", attrs: { id: "h1", level: 2 }, content: [t("Goals")] },
          p("p1", t("Ship the "), t("connector", [{ type: "bold" }]), t(" by Friday with "), { type: "mention", attrs: { uid: "u1", name: "Ana" } }, t(".")),
          {
            type: "bulletList",
            attrs: { id: "l1" },
            content: [
              { type: "listItem", attrs: { id: "i1" }, content: [p("ip1", t("First item"))] },
              { type: "listItem", attrs: { id: "i2" }, content: [p("ip2", t("Second item"))] },
            ],
          },
          {
            type: "table",
            attrs: { id: "tb" },
            content: [
              { type: "tableRow", attrs: { id: "r0" }, content: [{ type: "tableHeader", attrs: { id: "c00" }, content: [p("cp00", t("Team"))] }, { type: "tableHeader", attrs: { id: "c01" }, content: [p("cp01", t("Owner"))] }] },
              { type: "tableRow", attrs: { id: "r1" }, content: [{ type: "tableCell", attrs: { id: "c10" }, content: [p("cp10", t("Platform"))] }, { type: "tableCell", attrs: { id: "c11" }, content: [p("cp11", t("Ana"))] }] },
            ],
          },
          { type: "heading", attrs: { id: "h2", level: 2 }, content: [t("Risks")] },
          p("p2", t("Legal review may run long.")),
          { type: "pending", attrs: { id: "pd", intent: "Staffing: who owns each workstream" } },
        ],
      },
    ],
  });
}

const h = (doc: DocDocument, id: string) => String(findBlock(doc, id)!.node.attrs!.h);
const text = (doc: DocDocument, id: string) => blockText(findBlock(doc, id)!.node);
const ok = (result: ReturnType<typeof applyOps>) => {
  if (!result.ok) throw new Error(`refused: ${result.refused.code} ${result.refused.message}`);
  return result;
};

describe("markdown to blocks", () => {
  it("makes headings, lists, task lists, tables, code, CSV and formulas, with marks and safe links", () => {
    const blocks = markdownBlocks(
      "# One\n\n#### Deep\n\nSome **bold** and *it* and ~~old~~ and `code` and [a link](https://e.com) and [bad](javascript:alert(1)).\n\n" +
        "1. a\n2. b\n    - nested\n\n- [x] done\n- [ ] todo\n\n| A | B |\n|---|---|\n| 1 |\n\n```ts\nlet x = 1\n```\n\n```csv\na,b\n```\n\n```latex\nx^2\n```",
    );
    expect(blocks.map((one) => one.type)).toEqual(["heading", "heading", "paragraph", "orderedList", "taskList", "table", "codeBlock", "csv", "latex"]);
    expect(blocks[1]!.attrs).toEqual({ level: 3 });
    const marks = (blocks[2]!.content ?? []).map((node) => [node.text, (node.marks ?? []).map((mark) => mark.type).join()]);
    expect(marks).toContainEqual(["bold", "bold"]);
    expect(marks).toContainEqual(["a link", "link"]);
    // An unsafe link keeps its words, with no link.
    expect(JSON.stringify(blocks[2])).not.toContain("javascript");
    expect(blockText(blocks[2]!)).toContain(" and bad.");
    expect(blocks[3]!.content![1]!.content!.map((one) => one.type)).toEqual(["paragraph", "bulletList"]);
    expect(blocks[4]!.content!.map((item) => item.attrs!.checked)).toEqual([true, false]);
    // A short row is filled to the table's width: a table is a grid.
    expect(blocks[5]!.content!.map((row) => row.content!.length)).toEqual([2, 2]);
    expect(blocks[5]!.content![0]!.content![0]!.type).toBe("tableHeader");
    expect(blocks[6]!.attrs).toEqual({ language: "ts" });
    // Every block fits the schema.
    checkDocument({ title: "x", rev: 0, tabs: [{ id: "t", title: "t", content: blocks }] }, { assignIds: true });
  });

  it("turns chip tokens into chips, and a token alone into a pending placeholder", () => {
    const blocks = markdownBlocks("Due <?claude block d?> for <?claude block m?>\n\n<?claude block s1?>", {
      d: { type: "date", value: "2026-11-20" },
      m: { type: "mention", uid: "u1", name: "Ana" },
      s1: { type: "pending", intent: "Risks" },
    });
    expect(blocks[0]!.content!.map((one) => one.type)).toEqual(["text", "date", "text", "mention"]);
    expect(blocks[1]).toEqual({ type: "pending", attrs: { intent: "Risks" } });
    expect(() => markdownBlocks("<?claude block nope?>", {})).toThrow(/names no chip/);
  });

  it("keeps a line break inside a paragraph as one, and a reword never goes through it", () => {
    const [para] = markdownBlocks("line one\\\nline two");
    expect(para!.content!.map((one) => one.type)).toEqual(["text", "hardBreak", "text"]);
    expect(blockMarkdown(para!)).toBe("line one\\\nline two");
    const doc = checkDocument({ title: "x", rev: 1, tabs: [{ id: "t", title: "t", content: [{ ...para!, attrs: { id: "b" } }] }] });
    expect(applyOps(doc, [{ op: "replace", tab: "t", target: { quote: "one line" }, with: { text: "x" } }])).toMatchObject({ ok: false, refused: { code: "chip_in_change" } });
    expect(ok(applyOps(doc, [{ op: "replace", tab: "t", target: { quote: "two" }, with: { text: "2" } }])).doc.tabs[0]!.content[0]!.content!.length).toBe(3);
  });

  it("reads a block back as markdown", () => {
    const doc = sample();
    expect(blockMarkdown(findBlock(doc, "p1")!.node)).toBe("Ship the **connector** by Friday with @Ana.");
    expect(blockMarkdown(findBlock(doc, "tb")!.node)).toBe("| Team | Owner |\n| --- | --- |\n| Platform | Ana |");
    expect(blockMarkdown(findBlock(doc, "l1")!.node)).toBe("- First item\n- Second item");
  });
});

describe("checking ops as sent", () => {
  it("takes the contract's shapes and refuses anything else", () => {
    expect(checkOps([{ op: "replace", tab: "t1", target: { quote: "Friday", nth: 1 }, with: { text: "Monday" } }])).toHaveLength(1);
    expect(() => checkOps([])).toThrow();
    expect(() => checkOps([{ op: "move", tab: "t1" }])).toThrow(/replace, insert, delete or table/);
    expect(() => checkOps([{ op: "delete", tab: "t1", target: { quote: "x" } }])).toThrow(/by id/);
    expect(() => checkOps([{ op: "insert", tab: "t1", at: { somewhere: 1 }, with: { text: "x" } }])).toThrow(/at must be/);
    expect(() => checkOps([{ op: "table", tab: "t1", table: "tb", action: "merge" }])).toThrow(/action/);
    expect(() => checkOps(Array.from({ length: 51 }, () => ({ op: "insert", tab: "t1", at: { end: true }, with: { text: "x" } })))).toThrow(/at most/);
  });
});

describe("replacing", () => {
  it("rewords quoted words in place, keeping the marks and chips around them", () => {
    const doc = sample();
    const result = ok(applyOps(doc, [{ op: "replace", tab: "t1", target: { quote: "by friday" }, with: { text: "by Monday" } }]));
    const para = findBlock(result.doc, "p1")!.node;
    expect(blockText(para)).toBe("Ship the connector by Monday with @Ana.");
    expect(para.content!.find((node) => node.text === "connector")!.marks).toEqual([{ type: "bold" }]);
    expect(para.content!.some((node) => node.type === "mention")).toBe(true);
    expect(result.changed).toEqual(["p1"]);
    // The id stays; the hash follows the words.
    expect(h(result.doc, "p1")).not.toBe(h(doc, "p1"));
  });

  it("rewords a whole block by id with text, keeping what did not change, when guarded", () => {
    const doc = sample();
    const result = ok(applyOps(doc, [{ op: "replace", tab: "t1", target: { id: "p1" }, with: { text: "Ship the connector by Friday 21 with @Ana." }, ifHash: h(doc, "p1"), ifRev: 4 }]));
    expect(text(result.doc, "p1")).toBe("Ship the connector by Friday 21 with @Ana.");
    expect(findBlock(result.doc, "p1")!.node.content!.some((node) => node.type === "mention")).toBe(true);
  });

  it("refuses a reword that would cut through a chip", () => {
    const result = applyOps(sample(), [{ op: "replace", tab: "t1", target: { quote: "with @Ana" }, with: { text: "with Bo" } }]);
    expect(result).toMatchObject({ ok: false, refused: { code: "chip_in_change" } });
  });

  it("replaces a whole block from markdown, keeping its id when it stays the same kind", () => {
    const doc = sample();
    const result = ok(applyOps(doc, [{ op: "replace", tab: "t1", target: { id: "p2" }, with: { markdown: "Legal review **may** slip a week.\n\nA second paragraph." }, ifHash: h(doc, "p2"), ifRev: 4 }]));
    const tab = result.doc.tabs[0]!.content;
    const at = tab.findIndex((node) => node.attrs?.id === "p2");
    expect(blockText(tab[at]!)).toBe("Legal review may slip a week.");
    expect(blockText(tab[at + 1]!)).toBe("A second paragraph.");
    expect(result.changed).toContain("p2");
  });

  it("needs both guards on a whole-block replace or delete, and refuses a stale one, saying what stands now", () => {
    const doc = sample();
    expect(applyOps(doc, [{ op: "replace", tab: "t1", target: { id: "p2" }, with: { markdown: "x" } }])).toMatchObject({ ok: false, refused: { code: "missing_guard" } });
    const stale = applyOps(doc, [{ op: "replace", tab: "t1", target: { id: "p2" }, with: { markdown: "x" }, ifHash: "0000000000abcd", ifRev: 3 }]);
    expect(stale).toMatchObject({ ok: false, refused: { code: "guard_mismatch", rev: 4, now: { id: "p2", h: h(doc, "p2"), text: "Legal review may run long." } } });
    expect(applyOps(doc, [{ op: "delete", tab: "t1", target: { id: "p2" }, ifHash: h(doc, "p2"), ifRev: 9 }])).toMatchObject({ ok: false, refused: { code: "guard_mismatch" } });
  });

  it("refuses all ops when one is refused: nothing changes", () => {
    const doc = sample();
    const before = JSON.stringify(doc);
    const result = applyOps(doc, [
      { op: "replace", tab: "t1", target: { quote: "Friday" }, with: { text: "Monday" } },
      { op: "replace", tab: "t1", target: { quote: "not in the doc" }, with: { text: "x" } },
    ]);
    expect(result).toMatchObject({ ok: false, refused: { index: 1, code: "find_none" } });
    expect(JSON.stringify(doc)).toBe(before);
  });

  it("asks for nth when the words stand in several places, and finds the nth", () => {
    const doc = sample();
    expect(applyOps(doc, [{ op: "replace", tab: "t1", target: { quote: "item" }, with: { text: "entry" } }])).toMatchObject({ ok: false, refused: { code: "find_many" } });
    const result = ok(applyOps(doc, [{ op: "replace", tab: "t1", target: { quote: "item", nth: 2 }, with: { text: "entry" } }]));
    expect(text(result.doc, "ip2")).toBe("Second entry");
    expect(text(result.doc, "ip1")).toBe("First item");
  });

  it("replaces a list item with the items of a markdown list", () => {
    const doc = sample();
    const result = ok(applyOps(doc, [{ op: "replace", tab: "t1", target: { id: "i2" }, with: { markdown: "- Second, reworded\n- Third" }, ifHash: h(doc, "i2"), ifRev: 4 }]));
    expect(text(result.doc, "l1")).toBe("First item\nSecond, reworded\nThird");
  });

  it("sends table parts to table ops, and refuses content outside the schema", () => {
    const doc = sample();
    expect(applyOps(doc, [{ op: "replace", tab: "t1", target: { id: "r1" }, with: { markdown: "x" }, ifHash: h(doc, "r1"), ifRev: 4 }])).toMatchObject({ ok: false, refused: { code: "use_table_op" } });
    expect(applyOps(doc, [{ op: "replace", tab: "t1", target: { id: "ip1" }, with: { markdown: "# A heading in a list item" }, ifHash: h(doc, "ip1"), ifRev: 4 }])).toMatchObject({
      ok: false,
      refused: { code: "invalid" },
    });
  });
});

describe("pending placeholders", () => {
  it("fill by id without guards, retiring the placeholder", () => {
    const doc = sample();
    const result = ok(applyOps(doc, [{ op: "replace", tab: "t1", target: { id: "pd" }, with: { markdown: "## Staffing\n\n| Workstream | Owner |\n|---|---|\n| Connector | Platform |" } }]));
    expect(findBlock(result.doc, "pd")).toBeUndefined();
    expect(result.filled).toEqual(["pd"]);
    const types = result.doc.tabs[0]!.content.map((node) => node.type);
    expect(types.slice(-2)).toEqual(["heading", "table"]);
  });

  it("are planted as an outline: a lead, then one per section", () => {
    const blocks = outlineBlocks(["Goals: the outcomes", "Risks: what could slip"], "Q3 ships the connector.");
    expect(blocks.map((one) => one.type)).toEqual(["paragraph", "pending", "pending"]);
    expect(outlineBlocks([])).toEqual([{ type: "paragraph" }]);
  });
});

describe("inserting", () => {
  it("goes after or before a block, at the end of the tab, or at the end of a section", () => {
    const doc = sample();
    const result = ok(
      applyOps(doc, [
        { op: "insert", tab: "t1", at: { after: "p1" }, with: { markdown: "After p1." } },
        { op: "insert", tab: "t1", at: { before: "h1" }, with: { text: "Before everything." } },
        { op: "insert", tab: "t1", at: { endOfSection: "h1" }, with: { markdown: "End of Goals." } },
        { op: "insert", tab: "t1", at: { end: true }, with: { markdown: "The very end." } },
      ]),
    );
    const texts = result.doc.tabs[0]!.content.map((node) => blockText(node));
    expect(texts[0]).toBe("Before everything.");
    expect(texts[texts.indexOf("Ship the connector by Friday with @Ana.") + 1]).toBe("After p1.");
    expect(texts[texts.indexOf("Risks") - 1]).toBe("End of Goals.");
    expect(texts.at(-1)).toBe("The very end.");
    expect(result.changed).toHaveLength(4);
  });

  it("puts a markdown list's items into a list next to an item", () => {
    const result = ok(applyOps(sample(), [{ op: "insert", tab: "t1", at: { after: "i1" }, with: { markdown: "- In between" } }]));
    expect(text(result.doc, "l1")).toBe("First item\nIn between\nSecond item");
  });

  it("refuses a missing anchor or tab", () => {
    const doc = sample();
    expect(applyOps(doc, [{ op: "insert", tab: "t1", at: { after: "nope" }, with: { text: "x" } }])).toMatchObject({ ok: false, refused: { code: "no_block" } });
    expect(applyOps(doc, [{ op: "insert", tab: "t9", at: { end: true }, with: { text: "x" } }])).toMatchObject({ ok: false, refused: { code: "no_tab" } });
    expect(applyOps(doc, [{ op: "insert", tab: "t1", at: { endOfSection: "p1" }, with: { text: "x" } }])).toMatchObject({ ok: false, refused: { code: "bad_op" } });
  });
});

describe("deleting", () => {
  it("removes a guarded block, but never a tab's last one or a list's only item", () => {
    const doc = sample();
    const result = ok(applyOps(doc, [{ op: "delete", tab: "t1", target: { id: "i1" }, ifHash: h(doc, "i1"), ifRev: 4 }]));
    expect(text(result.doc, "l1")).toBe("Second item");
    expect(applyOps(result.doc, [{ op: "delete", tab: "t1", target: { id: "i2" }, ifHash: h(result.doc, "i2"), ifRev: 4 }])).toMatchObject({ ok: false, refused: { code: "bad_op" } });
    const single = checkDocument({ title: "x", rev: 1, tabs: [{ id: "t", title: "t", content: [p("only", t("x"))] }] });
    expect(applyOps(single, [{ op: "delete", tab: "t", target: { id: "only" }, ifHash: h(single, "only"), ifRev: 1 }])).toMatchObject({ ok: false, refused: { code: "last_block" } });
  });
});

describe("table ops", () => {
  const table = (doc: DocDocument) =>
    findBlock(doc, "tb")!.node.content!.map((row) => row.content!.map((cell) => blockText(cell)));

  it("adds rows and columns, sets cells and deletes, by position", () => {
    const doc = sample();
    const result = ok(
      applyOps(doc, [
        { op: "table", tab: "t1", table: "tb", action: "addRow", with: { text: "Comms | Bo" } },
        { op: "table", tab: "t1", table: "tb", action: "addColumn", with: { markdown: "Due | **Fri** | Mon" } },
        { op: "table", tab: "t1", table: "tb", action: "setCell", row: 1, col: 1, with: { text: "Cai" }, ifRev: 4 },
      ]),
    );
    expect(table(result.doc)).toEqual([
      ["Team", "Owner", "Due"],
      ["Platform", "Cai", "Fri"],
      ["Comms", "Bo", "Mon"],
    ]);
    // A new column's header cell is a header like the others.
    expect(findBlock(result.doc, "tb")!.node.content![0]!.content![2]!.type).toBe("tableHeader");
    const smaller = ok(
      applyOps(result.doc, [
        { op: "table", tab: "t1", table: "tb", action: "deleteRow", row: -1, ifRev: 4 },
        { op: "table", tab: "t1", table: "tb", action: "deleteColumn", col: 2, ifRev: 4 },
      ]),
    );
    expect(table(smaller.doc)).toEqual([
      ["Team", "Owner"],
      ["Platform", "Cai"],
    ]);
  });

  it("guards positions with the revision read: a table changed since is refused, an unchanged one at an older revision goes", () => {
    const doc = sample();
    const op: DocOp = { op: "table", tab: "t1", table: "tb", action: "setCell", row: 1, col: 1, with: { text: "Cai" }, ifRev: 3 };
    expect(applyOps(doc, [{ ...op, ifRev: undefined } as DocOp])).toMatchObject({ ok: false, refused: { code: "missing_guard" } });
    expect(applyOps(doc, [op])).toMatchObject({ ok: false, refused: { code: "guard_mismatch" } });
    // Rev 3 had the same table (only a paragraph changed since): the op goes.
    const then = { ...doc, rev: 3 };
    expect(applyOps(doc, [op], { docAt: (rev) => (rev === 3 ? then : undefined) }).ok).toBe(true);
    const otherTable = ok(applyOps(doc, [{ op: "table", tab: "t1", table: "tb", action: "addRow", with: { text: "x | y" } }])).doc;
    expect(applyOps(doc, [op], { docAt: () => ({ ...otherTable, rev: 3 }) })).toMatchObject({ ok: false, refused: { code: "guard_mismatch" } });
  });

  it("refuses cells past the table and keeps the header row first", () => {
    const doc = sample();
    expect(applyOps(doc, [{ op: "table", tab: "t1", table: "tb", action: "setCell", row: 5, col: 0, with: { text: "x" }, ifRev: 4 }])).toMatchObject({ ok: false, refused: { code: "cell_none" } });
    expect(applyOps(doc, [{ op: "table", tab: "t1", table: "tb", action: "addRow", row: 0, with: { text: "x" }, ifRev: 4 }])).toMatchObject({ ok: false, refused: { code: "bad_op" } });
    expect(applyOps(doc, [{ op: "table", tab: "t1", table: "tb", action: "addRow", with: { text: "a | b | c" } }])).toMatchObject({ ok: false, refused: { code: "bad_op" } });
  });
});

describe("normalising for an edit request", () => {
  it("resolves quotes, markdown, text and table ops to guarded ops by id with blocks, which apply to the same result", () => {
    const doc = sample();
    const ops: DocOp[] = [
      { op: "replace", tab: "t1", target: { quote: "Friday" }, with: { text: "Monday" } },
      { op: "insert", tab: "t1", at: { after: "p2" }, with: { markdown: "- New risk" } },
      { op: "table", tab: "t1", table: "tb", action: "addRow", with: { text: "Comms | Bo" } },
    ];
    const normal = normaliseOps(ops, doc);
    if (!normal.ok) throw new Error(normal.refused.message);
    expect(normal.ops.map((op) => op.op)).toEqual(["replace", "insert", "replace"]);
    for (const op of normal.ops) {
      expect("blocks" in (op as { with: object }).with).toBe(true);
      if (op.op === "replace") expect(op).toMatchObject({ target: { id: expect.any(String) }, ifHash: expect.any(String), ifRev: 4 });
    }
    const direct = ok(applyOps(doc, ops)).doc;
    const approved = ok(applyOps(doc, normal.ops)).doc;
    expect(approved.tabs[0]!.content.map((node) => blockText(node))).toEqual(direct.tabs[0]!.content.map((node) => blockText(node)));
  });

  it("is refused on approval when a block it changes changed since: the request is redone", () => {
    const doc = sample();
    const normal = normaliseOps([{ op: "replace", tab: "t1", target: { quote: "Friday" }, with: { text: "Monday" } }], doc);
    if (!normal.ok) throw new Error();
    const edited = ok(applyOps(doc, [{ op: "replace", tab: "t1", target: { quote: "Ship" }, with: { text: "Release" } }])).doc;
    expect(applyOps({ ...edited, rev: 5 }, normal.ops)).toMatchObject({ ok: false, refused: { code: "guard_mismatch" } });
  });
});

describe("reading", () => {
  it("shows one block in full with its rows, and finds blocks by words", () => {
    const doc = sample();
    const table = blockReading(doc, "tb")!;
    expect(table).toContain("tb ");
    expect(table).toContain("row 1: Platform | Ana");
    expect(blockReading(doc, "nope")).toBeUndefined();
    expect(searchReading(doc, "legal review")).toMatch(/^p2 [0-9a-f]+ paragraph \(tab t1\): Legal review may run long\.$/);
    expect(searchReading(doc, "absent words")).toBe('No block holds "absent words".');
  });
});
