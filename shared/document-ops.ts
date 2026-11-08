// The edit protocol for documents (shared/document.ts), one engine for pi, the agents, the editor's suggestions and edit
// requests: ops that replace, insert and delete blocks (by id, or by quoted words), and table rows, columns and cells.
// Content comes as blocks, as Markdown (whole blocks, shared/document-markdown.ts) or as text (words reworded in place,
// keeping the chips and marks around them). Guards keep an op from writing over what someone changed since it was
// read: a whole-block replace or delete carries the block's hash (`ifHash`) and the revision read (`ifRev`). Ops apply
// all or none: a refused op changes nothing and says what stands now. An edit request is stored normalised
// (normaliseOps): every op by id, its content as blocks, guarded, so its owner approves exactly what they see.

import {
  blockHash,
  blockText,
  checkDocument,
  DocumentError,
  findBlock,
  isBlockType,
  MAX_COLUMNS,
  newBlockId,
  normaliseQuote,
  type DocDocument,
  type DocNode,
  type DocTab,
} from "./document.ts";
import { blockMarkdown, MarkdownError, markdownBlocks, markdownInline, type ChipSpec } from "./document-markdown.ts";

export type { ChipSpec } from "./document-markdown.ts";

/** A block by its id, or the words it holds (`nth`: which of several places those words stand, from 1). */
export type Target = { id: string } | { quote: string; nth?: number };

/**
 * What an op writes: blocks as they are, Markdown (`chips`: the chips and pending placeholders its `<?claude block
 * <key>?>` tokens stand for), or plain text (words reworded in place).
 */
export type Content = { blocks: DocNode[] } | { markdown: string; chips?: Record<string, ChipSpec> } | { text: string };

export type TableAction = "addRow" | "addColumn" | "deleteRow" | "deleteColumn" | "setCell";

/** One edit of a document's tab (the lead's contract: DOCS-BRIEF "Ops type"). */
export type DocOp =
  | { op: "replace"; tab: string; target: Target; with: Content; ifHash?: string; ifRev?: number }
  | { op: "insert"; tab: string; at: { after: string } | { before: string } | { end: true } | { endOfSection: string }; with: Content }
  | { op: "delete"; tab: string; target: { id: string }; ifHash: string; ifRev: number }
  | { op: "table"; tab: string; table: string; action: TableAction; row?: number; col?: number; with?: Content; ifRev?: number };

/** The most ops one call or request holds. */
export const MAX_OPS = 50;

/** Why an op was refused: a code a model acts on, what to do, and what stands now. Nothing was changed. */
export interface Refusal {
  /** The op's place in the list (0 first). */
  index: number;
  code:
    | "bad_op"
    | "no_tab"
    | "no_block"
    | "not_in_tab"
    | "find_none"
    | "find_many"
    | "missing_guard"
    | "guard_mismatch"
    | "chip_in_change"
    | "not_inline"
    | "last_block"
    | "use_table_op"
    | "cell_none"
    | "invalid";
  message: string;
  /** The document's revision as it stands. */
  rev: number;
  /** The block the op was about, as it stands now (its id, hash and text), when there is one. */
  now?: { id: string; h: string; text: string };
}

export type ApplyResult =
  | {
      ok: true;
      /** The document with the ops applied, checked against the schema and hashed; its `rev` as given (the store raises it). */
      doc: DocDocument;
      /** The top-level blocks the ops wrote or removed, by id (removed ones too). */
      changed: string[];
      /** The pending placeholders the ops filled. */
      filled: string[];
      /** The same edit as ops by id with blocks and guards (what an edit request stores): normaliseOps. */
      normalised: DocOp[];
    }
  | { ok: false; refused: Refusal };

/** Where to look up what the document was at an earlier revision: a table op's guard compares its table then and now. */
export interface ApplyOptions {
  docAt?: (rev: number) => DocDocument | undefined;
}

class Refused extends Error {
  constructor(
    readonly code: Refusal["code"],
    message: string,
    readonly now?: DocNode,
  ) {
    super(message);
  }
}

const clone = <T>(value: T): T => structuredClone(value);
const idOf = (node: DocNode): string => String(node.attrs?.id ?? "");
const hOf = (node: DocNode): string => String(node.attrs?.h ?? blockHash(node));
const nowOf = (node: DocNode) => ({ id: idOf(node), h: hOf(node), text: blockText(node).slice(0, 300) });

/** Blocks with any id `taken` (one the document holds already) left out, so the check gives them new ones. */
function withoutTaken(nodes: readonly DocNode[], taken: ReadonlySet<string>): DocNode[] {
  return nodes.map((node) => {
    if (!isBlockType(node.type)) return node;
    const out: DocNode = { ...node };
    if (node.attrs && typeof node.attrs.id === "string" && taken.has(node.attrs.id)) {
      const { id: _id, ...kept } = node.attrs;
      out.attrs = kept;
    }
    if (node.content) out.content = withoutTaken(node.content, taken);
    return out;
  });
}

