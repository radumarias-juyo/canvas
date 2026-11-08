// A document's version history: every save, newest first; one opens beside the list as it was, and its owner can
// restore it (a new version with that content: nothing is lost).

import { useEffect, useState } from "react";
import { errorMessage } from "../../shared/util.ts";
import { sentLabel } from "../chat/SentTime.tsx";
import { Icon } from "../Icon.tsx";
import { documentsApi } from "./api.ts";
import type { DocDocument, DocVersion } from "./model.ts";
import { StaticBlocks } from "./StaticBlocks.tsx";

export function HistoryPanel({
  documentId,
  rev,
  owner,
  dirty,
  onClose,
  onRestored,
  api = documentsApi,
}: {
  documentId: string;
  /** The version open now: the list reads again when it changes. */
  rev: number;
  owner: boolean;
  /** The owner has changes not saved: restoring would drop them, so it asks first. */
  dirty: boolean;
  onClose: () => void;
  onRestored: (rev: number) => void;
  api?: Pick<typeof documentsApi, "versions" | "version" | "restore">;
}) {
  const [versions, setVersions] = useState<DocVersion[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<{ n: number; doc: DocDocument } | null>(null);
  const [opening, setOpening] = useState<number | null>(null);
  const [restoring, setRestoring] = useState(false);
  useEffect(() => {
    let live = true;
    api.versions(documentId).then(
      (list) => live && setVersions([...list].sort((a, b) => b.n - a.n)),
      (e: unknown) => live && setError(errorMessage(e)),
    );
    return () => {
      live = false;
    };
  }, [api, documentId, rev]);

  const show = async (n: number) => {
    setOpening(n);
    setError(null);
    try {
      const version = await api.version(documentId, n);
      setOpen({ n, doc: version.doc });
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setOpening(null);
    }
  };
  const restore = async () => {
    if (!open) return;
    if (dirty && !confirm("Restoring drops the changes you have not saved. Restore this version?")) return;
    setRestoring(true);
    setError(null);
    try {
      const { rev: next } = await api.restore(documentId, open.n);
      setOpen(null);
      onRestored(next);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setRestoring(false);
    }
  };
  const latest = versions?.[0]?.n;
  return (
    <aside className="doc-history" aria-label="Version history">
      <header className="doc-history-head">
        <h2>Version history</h2>
        <button type="button" className="icon-button" onClick={onClose} aria-label="Close version history" title="Close">
          <Icon size={18}>
            <path d="M6 6l12 12M18 6 6 18" />
          </Icon>
        </button>
      </header>
      {error && <p className="form-error">{error}</p>}
      {versions === null && !error && <p className="skills-note">Reading its versions…</p>}
      {versions && !versions.length && <p className="skills-note">No saved versions yet. Each save adds one.</p>}
      {open ? (
        <div className="doc-history-open">
          <div className="doc-history-bar">
            <button type="button" className="link-button" onClick={() => setOpen(null)}>
              ← All versions
            </button>
            <strong>Version {open.n}</strong>
            {owner && open.n !== latest && (
              <button type="button" className="primary" onClick={() => void restore()} disabled={restoring}>
                {restoring ? "Restoring…" : "Restore this version"}
              </button>
            )}
          </div>
          {open.n === latest && <p className="skills-note">This is the version open now.</p>}
          {open.doc.tabs.map((tab) => (
            <section key={tab.id} aria-label={tab.title}>
              {open.doc.tabs.length > 1 && <h3 className="doc-history-tab">{tab.title}</h3>}
              <StaticBlocks blocks={tab.content} documentId={documentId} />
            </section>
          ))}
        </div>
      ) : (
        versions &&
        versions.length > 0 && (
          <ol className="doc-history-list">
            {versions.map((version) => (
              <li key={version.n}>
                <button type="button" className="doc-history-item" onClick={() => void show(version.n)} disabled={opening !== null} aria-current={version.n === latest ? "true" : undefined}>
                  <span>
                    Version {version.n}
                    {version.n === latest && <small className="pill">Current</small>}
                  </span>
                  <small>
                    {sentLabel(version.at, Date.now())} · {version.byName ?? "someone"}
                    {opening === version.n && " · opening…"}
                  </small>
                </button>
              </li>
            ))}
          </ol>
        )
      )}
    </aside>
  );
}
