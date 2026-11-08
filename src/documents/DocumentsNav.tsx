// The sidebar's Documents, inside its Artifacts section: the user's documents and those in chats they are in, newest
// first, each opening on its own page. Read when the section opens, and again when it opens next.

import { useEffect, useState } from "react";
import { errorMessage } from "../../shared/util.ts";
import { AppLink } from "../layout.tsx";
import { documentsApi } from "./api.ts";
import { documentPath } from "./DocumentCard.tsx";
import type { DocumentSummary } from "./model.ts";

export function DocumentsNav({ openId, navigate, list = documentsApi.list }: { openId?: string; navigate: (path: string) => void; list?: () => Promise<DocumentSummary[]> }) {
  const [documents, setDocuments] = useState<DocumentSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    list().then(
      (found) => live && setDocuments([...found].sort((a, b) => b.updatedAt - a.updatedAt)),
      (e: unknown) => live && setError(errorMessage(e)),
    );
    return () => {
      live = false;
    };
  }, [list]);
  return <DocumentsList documents={documents} error={error} openId={openId} navigate={navigate} />;
}

/** The list itself, apart so the tests draw it with documents given. */
export function DocumentsList({
  documents,
  error,
  openId,
  navigate,
}: {
  documents: readonly DocumentSummary[] | null;
  error: string | null;
  openId?: string;
  navigate: (path: string) => void;
}) {
  return (
    <>
      <h4 className="nav-group">Documents</h4>
      {error && <p className="nav-empty form-error">Could not read your documents.</p>}
      {documents === null && !error && <p className="nav-empty">Reading…</p>}
      {documents && !documents.length && <p className="nav-empty">None yet: pick Document under Make in a chat.</p>}
      {documents?.map((document) => (
        <AppLink
          key={document.id}
          path={documentPath(document.id)}
          navigate={navigate}
          className={["nav-item", document.id === openId && "active", document.unread && "unread"].filter(Boolean).join(" ")}
        >
          <span className="nav-title">
            {document.title || "Untitled document"} <small>v{document.rev}</small>
          </span>
        </AppLink>
      ))}
    </>
  );
}