/** Give every block of `doc` without an id a new one, none it holds already: in place. */
function giveIds(doc: DocDocument): void {
  const taken = blockIds(doc);
  const visit = (node: DocNode) => {
    if (!isBlockType(node.type)) return;
    if (typeof node.attrs?.id !== "string") {
      const id = newBlockId(taken);
      taken.add(id);
      node.attrs = { ...node.attrs, id };
    }
    node.content?.forEach(visit);
  };
  for (const tab of doc.tabs) tab.content.forEach(visit);
}

/** Every block id of a document. */
function blockIds(doc: DocDocument): Set<string> {
  const ids = new Set<string>();
  const visit = (node: DocNode) => {
    if (!isBlockType(node.type)) return;
    if (typeof node.attrs?.id === "string") ids.add(node.attrs.id);
    node.content?.forEach(visit);
  };
  for (const tab of doc.tabs) {
    ids.add(tab.id);
    tab.content.forEach(visit);
  }
  return ids;
}

// ---- Reading ops as sent ----

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const isId = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9_-]{1,40}$/.test(value);

function checkTarget(value: unknown, where: string): Target {
  if (!isRecord(value)) throw new Error(`${where} must be {id} or {quote, nth?}`);
  if ("id" in value) {
    if (!isId(value.id)) throw new Error(`${where}.id must be a block id`);
    return { id: value.id };
  }
  if (typeof value.quote !== "string" || !value.quote.trim() || value.quote.length > 2_000) throw new Error(`${where}.quote must be the words to find (up to 2,000 characters)`);
  if (value.nth !== undefined && !(Number.isInteger(value.nth) && (value.nth as number) >= 1)) throw new Error(`${where}.nth counts from 1`);
  return { quote: value.quote, ...(value.nth !== undefined && { nth: value.nth as number }) };
}

function checkContent(value: unknown, where: string): Content {
  if (!isRecord(value)) throw new Error(`${where} must be {markdown}, {text} or {blocks}`);
  if (typeof value.markdown === "string") {
    if (value.chips !== undefined && !isRecord(value.chips)) throw new Error(`${where}.chips must be an object of chips by key`);
    return { markdown: value.markdown, ...(value.chips !== undefined && { chips: value.chips as Record<string, ChipSpec> }) };
  }
  if (typeof value.text === "string") return { text: value.text };
  if (Array.isArray(value.blocks)) return { blocks: value.blocks as DocNode[] };
  throw new Error(`${where} must be {markdown}, {text} or {blocks}`);
}

const guard = (value: Record<string, unknown>, where: string) => {
  if (value.ifHash !== undefined && (typeof value.ifHash !== "string" || !/^[0-9a-f]{1,16}$/.test(value.ifHash))) throw new Error(`${where}.ifHash must be a block's h`);
  if (value.ifRev !== undefined && !(Number.isSafeInteger(value.ifRev) && (value.ifRev as number) >= 0)) throw new Error(`${where}.ifRev must be a revision`);
};

/** Ops as sent (by a tool, the editor, a request), checked for shape; throws an Error saying what is wrong. */
export function checkOps(value: unknown): DocOp[] {
  if (!Array.isArray(value) || value.length === 0) throw new Error("ops must be a list of at least one op");
  if (value.length > MAX_OPS) throw new Error(`at most ${MAX_OPS} ops at once`);
  return value.map((op, i): DocOp => {
    const where = `ops[${i}]`;
    if (!isRecord(op)) throw new Error(`${where} must be an op`);
    if (!isId(op.tab)) throw new Error(`${where}.tab must be the tab's id`);
    guard(op, where);
    const ifs = { ...(op.ifHash !== undefined && { ifHash: op.ifHash as string }), ...(op.ifRev !== undefined && { ifRev: op.ifRev as number }) };
    if (op.op === "replace") return { op: "replace", tab: op.tab, target: checkTarget(op.target, `${where}.target`), with: checkContent(op.with, `${where}.with`), ...ifs };
    if (op.op === "insert") {
      const at = op.at;
      if (!isRecord(at)) throw new Error(`${where}.at must be {after}, {before}, {end: true} or {endOfSection}`);
      const place =
        "after" in at && isId(at.after)
          ? { after: at.after }
          : "before" in at && isId(at.before)
            ? { before: at.before }
            : at.end === true
              ? { end: true as const }
              : "endOfSection" in at && isId(at.endOfSection)
                ? { endOfSection: at.endOfSection }
                : undefined;
      if (!place) throw new Error(`${where}.at must be {after: id}, {before: id}, {end: true} or {endOfSection: heading id}`);
      return { op: "insert", tab: op.tab, at: place, with: checkContent(op.with, `${where}.with`) };
    }
    if (op.op === "delete") {
      const target = checkTarget(op.target, `${where}.target`);
      if (!("id" in target)) throw new Error(`${where}: delete takes a block by id (to take words out, replace them)`);
      return { op: "delete", tab: op.tab, target, ifHash: op.ifHash as string, ifRev: op.ifRev as number };
    }
    if (op.op === "table") {
      const actions: TableAction[] = ["addRow", "addColumn", "deleteRow", "deleteColumn", "setCell"];
      if (!actions.includes(op.action as TableAction)) throw new Error(`${where}.action must be one of ${actions.join(", ")}`);
      if (!isId(op.table)) throw new Error(`${where}.table must be the table's id`);
      for (const key of ["row", "col"] as const) if (op[key] !== undefined && !Number.isInteger(op[key])) throw new Error(`${where}.${key} must be a whole number (0 first, -1 last)`);
      return {
        op: "table",
        tab: op.tab,
        table: op.table,
        action: op.action as TableAction,
        ...(op.row !== undefined && { row: op.row as number }),
        ...(op.col !== undefined && { col: op.col as number }),
        ...(op.with !== undefined && { with: checkContent(op.with, `${where}.with`) }),
        ...(op.ifRev !== undefined && { ifRev: op.ifRev as number }),
      };
    }
    throw new Error(`${where}.op must be replace, insert, delete or table`);
  });
}

