// The document model (an artifact of type "document"): a document is tabs, each a column of blocks, in ProseMirror's
// JSON (what Tiptap's editor.getJSON() gives for one tab, a node of type "doc"). Every block node carries a stable `id`
// and a content hash `h` in its attrs; the document carries a revision `rev` that each save raises. One table (TYPES)
// says what each node and mark is: DOCUMENT_SCHEMA describes it for the editor (a ProseMirror SchemaSpec, plain data),
// and checkDocument holds anything stored or sent to it, rejecting whatever is outside it. The rest are pure helpers the
// tools and the object share: a block's text, finding a block by id or by quoted words, the outline pi reads.

import { canonicalJson } from "./canonical.ts";

/** An attribute's value, as JSON holds it. */
export type DocAttr = string | number | boolean | null | readonly string[] | readonly number[];

/** A mark on a text node: bold, italic, strike, code, or a link (`attrs.href`). */
export interface DocMark {
  type: MarkType;
  attrs?: { href: string };
}

/** A node in ProseMirror's JSON: a block (with `attrs.id` and `attrs.h`), an inline chip, or a text node. */
export interface DocNode {
  type: string;
  attrs?: Record<string, DocAttr>;
  content?: DocNode[];
  marks?: DocMark[];
  text?: string;
}

/** One tab: its blocks are the content of a ProseMirror "doc" node (tabDoc). */
export interface DocTab {
  id: string;
  title: string;
  content: DocNode[];
}

/** A document: its title, its revision (each save raises it by one), and its tabs, at least one. */
export interface DocDocument {
  title: string;
  rev: number;
  tabs: DocTab[];
}

export const MARK_TYPES = ["bold", "italic", "strike", "code", "link"] as const;
export type MarkType = (typeof MARK_TYPES)[number];

/** The largest document, as JSON. */
export const MAX_DOCUMENT_BYTES = 1_000_000;
/** The most tabs in a document. */
export const MAX_TABS = 20;
/** The most nodes in a document, every tab's, blocks, chips and text nodes together. */
export const MAX_NODES = 50_000;
/** How deep nodes nest (a list in a list in a list item...), from a tab's top-level blocks down. */
export const MAX_DEPTH = 12;
/** The longest text node, and the longest code, CSV or formula block. */
export const MAX_TEXT = 50_000;
/** The longest document or tab title. */
export const MAX_TITLE = 200;
/** The longest attribute text (an image's alt, a mention's name, a pending block's intent, a link). */
export const MAX_ATTR_TEXT = 2_000;
/** The longest embed spec (a chart's or diagram's source). */
export const MAX_EMBED_SPEC = 20_000;
/** A dropdown chip's options: at most this many, each at most MAX_OPTION characters. */
export const MAX_OPTIONS = 20;
export const MAX_OPTION = 60;
/** The most cells in a table row. */
export const MAX_COLUMNS = 30;

