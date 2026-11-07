import { useEffect, useState, type FormEvent } from "react";
import type { DreamRecord, NoteWhy } from "../../shared/dream.ts";
import { MAX_NOTE_CHARS, inUse, scopeLabel, waitsForConfirm, type MemoryNoteView } from "../../shared/memory.ts";
import { errorMessage, plural } from "../../shared/util.ts";
import { api } from "../api.ts";
import { act } from "./Notes.tsx";
import { reloadMemory, type DreamsView } from "./store.ts";

/** A dream's day as a heading says it: "Last night" for the newest nightly one, else its date; "Dream now" for one pressed. */
export function dreamWhen(record: Pick<DreamRecord, "day" | "at">): string {
  if (record.day.startsWith("now:")) return `Dream now, ${new Date(record.at).toLocaleString([], { dateStyle: "medium", timeStyle: "short" })}`;
  const [year, month, day] = record.day.split("-").map(Number);
  return `The night after ${new Date(year, month - 1, day).toLocaleDateString([], { weekday: "long", day: "numeric", month: "long" })}`;
}

/** What a dream did, in a line: why it learned nothing, or what it saved, retired and left to confirm. */
export function dreamLine(record: DreamRecord): string {
  if (record.status === "quiet") return record.reason ?? "Nothing to learn from that day.";
  if (record.status === "skipped") return `Skipped: ${record.reason ?? "it could not run."}`;
  if (record.status === "failed" && !record.learned.length && !record.waiting.length) return `Failed: ${record.reason ?? "it could not run."}`;
  const parts = [
    record.learned.length && `learned ${plural(record.learned.length, "note")}`,
    record.waiting.length && `${plural(record.waiting.length, "note")} to confirm`,
    record.retired.length && `retired ${plural(record.retired.length, "note")}`,
  ].filter(Boolean);
  return parts.length ? `${parts.join(", ")}.`.replace(/^./, (first) => first.toUpperCase()) : "Nothing worth keeping.";
}

/** A dream's cost, as the summary shows it. */
export function dreamCost(record: Pick<DreamRecord, "costUsd" | "tokens">): string {
  if (!record.tokens && !record.costUsd) return "no model call";
  return `$${record.costUsd < 0.01 ? record.costUsd.toFixed(4) : record.costUsd.toFixed(2)} · ${record.tokens.toLocaleString()} tokens`;
}

/** Where a note's why came from, in words: how many lines and signals, of which chats. */
export function citesText(why: NoteWhy, note: Pick<MemoryNoteView, "chatId" | "chatTitle">): string {
  const chats = [...new Set(why.cites.map((cite) => cite.chatId))];
  const lines = why.cites.filter((cite) => !cite.signal).length;
  const signals = why.cites.filter((cite) => cite.signal);
  const named = chats.map((chatId) => (chatId === note.chatId && note.chatTitle ? `“${note.chatTitle}”` : "a chat"));
  const what = [lines && plural(lines, "message"), signals.length && signals.map((cite) => cite.signal!.replace(/_/g, " ")).join(", ")].filter(Boolean);
  return `From ${what.join(" and ") || "the day"} in ${[...new Set(named)].join(", ")}`;
}

/** One note a dream wrote: its text, why, how sure, and Keep (confirm, or keep from being retired), Edit, Forget. */
function OvernightNote({ note }: { note: MemoryNoteView }) {
  const [editing, setEditing] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const run = async (action: () => Promise<unknown>) => {
    setBusy(true);
    const failed = await act(action);
    setBusy(false);
    setError(failed);
    return !failed;
  };
  const waiting = waitsForConfirm(note);
  const save = async (event: FormEvent) => {
    event.preventDefault();
    if (editing === null) return;
    if (editing.trim() === note.text || (await run(() => api.changeNote(note.id, { text: editing, ...(waiting && { confirmed: true }) })))) setEditing(null);
  };
  return (
    <li className={waiting ? "memory-note unconfirmed" : "memory-note"}>
      {editing !== null ? (
        <form className="memory-edit" onSubmit={save}>
          <textarea autoFocus rows={2} maxLength={MAX_NOTE_CHARS} aria-label="Note" value={editing} onChange={(event) => setEditing(event.target.value)} />
          <div className="skill-form-actions">
            <button type="submit" className="primary" disabled={busy || !editing.trim()}>
              {waiting ? "Save and keep" : "Save"}
            </button>
            <button type="button" onClick={() => setEditing(null)}>
              Cancel
            </button>
          </div>
        </form>
      ) : (
        <p className="memory-text">{note.text}</p>
      )}
      {note.why && (
        <p className="dream-why">
          {note.why.text && <span>{note.why.text}</span>}
          <span>{citesText(note.why, note)}</span>
        </p>
      )}
      <div className="memory-meta">
        <span className="pill">{scopeLabel(note)}</span>
        {waiting && <span className="pill review">To confirm</span>}
        {note.kind === "fact" && <span className="pill">Fact</span>}
        {note.pinned && <span className="pill">Kept</span>}
        {note.confidence !== undefined && <span>{Math.round(note.confidence * 100)}% sure</span>}
        <span>{note.uses ? `Read ${plural(note.uses, "time")}` : "Not read yet"}</span>
      </div>
      {editing === null && (
        <div className="memory-actions">
          {waiting ? (
            <button type="button" className="primary" disabled={busy} onClick={() => void run(() => api.changeNote(note.id, { confirmed: true }))}>
              Keep
            </button>
          ) : (
            !note.pinned && (
              <button type="button" disabled={busy} title="Kept for good: never retired" onClick={() => void run(() => api.changeNote(note.id, { pinned: true }))}>
                Keep
              </button>
            )
          )}
          <button type="button" disabled={busy} onClick={() => setEditing(note.text)}>
            Edit
          </button>
          <button
            type="button"
            disabled={busy}
            title={waiting ? "Not kept: nothing read it yet" : "Read no more, until you bring it back"}
            onClick={() => void run(() => api.forgetNote(note.id))}
          >
            Forget
          </button>
        </div>
      )}
      {error && <p className="form-error">{error}</p>}
    </li>
  );
}