// ---- Content to nodes ----

/**
 * Content as blocks, without ids unless given: given blocks keep theirs, but for ids the document holds already (except
 * `keep`, the block being replaced), which the check renews.
 */
function contentBlocks(content: Content, doc?: DocDocument, keep?: string): DocNode[] {
  try {
    if ("blocks" in content) {
      if (!Array.isArray(content.blocks)) throw new Refused("bad_op", "blocks must be a list of blocks.");
      if (!doc) return clone(content.blocks);
      const taken = blockIds(doc);
      if (keep) taken.delete(keep);
      return withoutTaken(clone(content.blocks), taken);
    }
    if ("markdown" in content) return markdownBlocks(content.markdown, content.chips ?? {});
    return content.text ? [{ type: "paragraph", content: [{ type: "text", text: content.text }] }] : [{ type: "paragraph" }];
  } catch (error) {
    if (error instanceof Refused) throw error;
    throw new Refused("bad_op", error instanceof MarkdownError ? error.message : `the content could not be read: ${String(error)}`);
  }
}

/** Content as inline nodes, for words replaced in place; undefined when it is more than one paragraph's words. */
function contentInline(content: Content): DocNode[] | undefined {
  try {
    if ("text" in content) return content.text ? [{ type: "text", text: content.text }] : [];
    if ("markdown" in content) return markdownInline(content.markdown, content.chips ?? {});
  } catch (error) {
    throw new Refused("bad_op", error instanceof MarkdownError ? error.message : `the content could not be read: ${String(error)}`);
  }
  const blocks = content.blocks;
  return blocks.length === 1 && blocks[0]!.type === "paragraph" ? (blocks[0]!.content ?? []) : undefined;
}

// ---- Inline text as characters: what a reword and a quote work on ----

/** One shown character of a block's inline content: of text node `node` at `offset`, or a chip's word (`chip`). */
interface Char {
  ch: string;
  node: number;
  offset: number;
  chip: boolean;
}

function charsOf(content: readonly DocNode[]): Char[] {
  const chars: Char[] = [];
  content.forEach((node, index) => {
    if (node.type === "text") [...(node.text ?? "")].forEach((ch, offset) => chars.push({ ch, node: index, offset, chip: false }));
    else [...blockText({ type: "paragraph", content: [node] })].forEach((ch) => chars.push({ ch, node: index, offset: 0, chip: true }));
  });
  return chars;
}

/** The inline nodes of `content` from shown character `from` to `to` (not including it), cut at text boundaries. */
function sliceInline(content: readonly DocNode[], chars: readonly Char[], from: number, to: number): DocNode[] {
  const out: DocNode[] = [];
  let i = from;
  while (i < to) {
    const c = chars[i]!;
    const node = content[c.node]!;
    if (c.chip) {
      out.push(node);
      while (i < to && chars[i]!.node === c.node) i += 1;
      continue;
    }
    let j = i;
    while (j < to && chars[j]!.node === c.node) j += 1;
    const text = chars.slice(i, j).map((one) => one.ch).join("");
    out.push({ ...node, text });
    i = j;
  }
  return out;
}

/** The marks the character before position `at` carries (else the one at it): what words typed there take. */
function marksAt(content: readonly DocNode[], chars: readonly Char[], at: number): DocNode["marks"] {
  const near = chars[at - 1] ?? chars[at];
  if (!near || near.chip) return undefined;
  return content[near.node]!.marks;
}

function withMarks(nodes: readonly DocNode[], marks: DocNode["marks"]): DocNode[] {
  if (!marks?.length) return [...nodes];
  return nodes.map((node) => (node.type === "text" && !node.marks?.length ? { ...node, marks: clone(marks) } : node));
}

