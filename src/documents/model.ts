// The editor's side of the document model: the views the document routes send (DOCS-BRIEF, "HTTP contract for
// documents"), edit requests, and the plain functions the page edits with (a diff into ops, a three-way merge onto a
// newer save). The document itself is shared/document.ts's; the tests read all of it without a browser.

import { canonicalJson } from "../../shared/canonical.ts";
import { blockText, type DocDocument, type DocNode } from "../../shared/document.ts";

export { blockText, BLOCK_TYPES, DOCUMENT_SCHEMA, MARK_TYPES, newBlockId, tabDoc, type DocDocument, type DocNode, type DocTab } from "../../shared/document.ts";

/** A top-level block of a tab: a node with its stable id (and, as the server last saw it, its hash `h`). */
export type Block = DocNode & { attrs: Record<string, unknown> & { id: string } };

/** GET /api/documents/:id. `private`: blocks a reader sees only as a placeholder (the owner sees them marked). */
export interface DocumentView {
  id: string;
  title: string;
  ownerUid: string;
  /** The owner's name, when the server sends it; else the page says "its owner". */
  ownerName?: string;
  chatId: string;
  rev: number;
  doc: DocDocument;
  mayEdit: boolean;
  private: string[];
}

/** One document in a list (GET /api/documents): the sidebar's Documents. */
export interface DocumentSummary {
  id: string;
  title: string;
  chatId: string;
  ownerUid: string;
  rev: number;
  updatedAt: number;
  unread?: boolean;
}

/** One saved version (GET .../versions). */
export interface DocVersion {
  n: number;
  rev: number;
  at: number;
  by: string;
  byName?: string;
}

// The ops, as DOCS-BRIEF fixes them (DocOp in shared/document-ops.ts once it lands: mirrored here under the same name).
type Target = { id: string } | { quote: string; nth?: number };
type Content = { blocks: DocNode[] } | { markdown: string } | { text: string };
export type DocOp =
  | { op: "replace"; tab: string; target: Target; with: Content; ifHash?: string; ifRev?: number }
  | { op: "insert"; tab: string; at: { after: string } | { before: string } | { end: true } | { endOfSection: string }; with: Content }
  | { op: "delete"; tab: string; target: { id: string }; ifHash: string; ifRev: number }
  | {
      op: "table";
      tab: string;
      table: string;
      action: "addRow" | "addColumn" | "deleteRow" | "deleteColumn" | "setCell";
      row?: number;
      col?: number;
      with?: Content;
      ifRev?: number;
    };

export type RequestState = "pending" | "approved" | "declined" | "stale";

/** An edit request (GET .../requests): its ops stored normalised to `{blocks}` by the server. */
export interface EditRequest {
  rid: string;
  by: string;
  byName?: string;
  at: number;
  ops: DocOp[];
  note?: string;
  /** The server's short text of what it changes, when it sends one. */
  preview?: string;
  state: RequestState;
}

/** A chat card's details (document_create / document_update tool results): which document, and an edit request made. */
export interface DocumentCardDetails {
  documentId: string;
  title: string;
  rev?: number;
  requested?: string;
}

/** The details of a document tool's result, when they are one's; undefined for anything else. */
export function documentDetails(details: unknown): DocumentCardDetails | undefined {
  if (!details || typeof details !== "object") return undefined;
  const value = details as Record<string, unknown>;
  if (typeof value.documentId !== "string" || typeof value.title !== "string") return undefined;
  return {
    documentId: value.documentId,
    title: value.title,
    ...(typeof value.rev === "number" && { rev: value.rev }),
    ...(typeof value.requested === "string" && { requested: value.requested }),
  };
}

/** The tools whose results show a document card in the chat. */
export const DOCUMENT_TOOLS = ["document_create", "document_update"];

/** A node without any block's hash, at any depth: what an edit compares (a hash the editor carries may be stale). */
export function withoutHash(node: DocNode): DocNode {
  const { attrs, content, ...rest } = node;
  const kept = attrs && Object.fromEntries(Object.entries(attrs).filter(([key, value]) => key !== "h" && value !== null && value !== undefined));
  return {
    ...rest,
    ...(kept && Object.keys(kept).length > 0 && { attrs: kept }),
    ...(content && { content: content.map(withoutHash) }),
  };
}

// Key order differs between the editor and the server: compared as canonical JSON.
const same = (a: DocNode, b: DocNode) => canonicalJson(withoutHash(a)) === canonicalJson(withoutHash(b));
const hashOf = (block: Block) => (typeof block.attrs.h === "string" ? block.attrs.h : "");

/**
 * The ops that turn `base`'s top-level blocks into `mine` (one tab), by block id: a changed block replaced whole (with
 * the hash and rev it was read at), a new one inserted after the block before it (before the first, or at the end of
 * an empty tab), a missing one deleted. What "Suggest a change" sends as an edit request.
 */
