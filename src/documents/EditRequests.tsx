// Edit requests on a document: what someone other than its owner asked to change, as a card with the change shown word
// by word. Its owner approves (applied exactly as asked, re-checked against the current version) or declines; the person
// who asked sees it as requested until then.

import { diffWords } from "diff";
import { useState } from "react";
import { errorMessage } from "../../shared/util.ts";
import { sentLabel } from "../chat/SentTime.tsx";
import { opBlocks, opTarget, textOf, type Block, type DocOp, type EditRequest } from "./model.ts";

/** One op as the card shows it: what it was, what it becomes, word by word. */
export interface OpChange {
  kind: "changed" | "added" | "removed";
  parts: { text: string; added?: boolean; removed?: boolean }[];
  /** A block the op names that is no longer in the document: the request is stale there. */
  missing?: boolean;
}

/**
 * How an edit request's ops read against the document as it is now (`blocks`: every tab's top-level blocks). The
 * server stores a request's ops with their content as `{blocks}`, so the card shows exactly what approving applies.
 */
export function opChanges(ops: readonly DocOp[], blocks: readonly Block[]): OpChange[] {
  const byId = new Map<string, Block>();
  const index = (node: Block) => {
    byId.set(node.attrs.id, node);
    node.content?.forEach((child) => typeof child.attrs?.id === "string" && index(child as Block));
  };
  blocks.forEach(index);
  const newText = (op: DocOp) => opBlocks(op).map(textOf).join("\n");
  return ops.map((op): OpChange => {
    if (op.op === "insert") return { kind: "added", parts: [{ text: newText(op), added: true }] };
    const id = opTarget(op);
    const old = id ? byId.get(id) : undefined;
    if (op.op === "delete") return { kind: "removed", parts: [{ text: old ? textOf(old) : "(a block no longer there)", removed: true }], missing: !old };
    if (op.op === "table") return { kind: "changed", parts: [{ text: `${TABLE_WORDS[op.action]}${op.with ? `: ${newText(op)}` : ""}` }], missing: !old };
    if (!old) return { kind: "changed", parts: [{ text: newText(op), added: true }], missing: true };
    return { kind: "changed", parts: diffWords(textOf(old), newText(op)).map((part) => ({ text: part.value, added: part.added, removed: part.removed })) };
  });
}

const TABLE_WORDS: Record<Extract<DocOp, { op: "table" }>["action"], string> = {
  addRow: "Adds a table row",
  addColumn: "Adds a table column",
  deleteRow: "Removes a table row",
  deleteColumn: "Removes a table column",
  setCell: "Sets a table cell",
};

const KIND_WORD: Record<OpChange["kind"], string> = { changed: "Changes", added: "Adds", removed: "Removes" };

/**
 * One edit request. `owner`: the viewer owns the document, and decides; `mine`: the viewer asked for it. Others see
 * nothing of someone else's request but that one waits.
 */
export function EditRequestCard({
  request,
  blocks,
  owner,
  mine,
  onDecide,
}: {
  request: EditRequest;
  blocks: readonly Block[];
  owner: boolean;
  mine: boolean;
  onDecide?: (action: "approve" | "decline") => Promise<void>;
}) {
  const [busy, setBusy] = useState<"approve" | "decline" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const changes = opChanges(request.ops, blocks);
  const stale = request.state === "stale" || changes.some((change) => change.missing);
  const who = mine ? "You" : (request.byName ?? "Someone");
  const decide = async (action: "approve" | "decline") => {
    if (!onDecide) return;
    setBusy(action);
    setError(null);
    try {
      await onDecide(action);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(null);
    }
  };
  return (
    <article className={`doc-request ${request.state}`} aria-label={`Edit request from ${who}`}>
      <header className="doc-request-head">
        <strong>{mine ? "You asked for a change" : `${who} asks for a change`}</strong>
        <small>{sentLabel(request.at, Date.now())}</small>
        <span className={`pill doc-request-state ${request.state}`}>{stateLabel(request.state, owner, stale)}</span>
      </header>
      {request.note && <p className="doc-request-note">“{request.note}”</p>}
      <ol className="doc-request-ops">
        {changes.map((change, index) => (
          <li key={index} className={`doc-op ${change.kind}`}>
            <span className="doc-op-kind">{KIND_WORD[change.kind]}</span>
            <span className="doc-op-text">
              {change.parts.map((part, at) =>
                part.added ? (
                  <ins key={at}>{part.text}</ins>
                ) : part.removed ? (
                  <del key={at}>{part.text}</del>
                ) : (
                  <span key={at}>{part.text}</span>
                ),
              )}
            </span>
          </li>
        ))}
      </ol>
      {owner && request.state === "pending" && (
        <div className="doc-request-actions">
          {stale && <small className="skills-note">The document changed since: approving re-checks it, and a change that no longer fits asks to be redone.</small>}
          <button type="button" onClick={() => void decide("decline")} disabled={busy !== null}>
            {busy === "decline" ? "Declining…" : "Decline"}
          </button>
          <button type="button" className="primary" onClick={() => void decide("approve")} disabled={busy !== null}>
            {busy === "approve" ? "Approving…" : "Approve"}
          </button>
        </div>
      )}
      {error && <p className="form-error">{error}</p>}
    </article>
  );
}

/** A request's state, as its pill says it. */
export function stateLabel(state: EditRequest["state"], owner: boolean, stale: boolean): string {
  if (state === "pending") return owner ? (stale ? "Needs a re-check" : "Waits for you") : "Requested";
  if (state === "approved") return "Approved";
  if (state === "declined") return "Declined";
  return "Out of date: ask again";
}
