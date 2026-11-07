import { useEffect, useId, useMemo, useRef, useState, type FormEvent, type KeyboardEvent, type ReactNode } from "react";
import type { AgentEvent } from "@earendil-works/pi-durable";
import { MAX_WINDOW_TEXT, type AgentWindowSession, type AgentWindowView, type SteerResult } from "../../shared/agent-window.ts";
import type { ChatAgentView } from "../../shared/agents.ts";
import { errorMessage } from "../../shared/util.ts";
import { api } from "../api.ts";
import { AgentAvatar } from "./people.tsx";
import { snapshotState, type ChatState } from "./useChat.ts";

/** How often the window reads its session again while the agent works, and while it is idle. */
const BUSY_MS = 1_500;
const IDLE_MS = 8_000;

/** A session's name in the window's list. */
export function sessionLabel(session: AgentWindowSession): string {
  if (session.kind === "shared") return "Shared with the chat";
  const turn = session.turn === undefined ? "" : ` #${session.turn}`;
  if (session.kind === "run") return session.turn === undefined ? "A run" : `Reply to a run${turn}`;
  const who = session.window ? "you, from here" : session.askedBy;
  return `Turn${turn}${who ? ` · ${who}` : ""}`;
}

/** What the owner's words did, in words. */
export function steerNote(result: SteerResult): string {
  if (result.mode === "steered") return "Sent into the turn it is working on: it reads it at its next step.";
  if (result.mode === "queued") return "It is busy with someone else's turn: yours starts right after, apart from the chat.";
  return "Started a turn of yours, apart from the chat: only its reply posts to the chat.";
}

/**
 * An agent's window, for its owner alone (shared/agent-window.ts): its sessions in this chat, the one shown with its
 * whole transcript (inputs, thoughts, tool calls and their results), read again every few seconds, faster while it
 * works; a composer whose words steer the turn of theirs it runs apart, or start one of theirs (never in the chat's
 * log); and a Stop while it works. `transcript` draws a session's state as the chat draws an agent's steps.
 */
export function AgentWindow({
  chatId,
  agent,
  onClose,
  onStop,
  transcript,
}: {
  chatId: string;
  agent: ChatAgentView;
  onClose: () => void;
  onStop?: () => void;
  transcript: (state: ChatState) => ReactNode;
}) {
  const title = useId();
  const [view, setView] = useState<AgentWindowView | null>(null);
  const [state, setState] = useState<ChatState | null>(null);
  const [picked, setPicked] = useState<string | undefined>();
  const [error, setError] = useState<string>();
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [note, setNote] = useState<string>();
  // Read again at once after a send, and when the agent starts or ends a turn.
  const [nudge, setNudge] = useState(0);
  const busy = agent.busy === true;
  const body = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const read = async () => {
      try {
        const next = await api.agentWindow(chatId, agent.id, picked);
        if (!live) return;
        setView(next);
        setError(undefined);
        const shown = next.shown;
        setState(shown ? snapshotState(shown.snapshot as AgentEvent, Date.now(), shown.runElapsedMs, shown.toolsElapsedMs) : null);
        const running = next.sessions.some((session) => session.running);
        timer = setTimeout(read, running || busy ? BUSY_MS : IDLE_MS);
      } catch (e) {
        if (!live) return;
        setError(errorMessage(e));
        timer = setTimeout(read, IDLE_MS);
      }
    };
    void read();
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [chatId, agent.id, picked, busy, nudge]);
  // Follow the bottom as it grows, unless the owner scrolled up to read.
  const count = state?.entries.length ?? 0;
  const partial = state?.partial;
  useEffect(() => {
    const el = body.current;
    if (el && el.scrollHeight - el.scrollTop - el.clientHeight < 120) el.scrollTop = el.scrollHeight;
  }, [count, partial]);
  const shownId = view?.shown?.session;
  const sessions = view?.sessions ?? [];
  const shownSession = useMemo(() => sessions.find((session) => session.id === shownId), [sessions, shownId]);
  const send = async (event?: FormEvent) => {
    event?.preventDefault();
    const said = text.trim();
    if (!said || sending) return;
    setSending(true);
    setError(undefined);
    try {
      const result = await api.steerAgent(chatId, agent.id, said);
      setText("");
      setNote(steerNote(result));
      // A new turn of theirs: show its session once it is made.
      if (result.mode !== "steered") setPicked(undefined);
      setNudge((n) => n + 1);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setSending(false);
    }
  };
  const onKey = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) void send();
    if (event.key === "Enter" && !event.shiftKey) event.preventDefault();
    if (event.key === "Escape") onClose();
  };
  return (
    <aside className="agent-window" role="dialog" aria-modal="false" aria-labelledby={title}>
      <header className="agent-window-head">
        <AgentAvatar badge={agent} working={busy} off={agent.off} />
        <div className="agent-window-title">
          <strong id={title}>@{agent.name}</strong>
          <small>Its window: only you see this, and what you send here is not posted in the chat.</small>
        </div>
        {busy && onStop && (
          <button type="button" className="working-stop" onClick={onStop} title={`Stop @${agent.name}`}>
            Stop
          </button>
        )}
        <button type="button" className="icon-button" onClick={onClose} aria-label="Close its window" title="Close">
          ×
        </button>
      </header>
      {sessions.length > 0 && (
        <nav className="agent-window-sessions" aria-label="Its sessions in this chat">
          {sessions.map((session) => (
            <button
              key={session.id}
              type="button"
              className={session.id === shownId ? "chip selected" : "chip"}
              aria-pressed={session.id === shownId}
              onClick={() => setPicked(session.id)}
            >
              {session.running && <span className="agent-window-dot" aria-label="working" />}
              {sessionLabel(session)}
            </button>
          ))}
        </nav>
      )}
      <div className="agent-window-body" ref={body}>
        {view === null && !error && <p className="agent-menu-empty">Loading…</p>}
        {shownSession && (
          <p className="agent-window-about">
            {shownSession.kind === "shared"
              ? "The session everyone's turns read: what the chat said, and the replies it posted."
              : "A turn apart from the chat: what it read here stays with you; only its reply went to the chat."}
          </p>
        )}
        {state && transcript(state)}
        {state && state.entries.length === 0 && !state.partial && <p className="agent-menu-empty">Nothing in this session yet.</p>}
      </div>
      <form className="agent-window-composer" onSubmit={send}>
        {note && <p className="agent-window-note">{note}</p>}
        {error && <div className="chat-error">{error}</div>}
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKey}
          maxLength={MAX_WINDOW_TEXT}
          rows={2}
          placeholder={busy ? `Steer @${agent.name} while it works…` : `Tell @${agent.name} what to do…`}
          aria-label={busy ? "Steer it" : "Tell it what to do"}
        />
        <button type="submit" className="primary" disabled={sending || !text.trim()}>
          {sending ? "Sending…" : busy ? "Steer" : "Send"}
        </button>
      </form>
    </aside>
  );
}
