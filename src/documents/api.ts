// The document routes (DOCS-BRIEF, "HTTP contract for documents"), as the editor calls them. A failed call throws with
// the Worker's message and its status; a stale save (409) carries the newer document so the editor can merge.

import type { DocDocument, DocOp, DocumentSummary, DocumentView, DocVersion, EditRequest } from "./model.ts";

/** A failed call: the Worker's message, its status, and the body (a 409's newer document). */
export class DocumentError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: unknown,
  ) {
    super(message);
  }
}

/** A stale save: the version saved meanwhile, to merge onto. */
export interface Newer {
  rev: number;
  doc: DocDocument;
}

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, init);
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const message = (body as { error?: string } | null)?.error ?? (response.statusText || `HTTP ${response.status}`);
    throw new DocumentError(message, response.status, body);
  }
  return body as T;
}

const json = (method: string, body: unknown): RequestInit => ({ method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const at = (id: string, rest = "") => `/api/documents/${encodeURIComponent(id)}${rest}`;

/** The newer document a 409 on save carries, if the error is one. */
export function newerOf(error: unknown): Newer | null {
  if (!(error instanceof DocumentError) || error.status !== 409) return null;
  const body = error.body as Partial<Newer> | null;
  return body && typeof body.rev === "number" && body.doc && Array.isArray(body.doc.tabs) ? { rev: body.rev, doc: body.doc } : null;
}

export const documentsApi = {
  list: () => call<DocumentSummary[]>("/api/documents"),
  get: (id: string) => call<DocumentView>(at(id)),
  /** The owner's save: refused (409, with the newer one) when someone saved since `ifRev`. */
  save: (id: string, doc: DocDocument, ifRev: number) => call<{ rev: number }>(at(id), json("PUT", { doc, ifRev })),
  versions: (id: string) => call<DocVersion[]>(at(id, "/versions")),
  version: (id: string, n: number) => call<{ n: number; rev: number; doc: DocDocument }>(at(id, `/versions/${n}`)),
  restore: (id: string, n: number) => call<{ rev: number }>(at(id, `/versions/${n}/restore`), json("POST", {})),
  requests: (id: string) => call<EditRequest[]>(at(id, "/requests")),
  /** Any reader's ask for a change: the owner approves or declines it. */
  request: (id: string, ops: DocOp[], note?: string) => call<{ rid: string }>(at(id, "/requests"), json("POST", { ops, ...(note && { note }) })),
  decide: (id: string, rid: string, action: "approve" | "decline") => call<{ rev?: number }>(at(id, `/requests/${encodeURIComponent(rid)}`), json("POST", { action })),
  /** An image for the document, stored with it in the owner's files: the src to place. */
  image: async (id: string, file: File) => {
    const form = new FormData();
    form.append("file", file);
    return call<{ src: string }>(at(id, "/images"), { method: "POST", body: form });
  },
  exportUrl: (id: string, format: "md" | "docx" | "pdf") => at(id, `/export?format=${format}`),
};
