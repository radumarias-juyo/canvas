// A document's page (/d/:id): its title and tabs, the toolbar and the editor for its owner, the read-only view for
// everyone else (who can ask for a change), its edit requests, and its version history. Until live editing (phase 3) a
// save sends the whole tab with the version it was read at; a newer one is merged block by block (MergePrompt).

import type { Editor } from "@tiptap/core";
import { EditorContent, useEditor } from "@tiptap/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { errorMessage } from "../../shared/util.ts";
import { api } from "../api.ts";
import { Icon } from "../Icon.tsx";
import { AppLink, MenuButton, useDismiss } from "../layout.tsx";
import { useVisible } from "../sidebar.ts";
import { documentsApi, DocumentError, newerOf, type Newer } from "./api.ts";
import { EditRequestCard } from "./EditRequests.tsx";
import { HistoryPanel } from "./HistoryPanel.tsx";
import { MergePrompt } from "./MergePrompt.tsx";
import { diffBlocks, idsOfBlocks, mergeBlocks, withTab, type Block, type DocDocument, type DocNode, type DocumentView, type EditRequest, type Merged } from "./model.ts";
import { PrivateBlocks, privateKey } from "./private.ts";
import { Toolbar } from "./Toolbar.tsx";
import { editorExtensions } from "./views.tsx";
import "./documents.css";

/** How often the page reads the document again while pi is still writing it, and otherwise while it is in view. */
const WRITING_MS = 3_000;
const IDLE_MS = 30_000;

/** The blocks of a tab, as the editor holds them. */
const blocksOf = (editor: Editor): Block[] => (editor.getJSON().content ?? []) as Block[];
const docJson = (blocks: readonly DocNode[]) => ({ type: "doc", content: blocks.length ? [...blocks] : [{ type: "paragraph" }] });

/** Where the page stands with the document's object. */
type Loaded = { view: DocumentView; requests: EditRequest[] };

export function DocumentPage({ id, uid, navigate, onMenu }: { id: string; uid: string; navigate: (path: string) => void; onMenu?: () => void }) {
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [loadError, setLoadError] = useState<DocumentError | Error | null>(null);
  const read = useCallback(async () => {
    const [view, requests] = await Promise.all([documentsApi.get(id), documentsApi.requests(id).catch(() => [] as EditRequest[])]);
    return { view, requests };
  }, [id]);
  useEffect(() => {
    let live = true;
    setLoaded(null);
    setLoadError(null);
    read().then(
      (next) => live && setLoaded(next),
      (e: unknown) => live && setLoadError(e instanceof Error ? e : new Error(String(e))),
    );
    return () => {
      live = false;
    };
  }, [read]);

  if (loadError) return <DocumentProblem error={loadError} onMenu={onMenu} />;
  if (!loaded) {
    return (
      <main className="doc-page" aria-busy="true">
        <header className="doc-top">{onMenu && <MenuButton onClick={onMenu} />}</header>
        <p className="skills-note doc-loading">Opening the document…</p>
      </main>
    );
  }
  return <DocumentEditor key={id} initial={loaded} read={read} uid={uid} navigate={navigate} onMenu={onMenu} />;
}

/** A document that would not open: why, in words, and the way back. */
function DocumentProblem({ error, onMenu }: { error: Error; onMenu?: () => void }) {
  const status = error instanceof DocumentError ? error.status : 0;
  const [title, text] =
    status === 404
      ? ["This document is not here", "It may have been deleted, or the link is not quite right."]
      : status === 403
        ? ["You can't open this document", "Only the people in the chat it was made in, and those its owner shares it with, can read it."]
        : ["The document did not open", `${error.message}. Try again in a moment.`];
  return (
    <main className="doc-page">
      <header className="doc-top">{onMenu && <MenuButton onClick={onMenu} />}</header>
      <div className="doc-problem" role="alert">
        <h1>{title}</h1>
        <p>{text}</p>
      </div>
    </main>
  );
}