/**
 * "Learned overnight": what one subject (pi, or one of the user's agents) learns from how people worked with it, in a
 * nightly dream. Whether it learns, the newest dream's summary (what it learned, retired and left to confirm, and what
 * it cost), the notes it wrote with why each, and Dream now to try it.
 */
export function LearnedOvernight({
  subject,
  who,
  notes,
  dreams,
  learns,
  onLearns,
  about,
}: {
  /** "pi", or the agent's id. */
  subject: string;
  /** "pi", or "@name". */
  who: string;
  /** The user's notes: this shows those the subject's dreams wrote. */
  notes: readonly MemoryNoteView[];
  dreams: DreamsView | null;
  learns: boolean;
  onLearns: (learns: boolean) => Promise<unknown>;
  /** What it learns from, and where its notes go, in a sentence. */
  about: string;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const after = dreams?.nowAfter[subject];
  useEffect(() => {
    if (!after) return;
    const timer = setTimeout(() => setNow(Date.now()), Math.max(0, after - Date.now()) + 500);
    return () => clearTimeout(timer);
  }, [after]);
  const records = dreams?.dreams[subject] ?? [];
  const last = records[0];
  const mine = notes.filter((note) => note.source === "overnight" && (subject === "pi" ? !note.agentId && note.learnedBy === "pi" : note.agentId === subject));
  const used = mine.filter(inUse).sort((a, b) => Number(a.confirmed) - Number(b.confirmed) || b.updatedAt - a.updatedAt);
  const retired = last ? mine.filter((note) => !inUse(note) && last.retired.includes(note.id)) : [];
  const waitNow = after !== undefined && after > now;
  const run = async (action: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (failed) {
      setError(errorMessage(failed));
    } finally {
      setBusy(false);
      void reloadMemory();
    }
  };
  return (
    <section className="dream" aria-label="Learned overnight">
      <div className="dream-head">
        <div>
          <h3>Learned overnight</h3>
          <p className="skills-note">{about}</p>
        </div>
        <div className="dream-controls">
          <label className="skill-toggle">
            <input type="checkbox" checked={learns} disabled={busy} onChange={(event) => void run(() => onLearns(event.target.checked))} />
            {who === "pi" ? "pi learns overnight" : "Learns overnight"}
          </label>
          <button
            type="button"
            disabled={busy || waitNow}
            title={waitNow ? `Again after ${new Date(after!).toLocaleTimeString([], { timeStyle: "short" })}` : "Dream over the last day now"}
            onClick={() => void run(() => api.dreamNow(subject))}
          >
            {busy ? "Dreaming…" : "Dream now"}
          </button>
        </div>
      </div>
      {error && <p className="form-error">{error}</p>}
      {last ? (
        <div className={`dream-summary ${last.status}`}>
          <strong>{dreamWhen(last)}</strong>
          {last.summary && <p>{last.summary}</p>}
          <p className="dream-counts">
            <span>{dreamLine(last)}</span>
            <span>{dreamCost(last)}</span>
          </p>
        </div>
      ) : (
        <p className="skills-note">
          {learns
            ? `No dream yet: ${who} dreams around 03:00 your time after a day it worked${dreams?.settings.timeZone ? ` (${dreams.settings.timeZone})` : ""}.`
            : `${who} does not learn overnight.`}
        </p>
      )}
      {used.length > 0 && (
        <ul className="memory-list">
          {used.map((note) => (
            <OvernightNote key={note.id} note={note} />
          ))}
        </ul>
      )}
      {retired.length > 0 && (
        <details className="dream-retired">
          <summary>Retired by the last dream ({retired.length})</summary>
          <ul className="memory-list">
            {retired.map((note) => (
              <li key={note.id} className="memory-note forgotten">
                <p className="memory-text">{note.text}</p>
                <div className="memory-actions">
                  <button type="button" onClick={() => void act(() => api.restoreNote(note.id))}>
                    Bring back
                  </button>
                </div>
              </li>
            ))}
          </ul>
        </details>
      )}
    </section>
  );
}
