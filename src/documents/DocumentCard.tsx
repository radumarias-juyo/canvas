// A document in the chat: the card a document tool's result shows (document_create, document_update), which opens it.
// An edit request made instead of an edit says so: it waits for the document's owner.

import type { EntryRecord } from "@earendil-works/pi-durable";
import type { ToolResultMessage } from "@earendil-works/pi-ai";
import { AppLink } from "../layout.tsx";
import { DOCUMENT_TOOLS, documentDetails, type DocumentCardDetails } from "./model.ts";

/** The document a tool result made or changed, as its card shows it; undefined for any other result. */
export function documentOf(entry: EntryRecord): DocumentCardDetails | undefined {
  if (entry.kind !== "pi.tool-result") return undefined;
  const message = entry.model?.[0] as ToolResultMessage | undefined;
  if (!message || message.isError || !DOCUMENT_TOOLS.includes(message.toolName)) return undefined;
  return documentDetails(message.details);
}

/** Where a document opens: its own page in the app. */
export const documentPath = (id: string) => `/d/${encodeURIComponent(id)}`;

export function DocumentCard({ details, navigate }: { details: DocumentCardDetails; navigate?: (path: string) => void }) {
  return (
    <AppLink path={documentPath(details.documentId)} navigate={navigate} className={`artifact-card doc-card${details.requested ? " requested" : ""}`}>
      <span className="artifact-card-icon doc-card-icon" aria-hidden="true">
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
          <path d="M7 3h7l4 4v14H7zM14 3v4h4M10 12h5M10 16h5" />
        </svg>
      </span>
      <span>
        <strong>{details.title || "Untitled document"}</strong>
        <small>{details.requested ? "Document · edit requested, waits for its owner" : `Document${details.rev !== undefined ? ` · version ${details.rev}` : ""} · open`}</small>
      </span>
    </AppLink>
  );
}