function DocumentEditor({
  initial,
  read,
  uid,
  navigate,
  onMenu,
}: {
  initial: Loaded;
  read: () => Promise<Loaded>;
  uid: string;
  navigate: (path: string) => void;
  onMenu?: () => void;
}) {
  const [view, setView] = useState(initial.view);
  const [requests, setRequests] = useState(initial.requests);
  // The version the owner's edits start from: what a save sends as ifRev, and a merge's base.
  const base = useRef<{ rev: number; doc: DocDocument }>({ rev: initial.view.rev, doc: initial.view.doc });
  const [tabId, setTabId] = useState(initial.view.doc.tabs[0]?.id ?? "");
  const tab = view.doc.tabs.find((each) => each.id === tabId) ?? view.doc.tabs[0];
  const owner = view.ownerUid === uid && view.mayEdit;
  const [suggesting, setSuggesting] = useState(false);
  const [bodyDirty, setDirty] = useState(false);
  // The title, which its owner edits in place: saved with the document.
  const [title, setTitle] = useState(initial.view.doc.title || initial.view.title);
  const [savedTitle, setSavedTitle] = useState(title);
  const dirty = bodyDirty || title !== savedTitle;
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<{ text: string; error?: boolean } | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [newer, setNewer] = useState<(Newer & { onSave: boolean }) | null>(null);
  const editable = owner || suggesting;

  const baseBlocks = useCallback(() => (base.current.doc.tabs.find((each) => each.id === tab?.id)?.content ?? []) as Block[], [tab?.id]);
  // The ids the other tabs hold: a block here never takes one (ids are unique in the whole document).
  const taken = useCallback(() => {
    const ids = new Set<string>();
    for (const each of base.current.doc.tabs) {
      ids.add(each.id);
      if (each.id !== tab?.id) for (const id of idsOfBlocks(each.content)) ids.add(id);
    }
    return ids;
  }, [tab?.id]);
  const editor = useEditor(
    {
      extensions: [...editorExtensions({ placeholder: owner ? "Write, or ask pi in the chat to draft it…" : "", documentId: view.id, taken }), PrivateBlocks],
      content: docJson(tab?.content ?? []),
      editable,
      editorProps: { attributes: { class: "doc-prose", "aria-label": `${view.title}${tab && view.doc.tabs.length > 1 ? `, ${tab.title}` : ""}`, role: "textbox", "aria-multiline": "true" } },
      onUpdate: ({ editor: e }) => setDirty(diffBlocks(tab?.id ?? "", baseBlocks(), blocksOf(e), base.current.rev).length > 0),
    },
    [tab?.id],
  );

  // Editable as the viewer may: the owner always, anyone else while they suggest a change.
  useEffect(() => {
    if (editor && editor.isEditable !== editable) editor.setEditable(editable);
  }, [editor, editable]);
  // Private sections marked, as the server names them.
  useEffect(() => {
    if (editor && !editor.isDestroyed) editor.view.dispatch(editor.state.tr.setMeta(privateKey, view.private).setMeta("addToHistory", false));
  }, [editor, view.private]);

  /** Take the version the server has (after a save, a restore, an approved request, pi's writing) as the base. */
  const adopt = useCallback(
    (next: DocumentView, replaceContent: boolean) => {
      base.current = { rev: next.rev, doc: next.doc };
      setView(next);
      if (replaceContent) setTitle(next.doc.title || next.title);
      setSavedTitle(next.doc.title || next.title);
      if (replaceContent && editor && !editor.isDestroyed) {
        const blocks = next.doc.tabs.find((each) => each.id === tab?.id)?.content ?? next.doc.tabs[0]?.content ?? [];
        editor.commands.setContent(docJson(blocks), { emitUpdate: false });
        setDirty(false);
      }
    },
    [editor, tab?.id],
  );

  const refresh = useCallback(async () => {
    const next = await read();
    setRequests(next.requests);
    if (next.view.rev === base.current.rev) {
      setView((was) => ({ ...was, title: next.view.title, private: next.view.private, mayEdit: next.view.mayEdit }));
      return;
    }
    // A newer version: taken as it is when nothing here is unsaved, else offered to merge.
    if (!dirty && !suggesting) adopt(next.view, true);
    else setNewer({ rev: next.view.rev, doc: next.view.doc, onSave: false });
  }, [read, dirty, suggesting, adopt]);

  // Read again while pi writes (its placeholders show), less often otherwise, only while the page is in view.
  const visible = useVisible();
  const writing = view.doc.tabs.some((each) => each.content.some((block) => block.type === "pending"));
  useEffect(() => {
    if (!visible || newer) return;
    const timer = setInterval(() => void refresh().catch(() => {}), writing ? WRITING_MS : IDLE_MS);
    return () => clearInterval(timer);
  }, [visible, writing, refresh, newer]);

  // Changes not saved: the browser asks before the page goes.
  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => event.preventDefault();
    addEventListener("beforeunload", warn);
    return () => removeEventListener("beforeunload", warn);
  }, [dirty]);

  const save = useCallback(async () => {
    if (!editor || !tab || !owner || saving) return;
    setSaving(true);
    setNotice(null);
    const doc = { ...withTab(base.current.doc, tab.id, blocksOf(editor)), title: title.trim() || "Untitled document" };
    try {
      const { rev } = await documentsApi.save(view.id, doc, base.current.rev);
      base.current = { rev, doc };
      setDirty(false);
      setTitle(doc.title);
      setSavedTitle(doc.title);
      setNotice({ text: `Saved · version ${rev}` });
      // The server's hashes for the blocks just saved, and anything it placeholders.
      void read().then((next) => next.view.rev === rev && adopt(next.view, false), () => {});
    } catch (e) {
      const stale = newerOf(e);
      if (stale) setNewer({ ...stale, onSave: true });
      else setNotice({ text: `Not saved: ${errorMessage(e)}`, error: true });
    } finally {
      setSaving(false);
    }
  }, [editor, tab, owner, saving, view.id, read, adopt, title]);

  // Ctrl/Cmd+S saves, while the page is open.
  useEffect(() => {
    if (!owner) return;
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
        event.preventDefault();
        void save();
      }
    };
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  }, [owner, save]);

  const merged: Merged | null = useMemo(() => {
    if (!newer || !editor || !tab) return null;
    const theirs = (newer.doc.tabs.find((each) => each.id === tab.id)?.content ?? []) as Block[];
    return mergeBlocks(baseBlocks(), blocksOf(editor), theirs);
  }, [newer, editor, tab, baseBlocks]);

  const merge = () => {
    if (!newer || !merged || !editor) return;
    base.current = { rev: newer.rev, doc: newer.doc };
    setView((was) => ({ ...was, rev: newer.rev, doc: newer.doc }));
    if (title === savedTitle) setTitle(newer.doc.title);
    setSavedTitle(newer.doc.title);
    editor.commands.setContent(docJson(merged.blocks), { emitUpdate: false });
    setDirty(diffBlocks(tab?.id ?? "", baseBlocks(), merged.blocks, newer.rev).length > 0);
    setNewer(null);
    setNotice({ text: "Merged onto the newer version: save to keep your changes." });
  };
  const discard = () => {
    if (!newer) return;
    adopt({ ...view, rev: newer.rev, doc: newer.doc }, true);
    setNewer(null);
    setSuggesting(false);
  };

  const sendRequest = async (note: string) => {
    if (!editor || !tab) return;
    const ops = diffBlocks(tab.id, baseBlocks(), blocksOf(editor), base.current.rev);
    if (!ops.length) {
      setNotice({ text: "Nothing changed yet: edit the document, then send." , error: true });
      return;
    }
    try {
      await documentsApi.request(view.id, ops, note.trim() || undefined);
      editor.commands.setContent(docJson(baseBlocks()), { emitUpdate: false });
      setDirty(false);
      setSuggesting(false);
      setNotice({ text: "Change requested: its owner approves or declines it." });
      setRequests(await documentsApi.requests(view.id).catch(() => requests));
    } catch (e) {
      setNotice({ text: `Not sent: ${errorMessage(e)}`, error: true });
    }
  };
  const cancelSuggesting = () => {
    editor?.commands.setContent(docJson(baseBlocks()), { emitUpdate: false });
    setDirty(false);
    setSuggesting(false);
  };

  const decide = async (rid: string, action: "approve" | "decline") => {
    try {
      await documentsApi.decide(view.id, rid, action);
    } catch (e) {
      if (e instanceof DocumentError && e.status === 409) throw new Error("The document changed since it was asked: it needs to be asked again.");
      throw e;
    }
    await refresh();
    setNotice({ text: action === "approve" ? "Approved: the change is in." : "Declined." });
  };

  const onImage = async (file: File) => {
    try {
      return (await documentsApi.image(view.id, file)).src;
    } catch (e) {
      setNotice({ text: `The image was not added: ${errorMessage(e)}`, error: true });
      return null;
    }
  };

  const allBlocks = view.doc.tabs.flatMap((each) => each.content) as Block[];
  const shownRequests = requests.filter((request) => (owner ? request.state === "pending" : request.by === uid)).slice(0, owner ? 20 : 5);
  const pendingCount = allBlocks.filter((block) => block.type === "pending").length;
  const status = saving ? "Saving…" : dirty ? (owner ? "Not saved" : "Your suggestion, not sent") : `Version ${view.rev}`;

  return (
    <main className={`doc-page${historyOpen ? " with-history" : ""}`}>
      <header className="doc-top">
        {onMenu && <MenuButton onClick={onMenu} />}
        <AppLink path={`/c/${view.chatId}`} navigate={navigate} className="doc-back">
          ← Its chat
        </AppLink>
        <span className="doc-status" aria-live="polite">
          {status}
        </span>
        <div className="doc-actions">
          <button type="button" onClick={() => setHistoryOpen(!historyOpen)} aria-expanded={historyOpen}>
            History
          </button>
          <ExportMenu id={view.id} />
          {owner ? (
            <button type="button" className="primary" onClick={() => void save()} disabled={!dirty || saving} title="Save (Ctrl+S)">
              {saving ? "Saving…" : dirty ? "Save" : "Saved"}
            </button>
          ) : (
            !suggesting && (
              <button type="button" className="primary" onClick={() => setSuggesting(true)}>
                Suggest a change
              </button>
            )
          )}
        </div>
      </header>
      <div className="doc-body">
        <article className="doc-sheet">
          {owner ? (
            <h1 className="doc-title">
              <input
                className="doc-title-input"
                value={title}
                onChange={(event) => setTitle(event.target.value)}
                maxLength={200}
                placeholder="Untitled document"
                aria-label="Title"
              />
            </h1>
          ) : (
            <h1 className="doc-title">{title || "Untitled document"}</h1>
          )}
          <p className="doc-byline">
            {owner ? "Yours" : `${view.ownerName ?? "Its owner"}'s document`}
            {!owner && " · read-only for you"}
            {pendingCount > 0 && <span className="doc-byline-writing"> · pi is writing, {pendingCount === 1 ? "1 section" : `${pendingCount} sections`} to go</span>}
          </p>
          <nav className="doc-tabs" role="tablist" aria-label="Tabs">
            {view.doc.tabs.map((each) => (
              <button
                key={each.id}
                type="button"
                role="tab"
                aria-selected={each.id === tab?.id}
                className="doc-tab"
                disabled={dirty && each.id !== tab?.id}
                title={dirty && each.id !== tab?.id ? "Save or undo your changes first" : undefined}
                onClick={() => setTabId(each.id)}
              >
                {each.title || "Tab"}
              </button>
            ))}
          </nav>
          {notice && (
            <p className={notice.error ? "form-error doc-notice" : "doc-notice"} role={notice.error ? "alert" : "status"}>
              {notice.text}
            </p>
          )}
          {newer && merged && editor && (
            <MergePrompt rev={newer.rev} merged={merged} mine={blocksOf(editor)} saving={newer.onSave} onMerge={merge} onDiscard={discard} />
          )}
          {shownRequests.length > 0 && (
            <section className="doc-requests" aria-label={owner ? "Changes waiting for you" : "Your requested changes"}>
              {shownRequests.map((request) => (
                <EditRequestCard
                  key={request.rid}
                  request={request}
                  blocks={allBlocks}
                  owner={owner}
                  mine={request.by === uid}
                  onDecide={owner ? (action) => decide(request.rid, action) : undefined}
                />
              ))}
            </section>
          )}
          {!owner && suggesting && <SuggestBar onSend={sendRequest} onCancel={cancelSuggesting} dirty={dirty} />}
          {editor && editable && <Toolbar editor={editor} onImage={owner ? onImage : undefined} people={api.people} />}
          {editor && <EditorContent editor={editor} className={`doc-editor${editable ? " editing" : ""}${suggesting ? " suggesting" : ""}`} />}
        </article>
        {historyOpen && (
          <HistoryPanel
            documentId={view.id}
            rev={view.rev}
            owner={owner}
            dirty={dirty}
            onClose={() => setHistoryOpen(false)}
            onRestored={(rev) => {
              setNotice({ text: `Restored as version ${rev}.` });
              void read().then((next) => adopt(next.view, true), () => {});
            }}
          />
        )}
      </div>
    </main>
  );
}