/** Inline nodes with empty text dropped and neighbours of the same marks joined. */
function tidyInline(nodes: readonly DocNode[]): DocNode[] {
  const out: DocNode[] = [];
  for (const node of nodes) {
    if (node.type === "text" && !node.text) continue;
    const last = out.at(-1);
    if (node.type === "text" && last?.type === "text" && JSON.stringify(last.marks ?? []) === JSON.stringify(node.marks ?? [])) out[out.length - 1] = { ...last, text: `${last.text}${node.text}` };
    else out.push(node);
  }
  return out;
}

/** `content` with shown characters [from, to) put in place of `inserted`; refused when a chip is among them. */
function spliceInline(content: readonly DocNode[], chars: readonly Char[], from: number, to: number, inserted: readonly DocNode[]): DocNode[] {
  if (chars.slice(from, to).some((one) => one.chip)) {
    throw new Refused("chip_in_change", "A chip (a mention, a date or a dropdown) is among the words this changes: change the words around it, or replace the whole block as Markdown with the chip in its map.");
  }
  return tidyInline([...sliceInline(content, chars, 0, from), ...withMarks(inserted, marksAt(content, chars, from)), ...sliceInline(content, chars, to, chars.length)]);
}

/** The blocks whose text is inline (a paragraph, a heading, a code, CSV or formula block). */
const INLINE_HOLDERS = new Set(["paragraph", "heading", "codeBlock", "csv", "latex"]);

/**
 * A block's words reworded to `text`, keeping what did not change: the words common to the start and the end stay as
 * they were (marks, chips), only those between take the new text, with the marks of the word before them.
 */
function reword(node: DocNode, text: string): DocNode {
  if (!INLINE_HOLDERS.has(node.type)) throw new Refused("not_inline", `A ${node.type} has no words of its own to reword: replace it as Markdown, or reword one of its paragraphs.`, node);
  const content = node.content ?? [];
  const chars = charsOf(content);
  const old = chars.map((one) => one.ch);
  const next = [...text];
  let start = 0;
  while (start < old.length && start < next.length && old[start] === next[start]) start += 1;
  let end = 0;
  while (end < old.length - start && end < next.length - start && old[old.length - 1 - end] === next[next.length - 1 - end]) end += 1;
  // A chip's words are whole: the change grows to cover any chip it cuts into, which then refuses it.
  const inserted = next.slice(start, next.length - end).join("");
  const kept = spliceInline(content, chars, start, old.length - end, inserted ? [{ type: "text", text: inserted }] : []);
  const out: DocNode = { ...node };
  if (kept.length) out.content = kept;
  else delete out.content;
  return out;
}

/** Shown characters normalised as findByQuote compares them, with where each came from in `chars`. */
function normalisedChars(chars: readonly Char[]): { text: string; from: number[] } {
  let text = "";
  const from: number[] = [];
  let space = false;
  chars.forEach((one, i) => {
    if (/\s/.test(one.ch)) {
      if (!space && text) {
        text += " ";
        from.push(i);
      }
      space = true;
      return;
    }
    space = false;
    const ch = normaliseQuote(one.ch) || one.ch.toLowerCase();
    for (const part of ch) {
      text += part;
      from.push(i);
    }
  });
  return { text, from };
}

/** Where quoted words stand: each block holding them, with the shown characters each time they occur. */
function occurrences(tab: DocTab, quote: string): { node: DocNode; from: number; to: number }[] {
  const wanted = normaliseQuote(quote);
  const found: { node: DocNode; from: number; to: number }[] = [];
  const visit = (node: DocNode) => {
    if (!isBlockType(node.type)) return;
    if (INLINE_HOLDERS.has(node.type)) {
      const chars = charsOf(node.content ?? []);
      const { text, from } = normalisedChars(chars);
      for (let at = text.indexOf(wanted); at !== -1 && wanted; at = text.indexOf(wanted, at + 1)) {
        found.push({ node, from: from[at]!, to: from[at + wanted.length - 1]! + 1 });
      }
      return;
    }
    node.content?.forEach(visit);
  };
  tab.content.forEach(visit);
  return found;
}

// ---- Places in a tab ----

/** Where a block is: the list its parent keeps it in, and its index there. */
interface Place {
  siblings: DocNode[];
  index: number;
  node: DocNode;
  parent?: DocNode;
}

function placeOf(tab: DocTab, id: string, doc: DocDocument): Place {
  const found = findBlock(doc, id);
  if (!found) throw new Refused("no_block", `No block "${id}" in the document (now): read its outline again.`);
  if (found.tabId !== tab.id) throw new Refused("not_in_tab", `Block "${id}" is in tab "${found.tabId}", not "${tab.id}".`, found.node);
  const siblings = found.parent ? found.parent.content! : tab.content;
  return { siblings, index: found.index, node: found.node, ...(found.parent && { parent: found.parent }) };
}

const TABLE_PARTS = new Set(["tableRow", "tableCell", "tableHeader"]);
const LISTS = new Set(["bulletList", "orderedList", "taskList"]);