export function diffBlocks(tab: string, base: readonly Block[], mine: readonly Block[], rev: number): DocOp[] {
  const before = new Map(base.map((block) => [block.attrs.id, block]));
  const kept = new Set(mine.map((block) => block.attrs.id));
  const ops: DocOp[] = [];
  for (const block of base) {
    if (!kept.has(block.attrs.id)) ops.push({ op: "delete", tab, target: { id: block.attrs.id }, ifHash: hashOf(block), ifRev: rev });
  }
  mine.forEach((block, index) => {
    const old = before.get(block.attrs.id);
    const clean = withoutHash(block);
    if (!old) {
      const prior = mine[index - 1];
      const next = mine.slice(index + 1).find((each) => before.has(each.attrs.id));
      const at = prior ? { after: prior.attrs.id } : next ? { before: next.attrs.id } : { end: true as const };
      ops.push({ op: "insert", tab, at, with: { blocks: [clean] } });
    } else if (!same(old, block)) {
      ops.push({ op: "replace", tab, target: { id: block.attrs.id }, with: { blocks: [clean] }, ...(hashOf(old) && { ifHash: hashOf(old) }), ifRev: rev });
    }
  });
  return ops;
}

/** What a three-way merge of one tab came to: the blocks, and the ids both sides changed (theirs kept there). */
export interface Merged {
  blocks: Block[];
  conflicts: string[];
}

/**
 * Merge my edits (`mine`, from `base`) onto a newer save (`theirs`), block by block: a block only I changed takes mine,
 * a block only they changed takes theirs, one we both changed keeps theirs and is named a conflict (my text is then
 * offered to copy back). Blocks I added go after the block they followed in mine (or first); blocks I deleted that
 * they left alone go. Never drops their newer edit silently.
 */
export function mergeBlocks(base: readonly Block[], mine: readonly Block[], theirs: readonly Block[]): Merged {
  const baseById = new Map(base.map((block) => [block.attrs.id, block]));
  const mineById = new Map(mine.map((block) => [block.attrs.id, block]));
  const theirIds = new Set(theirs.map((block) => block.attrs.id));
  const conflicts: string[] = [];
  const blocks: Block[] = [];
  for (const block of theirs) {
    const id = block.attrs.id;
    const was = baseById.get(id);
    const mineNow = mineById.get(id);
    if (!was) {
      blocks.push(block);
      continue;
    }
    const theyChanged = !same(was, block);
    if (!mineNow) {
      // I deleted it: gone, unless they changed it meanwhile (then it stays, a conflict).
      if (theyChanged) {
        conflicts.push(id);
        blocks.push(block);
      }
      continue;
    }
    const iChanged = !same(was, mineNow);
    if (iChanged && theyChanged && !same(mineNow, block)) {
      conflicts.push(id);
      blocks.push(block);
    } else blocks.push(iChanged ? mineNow : block);
  }
  // Blocks I added, after the block before them in mine (the nearest one still there), else first.
  mine.forEach((block, index) => {
    const id = block.attrs.id;
    if (baseById.has(id) || theirIds.has(id)) return;
    let at = -1;
    for (let back = index - 1; back >= 0 && at < 0; back--) at = blocks.findIndex((each) => each.attrs.id === mine[back].attrs.id);
    blocks.splice(at + 1, 0, block);
  });
  return { blocks, conflicts };
}

/** A document with one tab's blocks replaced: what a save sends. */
export function withTab(doc: DocDocument, tabId: string, blocks: DocNode[]): DocDocument {
  return { ...doc, tabs: doc.tabs.map((tab) => (tab.id === tabId ? { ...tab, content: blocks } : tab)) };
}

/** The blocks an op puts in (its `{blocks}`), for the request card: none for markdown or text, which the server resolves. */
export function opBlocks(op: DocOp): DocNode[] {
  const content = "with" in op ? op.with : undefined;
  return content && "blocks" in content ? content.blocks : [];
}

/** The block an op names by id, if it names one so. */
export function opTarget(op: DocOp): string | undefined {
  if (op.op === "replace" || op.op === "delete") return "id" in op.target ? op.target.id : undefined;
  if (op.op === "table") return op.table;
  return undefined;
}

/** A block's text, for diffs and conflicts. */
export const textOf = (node: DocNode) => blockText(node);

/** Every id in one tab's blocks, at any depth: the editor keeps them unique across the document. */
export function idsOfBlocks(blocks: readonly DocNode[]): Set<string> {
  const ids = new Set<string>();
  const visit = (node: DocNode) => {
    if (typeof node.attrs?.id === "string") ids.add(node.attrs.id);
    node.content?.forEach(visit);
  };
  blocks.forEach(visit);
  return ids;
}
