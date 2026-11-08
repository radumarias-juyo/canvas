// The React views of the schema's custom nodes (schema.ts): pi's placeholder while it writes, CSV as a grid, a
// formula, an embed's frame, and the inline chips. Each reads the editor's editable state: a reader sees the result,
// the owner can change a chip in place.

import type { AnyExtension, Extensions } from "@tiptap/core";
import { Dropcursor, Gapcursor, Placeholder, UndoRedo } from "@tiptap/extensions";
import { NodeViewContent, NodeViewWrapper, ReactNodeViewRenderer, type ReactNodeViewProps } from "@tiptap/react";
import { useId, useState } from "react";
import { csvRows, dateLabel } from "./chips.ts";
import { schemaExtensions } from "./schema.ts";

/** pi's placeholder for a section it has yet to write: what the section is for, and that it is on its way. */
export function PendingView({ node }: Pick<ReactNodeViewProps, "node">) {
  const intent = String(node.attrs.intent ?? "");
  return (
    <NodeViewWrapper className="doc-pending" data-pending="" contentEditable={false}>
      <PendingLine intent={intent} />
    </NodeViewWrapper>
  );
}

/** The placeholder's line, apart so a reader's view and the tests draw it without an editor. */
export function PendingLine({ intent }: { intent: string }) {
  return (
    <span className="doc-pending-line" role="status">
      <span className="doc-pending-who">pi is writing</span>
      {intent && <span className="doc-pending-intent">{intent}</span>}
    </span>
  );
}

/** CSV: its text, editable as text while editing, and drawn as a grid below it (only the grid for a reader). */
function CsvView({ node, editor }: ReactNodeViewProps) {
  const rows = csvRows(node.textContent);
  return (
    <NodeViewWrapper className="doc-csv">
      {editor.isEditable && (
        <pre className="doc-csv-source">
          <NodeViewContent<"code"> as="code" />
        </pre>
      )}
      <CsvGrid rows={rows} />
    </NodeViewWrapper>
  );
}

/** A CSV block's rows as a table, the first row as its head. */
export function CsvGrid({ rows }: { rows: string[][] }) {
  if (!rows.length) return <p className="doc-empty-block">Empty CSV</p>;
  const [head, ...body] = rows;
  return (
    <div className="doc-csv-scroll" tabIndex={0} role="region" aria-label="CSV data">
      <table className="doc-csv-grid">
        <thead>
          <tr>
            {head.map((cell, index) => (
              <th key={index} scope="col">
                {cell}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {body.map((row, r) => (
            <tr key={r}>
              {head.map((_, c) => (
                <td key={c}>{row[c] ?? ""}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** A display formula: its LaTeX source, set apart as a formula (drawn as typeset maths later). */
function LatexView() {
  return (
    <NodeViewWrapper className="doc-latex">
      <span className="doc-block-label" contentEditable={false}>
        Formula
      </span>
      <pre>
        <NodeViewContent<"code"> as="code" />
      </pre>
    </NodeViewWrapper>
  );
}

/** A chart or diagram block: a frame naming it until the dashboard renderer draws it (phase 2). */
function EmbedView({ node }: ReactNodeViewProps) {
  return (
    <NodeViewWrapper className="doc-embed" contentEditable={false}>
      <span className="doc-block-label">{node.attrs.kind === "diagram" ? "Diagram" : "Chart"}</span>
      <span>{String(node.attrs.title || "Drawn by the dashboard renderer in a coming version")}</span>
    </NodeViewWrapper>
  );
}

function MentionView({ node }: ReactNodeViewProps) {
  return (
    <NodeViewWrapper as="span" className="doc-chip doc-chip-mention" data-chip="mention">
      @{String(node.attrs.name)}
    </NodeViewWrapper>
  );
}

/** A date: shown in the reader's format; the owner picks another in place. */
function DateView({ node, editor, updateAttributes }: ReactNodeViewProps) {
  const value = String(node.attrs.value ?? "");
  const [editing, setEditing] = useState(false);
  const label = dateLabel(value);
  if (editing && editor.isEditable) {
    return (
      <NodeViewWrapper as="span" className="doc-chip doc-chip-date editing">
        <input
          type="date"
          autoFocus
          defaultValue={value}
          aria-label="Date"
          onBlur={() => setEditing(false)}
          onKeyDown={(event) => {
            if (event.key === "Escape") setEditing(false);
          }}
          onChange={(event) => {
            if (event.target.value) updateAttributes({ value: event.target.value });
          }}
        />
      </NodeViewWrapper>
    );
  }
  return (
    <NodeViewWrapper as="span" className="doc-chip doc-chip-date" data-chip="date">
      {editor.isEditable ? (
        <button type="button" className="doc-chip-button" onClick={() => setEditing(true)} title="Change the date">
          {label}
        </button>
      ) : (
        <time dateTime={value}>{label}</time>
      )}
    </NodeViewWrapper>
  );
}

/** A dropdown: one of its options; the owner picks another in place. */
function DropdownView({ node, editor, updateAttributes }: ReactNodeViewProps) {
  const options = Array.isArray(node.attrs.options) ? (node.attrs.options as unknown[]).map(String) : [];
  const value = String(node.attrs.value ?? "");
  const id = useId();
  return (
    <NodeViewWrapper as="span" className="doc-chip doc-chip-dropdown" data-chip="dropdown" data-value={value}>
      {editor.isEditable ? (
        <select id={id} value={options.includes(value) ? value : ""} aria-label="Choose a value" onChange={(event) => updateAttributes({ value: event.target.value || null })}>
          <option value="">—</option>
          {options.map((option) => (
            <option key={option} value={option}>
              {option}
            </option>
          ))}
        </select>
      ) : (
        <span>{value || "—"}</span>
      )}
    </NodeViewWrapper>
  );
}

const VIEWS: Record<string, (props: ReactNodeViewProps) => React.ReactNode> = {
  pending: PendingView,
  csv: CsvView,
  latex: LatexView,
  embed: EmbedView,
  mention: MentionView,
  date: DateView,
  dropdown: DropdownView,
};

/**
 * The editor's extensions: the schema's, with the views above, undo and redo, a placeholder line in an empty
 * document, and the cursor helpers. Nothing that adds a node or mark: the schema stays exactly the model's.
 */
export function editorExtensions({
  placeholder,
  documentId,
  taken,
}: {
  placeholder: string;
  documentId: string;
  taken?: () => ReadonlySet<string>;
}): Extensions {
  const withViews = schemaExtensions({ documentId, taken }).map((extension) => {
    const view = VIEWS[extension.name];
    if (!view) return extension;
    return (extension as AnyExtension & { extend: (config: object) => AnyExtension }).extend({ addNodeView: () => ReactNodeViewRenderer(view) });
  });
  return [
    ...withViews,
    UndoRedo,
    Dropcursor,
    Gapcursor,
    Placeholder.configure({ placeholder, showOnlyWhenEditable: true }),
  ];
}