/** New blocks as they go into `parent` (none: a tab): a list's items when the parent is a list and they are one list. */
function forParent(blocks: DocNode[], parent: DocNode | undefined): DocNode[] {
  if (parent && LISTS.has(parent.type) && blocks.length === 1 && LISTS.has(blocks[0]!.type)) return blocks[0]!.content ?? [];
  return blocks;
}

/** A whole-block replace or delete needs both guards (a pending placeholder needs none); a stale one is refused. */
function checkGuard(node: DocNode, op: { ifHash?: string; ifRev?: number }, rev: number): void {
  if (node.type === "pending") return;
  if (op.ifHash === undefined || op.ifRev === undefined) {
    throw new Refused("missing_guard", `A whole-block change needs ifHash (the block's h) and ifRev (the revision you read it at): block "${idOf(node)}" is h ${hOf(node)} at rev ${rev}.`, node);
  }
  if (op.ifRev > rev) throw new Refused("guard_mismatch", `ifRev ${op.ifRev} is past the document's revision (${rev}).`, node);
  if (op.ifHash !== hOf(node)) {
    throw new Refused("guard_mismatch", `Block "${idOf(node)}" changed since you read it (h ${op.ifHash} then, ${hOf(node)} now, at rev ${rev}): their edit stands; work from what it says now.`, node);
  }
}

// ---- The ops ----

/** What one op did, for the result: top-level ids written, placeholders filled, and the op as normalised. */
interface Done {
  touched: string[];
  filled: string[];
  normalised: DocOp;
}

function topIdOf(doc: DocDocument, id: string): string | undefined {
  return findBlock(doc, id)?.topId;
}

function replaceOp(doc: DocDocument, tab: DocTab, op: Extract<DocOp, { op: "replace" }>, rev: number): Done {
  if ("quote" in op.target) {
    const all = occurrences(tab, op.target.quote);
    if (!all.length) throw new Refused("find_none", `"${op.target.quote}" is not in tab "${tab.id}" (now): read the block again and quote it as it stands.`);
    const nth = op.target.nth ?? 1;
    if (op.target.nth === undefined && all.length > 1) throw new Refused("find_many", `"${op.target.quote}" stands in ${all.length} places: quote more words, or give nth (1 to ${all.length}).`);
    const hit = all[nth - 1];
    if (!hit) throw new Refused("find_none", `"${op.target.quote}" stands in ${all.length} place(s), not ${nth}.`);
    const inserted = contentInline(op.with);
    if (!inserted) throw new Refused("bad_op", "Quoted words are replaced by words (text, or Markdown of one paragraph): to replace whole blocks, target the block by id.");
    const before = clone(hit.node);
    const chars = charsOf(hit.node.content ?? []);
    const content = spliceInline(hit.node.content ?? [], chars, hit.from, hit.to, inserted);
    if (content.length) hit.node.content = content;
    else delete hit.node.content;
    const id = idOf(hit.node);
    return { touched: [topIdOf(doc, id) ?? id], filled: [], normalised: { op: "replace", tab: tab.id, target: { id }, with: { blocks: [hit.node] }, ifHash: hOf(before), ifRev: rev } };
  }
  const place = placeOf(tab, op.target.id, doc);
  const { node } = place;
  if (TABLE_PARTS.has(node.type)) throw new Refused("use_table_op", `"${op.target.id}" is part of a table: change it with a table op (setCell, addRow...).`, node);
  checkGuard(node, op, rev);
  const top = topIdOf(doc, op.target.id) ?? op.target.id;
  let replacement: DocNode[];
  if ("text" in op.with) replacement = [reword(node, op.with.text)];
  else {
    replacement = forParent(contentBlocks(op.with, doc, idOf(node)), place.parent);
    if (!replacement.length) throw new Refused("bad_op", "The content holds no blocks: to remove the block, delete it.");
    // The first new block keeps the old one's id when it is the same kind of block (comments stay on it); a filled
    // placeholder's id retires.
    const first = replacement[0]!;
    if (node.type !== "pending" && first.type === node.type && !("blocks" in op.with)) first.attrs = { ...first.attrs, id: idOf(node) };
  }
  place.siblings.splice(place.index, 1, ...replacement);
  return {
    touched: [top],
    filled: node.type === "pending" ? [idOf(node)] : [],
    normalised: { op: "replace", tab: tab.id, target: { id: idOf(node) }, with: { blocks: replacement }, ...(node.type !== "pending" && { ifHash: hOf(node), ifRev: rev }) },
  };
}