/** Someone other than the owner, suggesting: a note for the owner, and Send or Cancel. */
export function SuggestBar({ onSend, onCancel, dirty }: { onSend: (note: string) => Promise<void>; onCancel: () => void; dirty: boolean }) {
  const [note, setNote] = useState("");
  const [sending, setSending] = useState(false);
  return (
    <form
      className="doc-suggest"
      onSubmit={async (event) => {
        event.preventDefault();
        setSending(true);
        try {
          await onSend(note);
        } finally {
          setSending(false);
        }
      }}
    >
      <p>Edit the document below, then send it to its owner as a request. Nothing changes until they approve it.</p>
      <label>
        <span>A note for them (optional)</span>
        <input value={note} onChange={(event) => setNote(event.target.value)} maxLength={500} placeholder="Why this change" />
      </label>
      <div className="doc-suggest-actions">
        <button type="button" onClick={onCancel} disabled={sending}>
          Cancel
        </button>
        <button type="submit" className="primary" disabled={!dirty || sending}>
          {sending ? "Sending…" : "Send request"}
        </button>
      </div>
    </form>
  );
}

/** Export as Markdown, Word or PDF: what the viewer can see of it (the server leaves out what they may not). */
function ExportMenu({ id }: { id: string }) {
  const [open, setOpen] = useState(false);
  const box = useDismiss<HTMLDivElement>(open, setOpen);
  return (
    <div className="doc-export" ref={box}>
      <button type="button" onClick={() => setOpen(!open)} aria-expanded={open} aria-haspopup="menu">
        Export
        <Icon size={14} stroke={2}>
          <path d="m6 9 6 6 6-6" />
        </Icon>
      </button>
      {open && (
        <div className="doc-export-menu" role="menu">
          {(
            [
              ["md", "Markdown (.md)"],
              ["docx", "Word (.docx)"],
              ["pdf", "PDF"],
            ] as const
          ).map(([format, label]) => (
            <a key={format} role="menuitem" href={documentsApi.exportUrl(id, format)} download onClick={() => setOpen(false)}>
              {label}
            </a>
          ))}
        </div>
      )}
    </div>
  );
}