/** A block's or tab's id: what ops name it by. Stable for as long as the block lives. */
export const BLOCK_ID_PATTERN = /^[A-Za-z0-9_-]{1,40}$/;
/** An image's source: the id of an image stored with the document (the object serves it). */
export const IMAGE_SRC_PATTERN = /^image:[A-Za-z0-9_-]{1,64}$/;
/** The links a document may hold: web and mail addresses, nothing a click would run. */
const LINK_PATTERN = /^(https?:\/\/|mailto:)[^\s]+$/i;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const LANGUAGE_PATTERN = /^[A-Za-z0-9_+#.-]{1,30}$/;

/** A document that does not fit the schema, with where (`path`) and why. */
export class DocumentError extends Error {
  constructor(
    readonly path: string,
    readonly reason: string,
  ) {
    super(`${path}: ${reason}`);
    this.name = "DocumentError";
  }
}

// ---- The schema ----

interface AttrRule {
  /** Absent: the attribute is required. */
  default?: DocAttr;
  /** Whether a value is allowed; `path` for the error. Absent value (undefined) never reaches it. */
  check(value: unknown): string | undefined;
}

interface TypeRule {
  /** ProseMirror's content expression; "" for a leaf (an atom, or a text node). */
  content: string;
  group?: "block" | "inline" | "list";
  inline?: boolean;
  atom?: boolean;
  code?: boolean;
  /** Marks its text may carry: "_" all, "" none. ProseMirror's default (all, for inline content) when absent. */
  marks?: "_" | "";
  defining?: boolean;
  isolating?: boolean;
  attrs: Record<string, AttrRule>;
  /** Further rules on the node as a whole (a table's rows all as wide, a dropdown's value among its options). */
  whole?(node: DocNode): string | undefined;
}

const text = (max: number, pattern?: RegExp, what = "text") => (value: unknown) =>
  typeof value !== "string"
    ? `must be a string`
    : value.length > max
      ? `is longer than ${max} characters`
      : pattern && !pattern.test(value)
        ? `is not a valid ${what}`
        : undefined;

const oneOf =
  (...allowed: DocAttr[]) =>
  (value: unknown) =>
    allowed.includes(value as DocAttr) ? undefined : `must be one of ${allowed.map((one) => JSON.stringify(one)).join(", ")}`;

const optional = (check: (value: unknown) => string | undefined) => (value: unknown) => (value === null ? undefined : check(value));

const validDate = (value: unknown) => {
  const bad = text(10, DATE_PATTERN, "date (YYYY-MM-DD)")(value);
  if (bad) return bad;
  const date = new Date(`${value as string}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value ? undefined : "is not a real date";
};

/** Every block node's: its stable id (required), and its content hash (blockHash; recomputed, never trusted). */
const BLOCK_ATTRS: Record<string, AttrRule> = {
  id: { check: text(40, BLOCK_ID_PATTERN, "block id") },
  h: { default: null, check: optional(text(16, /^[0-9a-f]{1,16}$/, "hash")) },
};
const block = (attrs: Record<string, AttrRule> = {}): Record<string, AttrRule> => ({ ...BLOCK_ATTRS, ...attrs });

/** A table cell's attrs, as Tiptap's table writes them: pipe-style tables have no merged cells. */
const CELL_ATTRS = block({
  colspan: { default: 1, check: oneOf(1) },
  rowspan: { default: 1, check: oneOf(1) },
  colwidth: {
    default: null,
    check: optional((value) =>
      Array.isArray(value) && value.length === 1 && Number.isInteger(value[0]) && value[0] > 0 && value[0] <= 4000 ? undefined : "must be null or [width]",
    ),
  },
});

const TYPES: Record<string, TypeRule> = {
  // A tab's content: ProseMirror's top node.
  doc: { content: "block+", attrs: {} },
  paragraph: { content: "inline*", group: "block", attrs: block() },
  heading: { content: "inline*", group: "block", defining: true, attrs: block({ level: { default: 1, check: oneOf(1, 2, 3) } }) },
  bulletList: { content: "listItem+", group: "list", attrs: block() },
  orderedList: {
    content: "listItem+",
    group: "list",
    attrs: block({ start: { default: 1, check: (value) => (Number.isInteger(value) && (value as number) >= 0 && (value as number) <= 1_000_000 ? undefined : "must be a whole number") } }),
  },
  listItem: { content: "paragraph (paragraph | list)*", defining: true, attrs: block() },
  taskList: { content: "taskItem+", group: "list", attrs: block() },
  taskItem: { content: "paragraph (paragraph | list)*", defining: true, attrs: block({ checked: { default: false, check: oneOf(true, false) } }) },
  table: {
    content: "tableRow+",
    group: "block",
    isolating: true,
    attrs: block(),
    whole: (node) => {
      const widths = new Set((node.content ?? []).map((row) => row.content?.length ?? 0));
      if (widths.size > 1) return "has rows of different widths (a table is a grid: every row has as many cells)";
      return [...widths][0]! > MAX_COLUMNS ? `has more than ${MAX_COLUMNS} columns` : undefined;
    },
  },
  tableRow: { content: "(tableCell | tableHeader)+", attrs: block() },
  tableHeader: { content: "paragraph+", isolating: true, attrs: CELL_ATTRS },
  tableCell: { content: "paragraph+", isolating: true, attrs: CELL_ATTRS },
  codeBlock: {
    content: "text*",
    group: "block",
    code: true,
    marks: "",
    defining: true,
    attrs: block({ language: { default: null, check: optional(text(30, LANGUAGE_PATTERN, "language name")) } }),
  },
  // A CSV block, shown as a grid: its text is the CSV.
  csv: { content: "text*", group: "block", code: true, marks: "", defining: true, attrs: block() },
  // A display formula: its text is the LaTeX source.
  latex: { content: "text*", group: "block", code: true, marks: "", defining: true, attrs: block() },
  image: {
    content: "",
    group: "block",
    atom: true,
    attrs: block({
      src: { check: text(70, IMAGE_SRC_PATTERN, "image source (image:<id>)") },
      alt: { default: "", check: text(MAX_ATTR_TEXT) },
      width: { default: null, check: optional((value) => (Number.isInteger(value) && (value as number) > 0 && (value as number) <= 4000 ? undefined : "must be a width in pixels")) },
    }),
  },
  // A chart (from a table's rows) or a diagram, drawn by the dashboard renderer: `spec` is its source.
  embed: {
    content: "",
    group: "block",
    atom: true,
    attrs: block({
      kind: { check: oneOf("chart", "diagram") },
      spec: { check: text(MAX_EMBED_SPEC) },
      title: { default: "", check: text(MAX_TITLE) },
    }),
  },
  // A placeholder for a section being written (pi plants one per section, then fills them): what will go there.
  pending: { content: "", group: "block", atom: true, attrs: block({ intent: { check: text(MAX_ATTR_TEXT) } }) },
  text: { content: "", group: "inline", inline: true, attrs: {} },
  // A line break inside a block (Shift+Enter), as Tiptap's HardBreak writes it.
  hardBreak: { content: "", group: "inline", inline: true, attrs: {} },
  // A person: their user id and name as written.
  mention: { content: "", group: "inline", inline: true, atom: true, attrs: { uid: { check: text(200) }, name: { check: text(MAX_ATTR_TEXT) } } },
  date: { content: "", group: "inline", inline: true, atom: true, attrs: { value: { check: validDate } } },
  // A pick among options (a status in a table column): `value` is one of them, or none.
  dropdown: {
    content: "",
    group: "inline",
    inline: true,
    atom: true,
    attrs: {
      options: {
        check: (value) =>
          Array.isArray(value) && value.length >= 1 && value.length <= MAX_OPTIONS && value.every((one) => typeof one === "string" && one.length >= 1 && one.length <= MAX_OPTION)
            ? new Set(value).size === value.length
              ? undefined
              : "has the same option twice"
            : `must be 1 to ${MAX_OPTIONS} options of 1 to ${MAX_OPTION} characters`,
      },
      value: { default: null, check: optional(text(MAX_OPTION)) },
    },
    whole: (node) => {
      const value = node.attrs?.value;
      return value == null || (node.attrs?.options as string[]).includes(value as string) ? undefined : "has a value that is none of its options";
    },
  },
};

/** The node types a document may hold. */
export const NODE_TYPES = Object.keys(TYPES);
/** The block node types: every one but the top node, text and the inline chips. Each carries `id` and `h`. */
export const BLOCK_TYPES = NODE_TYPES.filter((type) => type !== "doc" && !TYPES[type]!.inline);
/** The top-level block types: what a tab, or an op's new block, holds. */
export const TOP_BLOCK_TYPES = NODE_TYPES.filter((type) => TYPES[type]!.group === "block" || TYPES[type]!.group === "list");

export function isBlockType(type: string): boolean {
  return BLOCK_TYPES.includes(type);
}

/** What the schema describes of an attribute: its default, when it has one (none: required). */
export interface AttrSpec {
  default?: DocAttr;
}

/** A node as the schema describes it: a ProseMirror NodeSpec without its rendering. */
export interface NodeSpecData {
  content?: string;
  group?: string;
  inline?: boolean;
  atom?: boolean;
  code?: boolean;
  marks?: string;
  defining?: boolean;
  isolating?: boolean;
  attrs?: Record<string, AttrSpec>;
}

/** A mark as the schema describes it: a ProseMirror MarkSpec without its rendering. */
export interface MarkSpecData {
  attrs?: Record<string, AttrSpec>;
  inclusive?: boolean;
  excludes?: string;
}

/**
 * The schema as data, for the editor: a ProseMirror SchemaSpec (nodes in order, the top node first, marks), without
 * toDOM/parseDOM, which the editor adds per node (Tiptap's extensions by the same names, with these attrs and
 * content). What the editor builds from it can hold nothing checkDocument refuses, except ids and sizes: give every
 * block an id (Tiptap's UniqueID on BLOCK_TYPES) and the caps hold on save.
 */
export const DOCUMENT_SCHEMA: { topNode: "doc"; nodes: Record<string, NodeSpecData>; marks: Record<MarkType, MarkSpecData> } = {
  topNode: "doc",
  nodes: Object.fromEntries(
    Object.entries(TYPES).map(([name, rule]): [string, NodeSpecData] => {
      const spec: NodeSpecData = {};
      if (rule.content) spec.content = rule.content;
      if (rule.group) spec.group = rule.group === "list" ? "block list" : rule.group;
      for (const key of ["inline", "atom", "code", "defining", "isolating"] as const) if (rule[key]) spec[key] = true;
      if (rule.marks !== undefined) spec.marks = rule.marks;
      if (Object.keys(rule.attrs).length) spec.attrs = Object.fromEntries(Object.entries(rule.attrs).map(([key, attr]) => [key, "default" in attr ? { default: attr.default } : {}]));
      return [name, spec];
    }),
  ),
  marks: {
    bold: {},
    italic: {},
    strike: {},
    // As Tiptap's code mark: no other mark with it.
    code: { excludes: "_" },
    link: { attrs: { href: {} }, inclusive: false },
  },
};

// ---- Content expressions: the schema's own strings, matched against a node's children ----

interface Term {
  types: ReadonlySet<string>;
  min: number;
  max: number;
}

/** The types a name in a content expression stands for: a node type, or a group's members. */
function typesOf(name: string): string[] {
  if (TYPES[name]) return [name];
  const members = NODE_TYPES.filter((type) => {
    const group = TYPES[type]!.group;
    return group === name || (name === "block" && group === "list");
  });
  if (!members.length) throw new Error(`Unknown name in a content expression: ${name}`);
  return members;
}

/** A content expression of the forms the schema uses: terms of a name or "(a | b)", each with *, + or ? or none. */
function parseContent(expression: string): Term[] {
  const terms: Term[] = [];
  const pattern = /\s*(?:\(([^)]*)\)|([A-Za-z]+))([*+?]?)/y;
  let at = 0;
  while (at < expression.length) {
    pattern.lastIndex = at;
    const found = pattern.exec(expression);
    if (!found) throw new Error(`Bad content expression: ${expression}`);
    at = pattern.lastIndex;
    const names = found[1] !== undefined ? found[1].split("|").map((one) => one.trim()) : [found[2]!];
    const quantifier = found[3];
    terms.push({
      types: new Set(names.flatMap(typesOf)),
      min: quantifier === "*" || quantifier === "?" ? 0 : 1,
      max: quantifier === "*" || quantifier === "+" ? Infinity : 1,
    });
    while (expression[at] === " ") at += 1;
  }
  return terms;
}

const CONTENT = new Map(Object.entries(TYPES).map(([name, rule]) => [name, parseContent(rule.content)]));

/** Why `children` (their types, in order) do not fit `type`'s content expression; undefined when they do. */
function contentMismatch(type: string, children: readonly string[]): string | undefined {
  const terms = CONTENT.get(type)!;
  let at = 0;
  for (const term of terms) {
    let count = 0;
    while (at < children.length && count < term.max && term.types.has(children[at]!)) {
      at += 1;
      count += 1;
    }
    if (count < term.min) {
      return at < children.length
        ? `may not hold ${children[at]} there (content: ${TYPES[type]!.content})`
        : `needs ${[...term.types].join(" or ")} (content: ${TYPES[type]!.content || "none"})`;
    }
  }
  return at < children.length ? `may not hold ${children[at]} there (content: ${TYPES[type]!.content || "none"})` : undefined;
}

// ---- Validation ----

/** What checkDocument may do besides checking. */
export interface CheckOptions {
  /** Give a block without an id a new one (content written by pi, an import), rather than refuse it. */
  assignIds?: boolean;
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/** What a check counts as it goes: nodes, and the ids seen. */
interface Walk {
  nodes: number;
  ids: Set<string>;
  options: CheckOptions;
}

function checkMarks(value: unknown, path: string, allowed: "_" | ""): DocMark[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new DocumentError(path, "must be a list of marks");
  if (value.length && allowed === "") throw new DocumentError(path, "may carry no marks here");
  const seen = new Set<string>();
  const marks = value.map((mark, i): DocMark => {
    const at = `${path}[${i}]`;
    if (!isRecord(mark) || typeof mark.type !== "string" || !(MARK_TYPES as readonly string[]).includes(mark.type)) {
      throw new DocumentError(at, `is not a mark (${MARK_TYPES.join(", ")})`);
    }
    if (seen.has(mark.type)) throw new DocumentError(at, `repeats the ${mark.type} mark`);
    seen.add(mark.type);
    for (const key of Object.keys(mark)) if (key !== "type" && key !== "attrs") throw new DocumentError(`${at}.${key}`, "is not part of a mark");
    if (mark.type !== "link") {
      if (mark.attrs !== undefined && !(isRecord(mark.attrs) && Object.keys(mark.attrs).length === 0)) throw new DocumentError(`${at}.attrs`, `a ${mark.type} mark has none`);
      return { type: mark.type as MarkType };
    }
    if (!isRecord(mark.attrs)) throw new DocumentError(`${at}.attrs`, "a link needs its href");
    for (const key of Object.keys(mark.attrs)) {
      // Tiptap's link writes target, rel and class too: the app sets them itself, so they are left out.
      if (key !== "href" && key !== "target" && key !== "rel" && key !== "class") throw new DocumentError(`${at}.attrs.${key}`, "is not a link attribute");
    }
    const href = mark.attrs.href;
    const bad = text(MAX_ATTR_TEXT, LINK_PATTERN, "link (http, https or mailto)")(href);
    if (bad) throw new DocumentError(`${at}.attrs.href`, bad);
    return { type: "link", attrs: { href: href as string } };
  });
  if (seen.has("code") && seen.size > 1) throw new DocumentError(path, "code takes no other mark with it");
  return marks;
}

function checkNode(value: unknown, path: string, depth: number, walk: Walk, parentMarks: "_" | ""): DocNode {
  if (++walk.nodes > MAX_NODES) throw new DocumentError(path, `the document has more than ${MAX_NODES} nodes`);
  if (depth > MAX_DEPTH) throw new DocumentError(path, `nests deeper than ${MAX_DEPTH}`);
  if (!isRecord(value) || typeof value.type !== "string") throw new DocumentError(path, "is not a node");
  const rule = TYPES[value.type];
  if (!rule || value.type === "doc") throw new DocumentError(path, `"${value.type}" is not a node type a document holds`);
  for (const key of Object.keys(value)) {
    if (!["type", "attrs", "content", "marks", "text"].includes(key)) throw new DocumentError(`${path}.${key}`, "is not part of a node");
  }
  if (value.type === "text") {
    if (value.attrs !== undefined || value.content !== undefined) throw new DocumentError(path, "a text node has no attrs or content");
    if (typeof value.text !== "string" || value.text.length === 0) throw new DocumentError(`${path}.text`, "must be text, not empty");
    if (value.text.length > MAX_TEXT) throw new DocumentError(`${path}.text`, `is longer than ${MAX_TEXT} characters`);
    const marks = checkMarks(value.marks, `${path}.marks`, parentMarks);
    return marks?.length ? { type: "text", text: value.text, marks } : { type: "text", text: value.text };
  }
  if (value.text !== undefined) throw new DocumentError(`${path}.text`, "only a text node has text");
  if (value.marks !== undefined && !(Array.isArray(value.marks) && value.marks.length === 0)) throw new DocumentError(`${path}.marks`, "only text carries marks");

  // Attributes: each known, each valid; defaults filled; a block's id given or assigned, unique; h recomputed later.
  const given = value.attrs === undefined ? {} : value.attrs;
  if (!isRecord(given)) throw new DocumentError(`${path}.attrs`, "must be an object");
  for (const key of Object.keys(given)) if (!(key in rule.attrs)) throw new DocumentError(`${path}.attrs.${key}`, `is not an attribute of ${value.type}`);
  const attrs: Record<string, DocAttr> = {};
  for (const [key, attr] of Object.entries(rule.attrs)) {
    let one = given[key];
    if (key === "id" && (one === undefined || one === null) && walk.options.assignIds) one = newBlockId(walk.ids);
    if (one === undefined) {
      if (!("default" in attr)) throw new DocumentError(`${path}.attrs.${key}`, "is required");
      one = attr.default;
    } else {
      const bad = attr.check(one);
      if (bad) throw new DocumentError(`${path}.attrs.${key}`, bad);
    }
    attrs[key] = Array.isArray(one) ? [...one] : (one as DocAttr);
  }
  if (typeof attrs.id === "string") {
    if (walk.ids.has(attrs.id)) throw new DocumentError(`${path}.attrs.id`, `"${attrs.id}" is used twice`);
    walk.ids.add(attrs.id);
  }

  if (value.content !== undefined && !Array.isArray(value.content)) throw new DocumentError(`${path}.content`, "must be a list of nodes");
  const children = ((value.content as unknown[] | undefined) ?? []).map((child, i) => checkNode(child, `${path}.content[${i}]`, depth + 1, walk, rule.marks ?? "_"));
  const mismatch = contentMismatch(value.type, children.map((child) => child.type));
  if (mismatch) throw new DocumentError(path, `${value.type} ${mismatch}`);
  if (rule.code) {
    const length = children.reduce((sum, child) => sum + (child.text?.length ?? 0), 0);
    if (length > MAX_TEXT) throw new DocumentError(path, `holds more than ${MAX_TEXT} characters`);
  }
  // A node without attributes (a line break) is written without them, as Tiptap does.
  const node: DocNode = Object.keys(attrs).length ? { type: value.type, attrs } : { type: value.type };
  if (children.length) node.content = children;
  const whole = rule.whole?.(node);
  if (whole) throw new DocumentError(path, `${value.type} ${whole}`);
  if (isBlockType(node.type)) node.attrs!.h = blockHash(node);
  return node;
}

/**
 * A document as it may be stored: the same document, with every attribute's default filled and every block's `h`
 * computed afresh (one sent is never trusted). Throws a DocumentError naming the first thing outside the schema or
 * the caps: an unknown node, mark or attribute, content a node may not hold, a block without an id (unless
 * `assignIds`) or with one used twice, a link that is not http(s) or mailto, a document past its size.
 */
export function checkDocument(value: unknown, options: CheckOptions = {}): DocDocument {
  if (!isRecord(value)) throw new DocumentError("document", "must be an object");
  let bytes: number;
  try {
    bytes = JSON.stringify(value).length;
  } catch {
    throw new DocumentError("document", "is not JSON");
  }
  if (bytes > MAX_DOCUMENT_BYTES) throw new DocumentError("document", `is larger than ${MAX_DOCUMENT_BYTES} bytes`);
  for (const key of Object.keys(value)) if (!["title", "rev", "tabs"].includes(key)) throw new DocumentError(`document.${key}`, "is not part of a document");
  const title = text(MAX_TITLE)(value.title);
  if (title) throw new DocumentError("document.title", title);
  if (!Number.isSafeInteger(value.rev) || (value.rev as number) < 0) throw new DocumentError("document.rev", "must be a whole number, 0 or more");
  if (!Array.isArray(value.tabs) || value.tabs.length === 0) throw new DocumentError("document.tabs", "must be a list of at least one tab");
  if (value.tabs.length > MAX_TABS) throw new DocumentError("document.tabs", `may hold at most ${MAX_TABS} tabs`);
  const walk: Walk = { nodes: 0, ids: new Set(), options };
  const tabs = value.tabs.map((tab, i): DocTab => {
    const path = `document.tabs[${i}]`;
    if (!isRecord(tab)) throw new DocumentError(path, "is not a tab");
    for (const key of Object.keys(tab)) if (!["id", "title", "content"].includes(key)) throw new DocumentError(`${path}.${key}`, "is not part of a tab");
    let id = tab.id;
    if ((id === undefined || id === null) && options.assignIds) id = newBlockId(walk.ids);
    const badId = text(40, BLOCK_ID_PATTERN, "tab id")(id);
    if (badId) throw new DocumentError(`${path}.id`, badId);
    if (walk.ids.has(id as string)) throw new DocumentError(`${path}.id`, `"${id as string}" is used twice`);
    walk.ids.add(id as string);
    const badTitle = text(MAX_TITLE)(tab.title);
    if (badTitle) throw new DocumentError(`${path}.title`, badTitle);
    if (!Array.isArray(tab.content)) throw new DocumentError(`${path}.content`, "must be a list of blocks");
    const content = tab.content.map((child, j) => checkNode(child, `${path}.content[${j}]`, 1, walk, "_"));
    const mismatch = contentMismatch("doc", content.map((child) => child.type));
    if (mismatch) throw new DocumentError(path, `a tab ${mismatch}`);
    return { id: id as string, title: tab.title as string, content };
  });
  return { title: value.title as string, rev: value.rev as number, tabs };
}

/**
 * Blocks to put into a document (an op's new content, pi's section): each checked as a top-level block, with ids given
 * where missing, none of them used in `doc` already (a block keeps its id only if it is not taken).
 */
export function checkBlocks(value: unknown, doc: DocDocument, options: CheckOptions = { assignIds: true }): DocNode[] {
  if (!Array.isArray(value) || value.length === 0) throw new DocumentError("blocks", "must be a list of at least one block");
  const walk: Walk = { nodes: countNodes(doc), ids: idsIn(doc), options };
  const blocks = value.map((one, i) => checkNode(one, `blocks[${i}]`, 1, walk, "_"));
  for (const [i, one] of blocks.entries()) if (!TOP_BLOCK_TYPES.includes(one.type)) throw new DocumentError(`blocks[${i}]`, `${one.type} is not a top-level block`);
  return blocks;
}

// ---- Ids and hashes ----

const ID_ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";

/** A new block id, none of `taken`: 10 random characters. */
export function newBlockId(taken: ReadonlySet<string> = new Set()): string {
  for (;;) {
    const bytes = crypto.getRandomValues(new Uint8Array(10));
    const id = `b${[...bytes].map((byte) => ID_ALPHABET[byte % ID_ALPHABET.length]).join("")}`;
    if (!taken.has(id)) return id;
  }
}

/** A node as its hash reads it: without any block's id or hash, at any depth. */
function hashable(node: DocNode): unknown {
  const { attrs, content, ...rest } = node;
  const kept: Record<string, unknown> = { ...rest };
  if (attrs) {
    const { id: _id, h: _h, ...others } = attrs;
    if (Object.keys(others).length) kept.attrs = others;
  }
  if (content) kept.content = content.map(hashable);
  return kept;
}

/** cyrb53: a fast 53-bit string hash, the same in the Worker, the browser and Node. Not for secrets. */
function cyrb53(input: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < input.length; i++) {
    const ch = input.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16).padStart(14, "0");
}

/**
 * A block's content hash: of its type, attributes, marks and text, its children's too, but no block's id or hash, so
 * the same content hashes the same wherever it is. What an op's `ifHash` names: the block as it was read.
 */
export function blockHash(node: DocNode): string {
  return cyrb53(canonicalJson(hashable(node)));
}

/** Every id in a document: its tabs' and its blocks'. */
export function idsIn(doc: DocDocument): Set<string> {
  const ids = new Set<string>();
  for (const tab of doc.tabs) {
    ids.add(tab.id);
    for (const node of tab.content) eachBlock(node, (one) => typeof one.attrs?.id === "string" && ids.add(one.attrs.id));
  }
  return ids;
}

function countNodes(doc: DocDocument): number {
  let count = 0;
  const visit = (node: DocNode) => {
    count += 1;
    node.content?.forEach(visit);
  };
  for (const tab of doc.tabs) tab.content.forEach(visit);
  return count;
}

/** `visit` on a block and every block under it, depth first, parents before children. */
function eachBlock(node: DocNode, visit: (node: DocNode, parent: DocNode | undefined, index: number) => void, parent?: DocNode, index = 0): void {
  if (!isBlockType(node.type)) return;
  visit(node, parent, index);
  node.content?.forEach((child, i) => eachBlock(child, visit, node, i));
}

/** A tab as the editor takes it: a ProseMirror "doc" node holding its blocks. */
export function tabDoc(tab: DocTab): DocNode {
  return { type: "doc", content: tab.content };
}

/** A new document: one tab with one empty paragraph, at revision 0. */
export function emptyDocument(title: string, tabTitle = "Tab 1"): DocDocument {
  const ids = new Set<string>();
  const tab = newBlockId(ids);
  ids.add(tab);
  const paragraph: DocNode = { type: "paragraph", attrs: { id: newBlockId(ids), h: null } };
  paragraph.attrs!.h = blockHash(paragraph);
  return { title, rev: 0, tabs: [{ id: tab, title: tabTitle, content: [paragraph] }] };
}

// ---- Text, finding, the outline ----

/** The text an inline node shows: a text node's text, a line break as one, a mention's @name, a date, a dropdown's value. */
function inlineText(node: DocNode): string {
  if (node.type === "text") return node.text ?? "";
  if (node.type === "hardBreak") return "\n";
  if (node.type === "mention") return `@${String(node.attrs?.name ?? "")}`;
  if (node.type === "date") return String(node.attrs?.value ?? "");
  if (node.type === "dropdown") return node.attrs?.value == null ? "" : String(node.attrs.value);
  return "";
}

/**
 * The plain text of a block: its inline content as shown (chips as their words), its children's text one per line, a
 * table's rows one per line with their cells between " | ", an image's alt, an embed's title, a pending block's intent.
 */
export function blockText(node: DocNode): string {
  if (node.type === "image") return String(node.attrs?.alt ?? "");
  if (node.type === "embed") return String(node.attrs?.title ?? "");
  if (node.type === "pending") return String(node.attrs?.intent ?? "");
  const children = node.content ?? [];
  if (!children.length) return "";
  if (!isBlockType(children[0]!.type)) return children.map(inlineText).join("");
  const separator = node.type === "tableRow" ? " | " : "\n";
  return children.map(blockText).join(separator);
}

/** Where a block is: its tab, the node, its parent block (none for a tab's top level), and its index there. */
export interface FoundBlock {
  tabId: string;
  node: DocNode;
  parent?: DocNode;
  index: number;
  /** The id of the tab's top-level block it is in (its own id for a top-level block). */
  topId: string;
}

/** The block (at any depth, in any tab) with id `id`; undefined for none. */
export function findBlock(doc: DocDocument, id: string): FoundBlock | undefined {
  for (const tab of doc.tabs) {
    for (const [index, top] of tab.content.entries()) {
      let found: FoundBlock | undefined;
      eachBlock(top, (node, parent, at) => {
        if (!found && node.attrs?.id === id) found = { tabId: tab.id, node, ...(parent && { parent }), index: parent ? at : index, topId: String(top.attrs?.id) };
      });
      if (found) return found;
    }
  }
  return undefined;
}

/** Text as finding compares it: whitespace runs as one space, trimmed, lowercased; quotes and dashes as plain ones. */
export function normaliseQuote(value: string): string {
  return value
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[–—]/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

/** A block whose text holds quoted words (findByQuote). */
export interface QuoteMatch {
  tabId: string;
  id: string;
  type: string;
  topId: string;
}

/**
 * The blocks whose text holds `quote` (normaliseQuote on both sides): the innermost ones only, the paragraph rather
 * than the list item around it, in document order. More than one means the quote is ambiguous: an op asks for more words.
 */
export function findByQuote(doc: DocDocument, quote: string): QuoteMatch[] {
  const wanted = normaliseQuote(quote);
  if (!wanted) return [];
  const matches: QuoteMatch[] = [];
  for (const tab of doc.tabs) {
    for (const top of tab.content) {
      eachBlock(top, (node) => {
        if (!normaliseQuote(blockText(node)).includes(wanted)) return;
        // Innermost: none of its child blocks holds the whole quote.
        const inner = (node.content ?? []).some((child) => isBlockType(child.type) && normaliseQuote(blockText(child)).includes(wanted));
        if (!inner) matches.push({ tabId: tab.id, id: String(node.attrs?.id), type: node.type, topId: String(top.attrs?.id) });
      });
    }
  }
  return matches;
}

/** The most of a block's text an outline line shows. */
export const OUTLINE_TEXT = 80;

/** One top-level block as the outline shows it. */
export interface OutlineBlock {
  id: string;
  type: string;
  h: string;
  /** A heading's level. */
  level?: number;
  /** The start of its text, at most OUTLINE_TEXT characters (with "…" when cut). */
  text: string;
  /** For a list, its items; for a table, its rows. */
  items?: number;
}

/** A document's outline: per tab, its top-level blocks with their ids, hashes and short text (what pi reads first). */
export interface DocOutline {
  title: string;
  rev: number;
  tabs: { id: string; title: string; blocks: OutlineBlock[] }[];
}

function short(value: string): string {
  const flat = value.replace(/\s+/g, " ").trim();
  return flat.length > OUTLINE_TEXT ? `${flat.slice(0, OUTLINE_TEXT - 1)}…` : flat;
}

export function outline(doc: DocDocument): DocOutline {
  return {
    title: doc.title,
    rev: doc.rev,
    tabs: doc.tabs.map((tab) => ({
      id: tab.id,
      title: tab.title,
      blocks: tab.content.map((node): OutlineBlock => {
        const line: OutlineBlock = { id: String(node.attrs?.id), type: node.type, h: String(node.attrs?.h ?? blockHash(node)), text: short(blockText(node)) };
        if (node.type === "heading") line.level = Number(node.attrs?.level);
        if (node.type === "table" || TYPES[node.type]?.group === "list") line.items = node.content?.length ?? 0;
        return line;
      }),
    })),
  };
}

/** The outline as lines of text, for a model: a tab per header, then "id h type: text" per block. */
export function outlineText(doc: DocDocument): string {
  const view = outline(doc);
  const lines = [`# ${view.title} (rev ${view.rev})`];
  for (const tab of view.tabs) {
    if (view.tabs.length > 1) lines.push(`## Tab ${tab.id}: ${tab.title}`);
    for (const one of tab.blocks) {
      const kind = one.level ? `${one.type} ${one.level}` : one.items !== undefined ? `${one.type} (${one.items})` : one.type;
      lines.push(`${one.id} ${one.h} ${kind}${one.text ? `: ${one.text}` : ""}`);
    }
  }
  return lines.join("\n");
}