function insertOp(doc: DocDocument, tab: DocTab, op: Extract<DocOp, { op: "insert" }>): Done {
  const blocks = contentBlocks(op.with, doc);
  if (!blocks.length) throw new Refused("bad_op", "The content holds no blocks to insert.");
  const at = op.at;
  if ("end" in at) {
    tab.content.push(...blocks);
    return { touched: [], filled: [], normalised: { op: "insert", tab: tab.id, at, with: { blocks } } };
  }
  if ("endOfSection" in at) {
    const place = placeOf(tab, at.endOfSection, doc);
    if (place.parent || place.node.type !== "heading") throw new Refused("bad_op", `endOfSection names a heading of the tab: "${at.endOfSection}" is a ${place.node.type}.`, place.node);
    const level = Number(place.node.attrs?.level ?? 1);
    let index = place.index + 1;
    while (index < tab.content.length && !(tab.content[index]!.type === "heading" && Number(tab.content[index]!.attrs?.level ?? 1) <= level)) index += 1;
    tab.content.splice(index, 0, ...blocks);
    return { touched: [], filled: [], normalised: { op: "insert", tab: tab.id, at, with: { blocks } } };
  }
  const anchor = "after" in at ? at.after : at.before;
  const place = placeOf(tab, anchor, doc);
  if (TABLE_PARTS.has(place.node.type)) throw new Refused("use_table_op", `"${anchor}" is part of a table: add rows or columns with a table op.`, place.node);
  const inserted = forParent(blocks, place.parent);
  place.siblings.splice("after" in at ? place.index + 1 : place.index, 0, ...inserted);
  return { touched: place.parent ? [topIdOf(doc, anchor) ?? anchor] : [], filled: [], normalised: { op: "insert", tab: tab.id, at, with: { blocks: inserted } } };
}

function deleteOp(doc: DocDocument, tab: DocTab, op: Extract<DocOp, { op: "delete" }>, rev: number): Done {
  const place = placeOf(tab, op.target.id, doc);
  if (TABLE_PARTS.has(place.node.type)) throw new Refused("use_table_op", `"${op.target.id}" is part of a table: delete rows or columns with a table op, or the whole table by its id.`, place.node);
  checkGuard(place.node, op, rev);
  if (!place.parent && tab.content.length === 1) throw new Refused("last_block", "A tab keeps one block: replace it (with an empty paragraph to clear the tab) rather than delete it.", place.node);
  if (place.parent && place.siblings.length === 1) {
    throw new Refused("bad_op", `"${op.target.id}" is the only one in its ${place.parent.type}: delete the ${place.parent.type} ("${idOf(place.parent)}") instead.`, place.node);
  }
  const top = topIdOf(doc, op.target.id) ?? op.target.id;
  place.siblings.splice(place.index, 1);
  return { touched: [top], filled: place.node.type === "pending" ? [op.target.id] : [], normalised: { ...op } };
}

/** A cell's paragraphs from content: words, or Markdown/blocks of paragraphs only. */
function cellParagraphs(content: Content | undefined): DocNode[] {
  if (!content) return [{ type: "paragraph" }];
  if ("text" in content) return [content.text ? { type: "paragraph", content: [{ type: "text", text: content.text }] } : { type: "paragraph" }];
  const blocks = contentBlocks(content);
  if (!blocks.length) return [{ type: "paragraph" }];
  if (blocks.some((one) => one.type !== "paragraph")) throw new Refused("bad_op", "A table cell holds paragraphs only: words, links, bold and chips.");
  return blocks;
}

/** One cell per row or column from content: blocks of cells, or text/Markdown with the cells between " | ". */
function cellsOf(content: Content | undefined, count: number, kind: "row" | "column"): DocNode[][] {
  if (content && "blocks" in content) {
    const given = kind === "row" && content.blocks.length === 1 && content.blocks[0]!.type === "tableRow" ? (content.blocks[0]!.content ?? []) : content.blocks;
    if (given.some((cell) => cell.type !== "tableCell" && cell.type !== "tableHeader")) throw new Refused("bad_op", `Blocks for a new ${kind} are its cells (tableCell or tableHeader).`);
    if (given.length > count) throw new Refused("bad_op", `The new ${kind} has ${given.length} cells; the table has ${count}.`);
    return Array.from({ length: count }, (_, i) => clone(given[i]?.content ?? [{ type: "paragraph" }]));
  }
  const raw = content ? ("text" in content ? content.text : content.markdown) : "";
  const trimmed = raw.trim().replace(/^\|/, "").replace(/\|$/, "");
  const parts = trimmed ? trimmed.split(/(?<!\\)\|/).map((part) => part.trim().replace(/\\\|/g, "|")) : [];
  if (parts.length > count) throw new Refused("bad_op", `The new ${kind} has ${parts.length} cells; the table has ${count} ${kind === "row" ? "columns" : "rows"}.`);
  return Array.from({ length: count }, (_, i) => {
    const part = parts[i] ?? "";
    if (!part) return [{ type: "paragraph" }];
    return content && "markdown" in content ? cellParagraphs({ markdown: part, ...(content.chips && { chips: content.chips }) }) : [{ type: "paragraph", content: [{ type: "text", text: part }] }];
  });
}

/** A position in `length` places, 0 first and -1 last; undefined past either end. */
function position(value: number, length: number): number | undefined {
  const at = value < 0 ? length + value : value;
  return at >= 0 && at < length ? at : undefined;
}

