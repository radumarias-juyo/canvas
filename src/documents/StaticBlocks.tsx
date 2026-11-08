// A document's blocks drawn without an editor: a version in the history panel, and anywhere a read-only look is enough.
// Only the schema's nodes and marks are drawn; links only to safe addresses, images only from the app (schema.ts).

import type { ReactNode } from "react";
import { csvRows, dateLabel } from "./chips.ts";
import type { DocNode } from "./model.ts";
import { imageUrl, safeHref } from "./schema.ts";
import { CsvGrid, PendingLine } from "./views.tsx";

function marked(text: string, marks: DocNode["marks"] = [], key: number): ReactNode {
  return marks.reduce<ReactNode>((inner, mark) => {
    switch (mark.type) {
      case "bold":
        return <strong>{inner}</strong>;
      case "italic":
        return <em>{inner}</em>;
      case "strike":
        return <s>{inner}</s>;
      case "code":
        return <code>{inner}</code>;
      case "link": {
        const href = safeHref(mark.attrs?.href);
        return href ? (
          <a href={href} target="_blank" rel="noopener noreferrer nofollow">
            {inner}
          </a>
        ) : (
          inner
        );
      }
      default:
        return inner;
    }
  }, <span key={key}>{text}</span>);
}

function inline(nodes: DocNode[] = []): ReactNode[] {
  return nodes.map((node, key) => {
    switch (node.type) {
      case "text":
        return <span key={key}>{marked(node.text ?? "", node.marks, key)}</span>;
      case "mention":
        return (
          <span key={key} className="doc-chip doc-chip-mention">
            @{String(node.attrs?.name ?? "")}
          </span>
        );
      case "date":
        return (
          <span key={key} className="doc-chip doc-chip-date">
            <time dateTime={String(node.attrs?.value ?? "")}>{dateLabel(String(node.attrs?.value ?? ""))}</time>
          </span>
        );
      case "dropdown":
        return (
          <span key={key} className="doc-chip doc-chip-dropdown" data-value={String(node.attrs?.value ?? "")}>
            {node.attrs?.value == null ? "—" : String(node.attrs.value)}
          </span>
        );
      default:
        return null;
    }
  });
}

/** One node and what it holds. */
export function StaticNode({ node, documentId }: { node: DocNode; documentId: string }): ReactNode {
  const children = (node.content ?? []).map((child, index) => <StaticNode key={index} node={child} documentId={documentId} />);
  switch (node.type) {
    case "paragraph":
      return <p>{inline(node.content)}</p>;
    case "heading": {
      const level = Math.min(3, Math.max(1, Number(node.attrs?.level) || 1));
      const Tag = `h${level}` as "h1" | "h2" | "h3";
      return <Tag>{inline(node.content)}</Tag>;
    }
    case "bulletList":
      return <ul>{children}</ul>;
    case "orderedList":
      return <ol start={Number(node.attrs?.start) || undefined}>{children}</ol>;
    case "listItem":
      return <li>{children}</li>;
    case "taskList":
      return <ul data-type="taskList">{children}</ul>;
    case "taskItem":
      return (
        <li data-checked={node.attrs?.checked === true}>
          <input type="checkbox" checked={node.attrs?.checked === true} readOnly disabled aria-label={node.attrs?.checked ? "Done" : "Not done"} />
          <div>{children}</div>
        </li>
      );
    case "table":
      return (
        <div className="doc-table-scroll">
          <table>
            <tbody>{children}</tbody>
          </table>
        </div>
      );
    case "tableRow":
      return <tr>{children}</tr>;
    case "tableHeader":
      return <th scope="col">{children}</th>;
    case "tableCell":
      return <td>{children}</td>;
    case "codeBlock":
      return (
        <pre>
          <code>{(node.content ?? []).map((child) => child.text ?? "").join("")}</code>
        </pre>
      );
    case "csv":
      return (
        <div className="doc-csv">
          <CsvGrid rows={csvRows((node.content ?? []).map((child) => child.text ?? "").join(""))} />
        </div>
      );
    case "latex":
      return (
        <div className="doc-latex">
          <span className="doc-block-label">Formula</span>
          <pre>
            <code>{(node.content ?? []).map((child) => child.text ?? "").join("")}</code>
          </pre>
        </div>
      );
    case "image": {
      const src = imageUrl(documentId, node.attrs?.src);
      return src ? <img src={src} alt={String(node.attrs?.alt ?? "")} loading="lazy" /> : null;
    }
    case "embed":
      return (
        <div className="doc-embed">
          <span className="doc-block-label">{node.attrs?.kind === "diagram" ? "Diagram" : "Chart"}</span>
          <span>{String(node.attrs?.title ?? "")}</span>
        </div>
      );
    case "pending":
      return (
        <div className="doc-pending">
          <PendingLine intent={String(node.attrs?.intent ?? "")} />
        </div>
      );
    default:
      return null;
  }
}

/** A column of blocks, as a document's tab shows them. */
export function StaticBlocks({ blocks, documentId }: { blocks: readonly DocNode[]; documentId: string }) {
  return (
    <div className="doc-prose doc-static">
      {blocks.map((block, index) => (
        <StaticNode key={String(block.attrs?.id ?? index)} node={block} documentId={documentId} />
      ))}
    </div>
  );
}