function tableOp(doc: DocDocument, tab: DocTab, op: Extract<DocOp, { op: "table" }>, rev: number, options: ApplyOptions): Done {
  const place = placeOf(tab, op.table, doc);
  const table = place.node;
  if (table.type !== "table") throw new Refused("bad_op", `"${op.table}" is a ${table.type}, not a table.`, table);
  const before = clone(table);
  const rows = table.content ?? [];
  const width = rows[0]?.content?.length ?? 0;
  // What counts positions (all but adding at the end) is guarded: the table must be as it was at the revision read.
  const positional = op.action !== "addRow" && op.action !== "addColumn" ? true : op.action === "addRow" ? op.row !== undefined : op.col !== undefined;
  if (positional) {
    if (op.ifRev === undefined) throw new Refused("missing_guard", `A table op by row or column needs ifRev (the revision you read the table at; it is at rev ${rev}).`, table);
    if (op.ifRev !== rev) {
      // Another revision: only when the table was then as it is now (looked up where the store keeps versions).
      const then = op.ifRev < rev ? options.docAt?.(op.ifRev) : undefined;
      const old = then && findBlock(then, op.table)?.node;
      if (!old || blockHash(old) !== blockHash(before)) {
        throw new Refused("guard_mismatch", `The table changed since rev ${op.ifRev} (now ${rows.length} rows by ${width} columns, at rev ${rev}): read it again and count anew.`, table);
      }
    }
  }
  const cell = (type: string, content: DocNode[]): DocNode => ({ type, content });
  const header = rows[0]?.content?.every((one) => one.type === "tableHeader") === true;
  switch (op.action) {
    case "addRow": {
      const at = op.row === undefined ? rows.length : op.row < 0 ? rows.length + op.row + 1 : op.row;
      if (at < 0 || at > rows.length) throw new Refused("cell_none", `Row ${op.row} is past the table: it has ${rows.length} rows (0 to ${rows.length}).`, table);
      if (at === 0 && header) throw new Refused("bad_op", "Row 0 is the header row: add the new row at 1 or later.", table);
      const cells = cellsOf(op.with, width, "row");
      rows.splice(at, 0, { type: "tableRow", content: cells.map((content) => cell("tableCell", content)) });
      break;
    }
    case "addColumn": {
      if (width >= MAX_COLUMNS) throw new Refused("bad_op", `A table has at most ${MAX_COLUMNS} columns.`, table);
      const at = op.col === undefined ? width : op.col < 0 ? width + op.col + 1 : op.col;
      if (at < 0 || at > width) throw new Refused("cell_none", `Column ${op.col} is past the table: it has ${width} columns (0 to ${width}).`, table);
      const cells = cellsOf(op.with, rows.length, "column");
      rows.forEach((row, r) => row.content!.splice(at, 0, cell(r === 0 && header ? "tableHeader" : "tableCell", cells[r]!)));
      break;
    }
    case "deleteRow": {
      const at = position(op.row ?? -1, rows.length);
      if (at === undefined) throw new Refused("cell_none", `Row ${op.row} is past the table: it has ${rows.length} rows.`, table);
      if (rows.length === 1) throw new Refused("bad_op", "It is the table's only row: delete the table by its id instead.", table);
      rows.splice(at, 1);
      break;
    }
    case "deleteColumn": {
      const at = position(op.col ?? -1, width);
      if (at === undefined) throw new Refused("cell_none", `Column ${op.col} is past the table: it has ${width} columns.`, table);
      if (width === 1) throw new Refused("bad_op", "It is the table's only column: delete the table by its id instead.", table);
      for (const row of rows) row.content!.splice(at, 1);
      break;
    }
    case "setCell": {
      const r = position(op.row ?? 0, rows.length);
      const c = position(op.col ?? 0, width);
      if (r === undefined || c === undefined || op.row === undefined || op.col === undefined) {
        throw new Refused("cell_none", `setCell names a cell by row and col: the table has ${rows.length} rows and ${width} columns (0 first, -1 last).`, table);
      }
      const target = rows[r]!.content![c]!;
      target.content = cellParagraphs(op.with);
      break;
    }
  }
  return {
    touched: [op.table],
    filled: [],
    normalised: { op: "replace", tab: tab.id, target: { id: op.table }, with: { blocks: [table] }, ifHash: hOf(before), ifRev: rev },
  };
}

/**
 * Apply `ops` to `doc`, in order, all or none: the document after them (checked against the schema, every block hashed,
 * new blocks given ids), what they touched, and the same edit normalised; or the first refusal, with nothing changed.
 */
export function applyOps(doc: DocDocument, ops: readonly DocOp[], options: ApplyOptions = {}): ApplyResult {
  let working = clone(doc);
  const changed = new Set<string>();
  const filled: string[] = [];
  const normalised: DocOp[] = [];
  for (const [index, op] of ops.entries()) {
    try {
      const tab = working.tabs.find((one) => one.id === op.tab);
      if (!tab) throw new Refused("no_tab", `No tab "${op.tab}" in the document: its tabs are ${working.tabs.map((one) => `"${one.id}" (${one.title})`).join(", ")}.`);
      // Guards name the revision read: the document's as given (ops never raise it; the store does on save).
      const done =
        op.op === "replace"
          ? replaceOp(working, tab, op, doc.rev)
          : op.op === "insert"
            ? insertOp(working, tab, op)
            : op.op === "delete"
              ? deleteOp(working, tab, op, doc.rev)
              : tableOp(working, tab, op, doc.rev, options);
      // New blocks get their ids here, in place, so the normalised op names the same ones.
      giveIds(working);
      let checked: DocDocument;
      try {
        checked = checkDocument(working);
      } catch (error) {
        if (error instanceof DocumentError) throw new Refused("invalid", `That would not fit the document's schema: ${error.message}.`);
        throw error;
      }
      // The normalised op's blocks as the check left them (ids given, hashes computed).
      const normal = done.normalised;
      if ((normal.op === "replace" || normal.op === "insert") && "blocks" in normal.with) {
        normal.with = { blocks: normal.with.blocks.map((block) => clone(findBlock(checked, idOf(block))?.node ?? block)) };
      }
      working = checked;
      // Inserted top-level blocks count as written.
      if (normal.op === "insert" && "blocks" in normal.with) for (const block of normal.with.blocks) changed.add(topIdOf(working, idOf(block)) ?? idOf(block));
      if (normal.op === "replace" && "blocks" in normal.with) for (const block of normal.with.blocks) changed.add(topIdOf(working, idOf(block)) ?? idOf(block));
      for (const id of done.touched) changed.add(id);
      filled.push(...done.filled);
      normalised.push(normal);
    } catch (error) {
      if (!(error instanceof Refused)) throw error;
      return { ok: false, refused: { index, code: error.code, message: error.message, rev: doc.rev, ...(error.now && { now: nowOf(error.now) }) } };
    }
  }
  return { ok: true, doc: working, changed: [...changed].filter(Boolean), filled, normalised };
}

/**
 * `ops` as an edit request stores them (DOCS-BRIEF: an edit request is normalised): each by id, its content as blocks,
 * each whole-block change guarded by its block's hash at `doc.rev`, table ops as the whole table replaced. Applied later
 * (approval), they write exactly these blocks, or are refused when a block they change has changed since (redo).
 */
export function normaliseOps(ops: readonly DocOp[], doc: DocDocument): { ok: true; ops: DocOp[] } | { ok: false; refused: Refusal } {
  const result = applyOps(doc, ops);
  return result.ok ? { ok: true, ops: result.normalised } : result;
}

// ---- Placeholders and reading ----

/**
 * The first tab of a document being written section by section: a lead paragraph (when given) and a pending
 * placeholder per section, each saying what will go there; pi then fills one per call (a replace by the placeholder's id).
 */
export function outlineBlocks(sections: readonly string[], lead?: string): DocNode[] {
  const blocks: DocNode[] = [];
  if (lead?.trim()) blocks.push({ type: "paragraph", content: [{ type: "text", text: lead.trim() }] });
  for (const intent of sections) if (intent.trim()) blocks.push({ type: "pending", attrs: { intent: intent.trim().slice(0, 2_000) } });
  if (!blocks.length) blocks.push({ type: "paragraph" });
  return blocks;
}

/** One block in full, as a model reads it: its id, hash and kind, then its Markdown. */
export function blockReading(doc: DocDocument, id: string): string | undefined {
  const found = findBlock(doc, id);
  if (!found) return undefined;
  const node = found.node;
  const parts = [`${idOf(node)} ${hOf(node)} ${node.type} (tab ${found.tabId}, rev ${doc.rev})`, blockMarkdown(node)];
  // A table's and a list's rows/items by id: what row/col ops count and what an item's replace names.
  if (node.type === "table") parts.push((node.content ?? []).map((row, r) => `row ${r}: ${(row.content ?? []).map((one) => blockText(one)).join(" | ")}`).join("\n"));
  if (LISTS.has(node.type)) parts.push((node.content ?? []).map((item) => `${idOf(item)} ${hOf(item)}: ${blockText(item).split("\n")[0]}`).join("\n"));
  return parts.join("\n\n");
}

/** The blocks whose text holds `words`, as lines a model reads: id, hash, kind and the start of the text. */
export function searchReading(doc: DocDocument, words: string, max = 20): string {
  const lines: string[] = [];
  for (const tab of doc.tabs) {
    for (const hit of occurrences(tab, words)) {
      if (lines.length >= max) break;
      const id = idOf(hit.node);
      if (lines.some((line) => line.startsWith(`${id} `))) continue;
      lines.push(`${id} ${hOf(hit.node)} ${hit.node.type} (tab ${tab.id}): ${blockText(hit.node).replace(/\s+/g, " ").slice(0, 160)}`);
    }
  }
  return lines.length ? lines.join("\n") : `No block holds "${words}".`;
}
