import { useCallback, useEffect, useRef, useState, type ComponentType } from "react";
import type { AgentChatUse, AgentDefinition, AgentInput, SharedAgentView } from "../../shared/agents.ts";
import type { ChatSummary } from "../../shared/protocol.ts";
import { errorMessage, plural } from "../../shared/util.ts";
import { api } from "../api.ts";
import { AgentAvatar } from "../chat/people.tsx";
import { MenuButton, opensElsewhere } from "../layout.tsx";
import { stateLabel } from "./glance.ts";
import { agentPath, NEW_AGENT, type AgentPlace } from "./nav.ts";
import { SetupTab } from "./SetupTab.tsx";
import { dropAgent, putAgent, reloadAgents, useAgents } from "./store.ts";

/**
 * What the page shows: one of the user's own agents, a new one being made, or someone else's that a chat shares with
 * them (read-only: a change saves their own copy).
 */
export type AgentSubject =
  | { kind: "own"; agent: AgentDefinition }
  | { kind: "new" }
  | { kind: "shared"; agent: SharedAgentView; chatId: string; chatTitle?: string };

/** What every tab of the agent page is given. */
export interface AgentTabProps {
  subject: AgentSubject;
  /** The field to scroll to and focus as the tab opens (a draft card's Change). */
  field?: string;
  /**
   * Save the tab's changes: the user's own agent changed from the version it showed, a new one made, or for a shared
   * one their own copy. Resolves with what was saved; rejects with the reason, shown by the tab.
   */
  save: (fields: AgentInput) => Promise<AgentDefinition>;
  /** Say something under the header that outlasts the tab (which starts again with each version): a save, a conflict. */
  notice: (notice: PageNotice | null) => void;
}

/** A line under the page's header. */
export interface PageNotice {
  text: string;
  error?: boolean;
}

/** The optional fields the form can clear, as a copy's request says so: null is none (checkAgent). */
const CLEARED = { avatar: null, color: null, model: null, effort: null, servers: null, sharedServers: null } as unknown as Partial<AgentInput>;

/** A tab of the agent page. Later tabs (workflow and runs, limits, what it knows) add themselves here. */
export interface AgentTab {
  id: string;
  label: string;
  /** The fields it edits: a Change for one of them opens this tab. */
  fields: readonly string[];
  /** Whether it shows for this agent: some tabs are only for an agent that is saved, or the user's own. */
  shows?: (subject: AgentSubject) => boolean;
  Component: ComponentType<AgentTabProps>;
}

export const TABS: AgentTab[] = [
  {
    id: "setup",
    label: "Setup",
    fields: ["name", "job", "instructions", "avatar", "color", "model", "effort", "servers", "sharedServers"],
    Component: SetupTab,
  },
];

/** The tab a place opens: the one asked for, else the one that edits its field, else the first. */
export function tabFor(tabs: readonly AgentTab[], place: Pick<AgentPlace, "tab" | "field">): AgentTab {
  return tabs.find((tab) => tab.id === place.tab) ?? tabs.find((tab) => place.field && tab.fields.includes(place.field)) ?? tabs[0];
}

/**
 * An agent's page: its header (badge, name, job line, whether it is on, Turn on or off, Delete) and its tabs, of which
 * this one has Setup. Someone else's agent, shared in a chat, opens read-only, saying whose it is and that it runs as
 * them; their first change saves their own copy.
 */
export function AgentPage({
  place,
  chats,
  navigate,
  onMenu,
}: {
  place: AgentPlace;
  chats: readonly ChatSummary[];
  navigate: (path: string) => void;
  onMenu?: () => void;
}) {
  const { agents, error: listError } = useAgents();
  const [notice, setNotice] = useState<PageNotice | null>(null);
  // Another agent's page says nothing of this one's, unless a save here made it (a new agent, a copy): its notice stays.
  const madeHere = useRef<string | null>(null);
  useEffect(() => {
    if (madeHere.current === place.id) madeHere.current = null;
    else setNotice(null);
  }, [place.id]);
  const own = agents?.find((agent) => agent.id === place.id);
  // Someone else's agent, as the chat it was opened from shares it.
  const [shared, setShared] = useState<SharedAgentView | null>(null);
  const [sharedError, setSharedError] = useState<string | null>(null);
  const lookShared = place.id !== NEW_AGENT && agents !== null && !own && place.chat !== undefined;
  useEffect(() => {
    if (!lookShared || !place.chat) return;
    let live = true;
    setSharedError(null);
    api.sharedAgent(place.chat, place.id).then(
      (view) => live && setShared(view),
      (error: unknown) => live && setSharedError(errorMessage(error)),
    );
    return () => {
      live = false;
    };
  }, [lookShared, place.chat, place.id]);

  const chatTitle = place.chat && chats.find((chat) => chat.id === place.chat)?.title;
  const subject: AgentSubject | null =
    place.id === NEW_AGENT
      ? { kind: "new" }
      : own
        ? { kind: "own", agent: own }
        : shared && shared.id === place.id && place.chat
          ? { kind: "shared", agent: shared, chatId: place.chat, chatTitle }
          : null;

  const save = useCallback(
    async (fields: AgentInput): Promise<AgentDefinition> => {
      if (!subject) throw new Error("This agent is not loaded yet.");
      let saved: AgentDefinition;
      if (subject.kind === "own") saved = await api.saveAgent(subject.agent.id, { ...fields, version: subject.agent.version });
      else if (subject.kind === "new") saved = await api.createAgent(fields);
      // A copy takes what the form leaves out from the original: what the form cleared is said as cleared.
      else saved = await api.copyAgent(subject.chatId, subject.agent.id, { ...CLEARED, ...fields });
      putAgent(saved);
      void reloadAgents();
      if (subject.kind !== "own") {
        madeHere.current = saved.id;
        navigate(agentPath({ id: saved.id }));
      }
      return saved;
    },
    [subject, navigate],
  );

  const back = place.chat && (
    <a
      className="agent-back"
      href={`/c/${place.chat}`}
      onClick={(event) => {
        if (opensElsewhere(event)) return;
        event.preventDefault();
        navigate(`/c/${place.chat}`);
      }}
    >
      ← Back to {chatTitle ? `“${chatTitle}”` : "the chat"}
    </a>
  );

  if (!subject) {
    const failed = (lookShared && sharedError) || listError;
    const gone = agents !== null && !own && !lookShared;
    return (
      <div className="agent-page">
        {onMenu && <MenuButton onClick={onMenu} />}
        {back}
        <p className={failed || gone ? "form-error" : "skills-note"}>
          {failed ? `Could not open this agent: ${failed}` : gone ? "This agent is not yours, or it was deleted." : "Loading the agent…"}
        </p>
      </div>
    );
  }

  const tabs = TABS.filter((tab) => !tab.shows || tab.shows(subject));
  const tab = tabFor(tabs, place);
  return (
    <div className="agent-page">
      {back}
      <AgentHeader subject={subject} navigate={navigate} onMenu={onMenu} />
      {notice && (
        <p className={notice.error ? "form-error agent-notice" : "skills-note agent-notice"} role="status">
          {notice.text}
        </p>
      )}
      {tabs.length > 1 && (
        <nav className="agent-tabs" role="tablist" aria-label="Agent">
          {tabs.map((each) => (
            <button
              key={each.id}
              type="button"
              role="tab"
              aria-selected={each.id === tab.id}
              className={each.id === tab.id ? "agent-tab active" : "agent-tab"}
              onClick={() => navigate(agentPath({ id: place.id, tab: each.id, chat: place.chat }))}
            >
              {each.label}
            </button>
          ))}
        </nav>
      )}
      <div role="tabpanel" aria-label={tab.label}>
        {/* A new tab state for each agent and version: a save, or a change elsewhere, shows the definition as it is now. */}
        <tab.Component
          key={subject.kind === "new" ? NEW_AGENT : `${subject.agent.id}:${subject.agent.version}`}
          subject={subject}
          field={place.field}
          save={save}
          notice={setNotice}
        />
      </div>
    </div>
  );
}

/** The page's top: badge, name, job line, the state pill, and for the user's own agent Turn on or off and Delete. */
function AgentHeader({ subject, navigate, onMenu }: { subject: AgentSubject; navigate: (path: string) => void; onMenu?: () => void }) {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [deleting, setDeleting] = useState<AgentChatUse[] | null>(null);
  if (subject.kind === "new") {
    return (
      <header className="agent-head">
        {onMenu && <MenuButton onClick={onMenu} />}
        <div className="agent-head-text">
          <h2>New agent</h2>
          <p>A helper with its own name, job and instructions, that people call in a chat with @name.</p>
        </div>
      </header>
    );
  }
  const { agent } = subject;
  const turn = async (on: boolean) => {
    if (subject.kind !== "own") return;
    setBusy(true);
    setError(null);
    try {
      putAgent(await api.setAgentEnabled(subject.agent, on));
    } catch (e) {
      setError(errorMessage(e));
      void reloadAgents();
    } finally {
      setBusy(false);
    }
  };
  const askDelete = async () => {
    setError(null);
    try {
      setDeleting(await api.agentChats(agent.id));
    } catch (e) {
      setError(errorMessage(e));
    }
  };
  const remove = async () => {
    setBusy(true);
    try {
      await api.deleteAgent(agent.id);
      dropAgent(agent.id);
      void reloadAgents();
      navigate("/");
    } catch (e) {
      setError(errorMessage(e));
      setBusy(false);
    }
  };
  const mine = subject.kind === "own" ? subject.agent : null;
  const state = mine && stateLabel(mine);
  return (
    <header className="agent-head">
      {onMenu && <MenuButton onClick={onMenu} />}
      <AgentAvatar badge={agent} />
      <div className="agent-head-text">
        <h2>{agent.name}</h2>
        <p>{agent.job}</p>
      </div>
      <div className="agent-head-actions">
        {mine && state ? (
          <>
            <span className={`pill agent-state ${state.tone}`}>{state.text}</span>
            <button type="button" className={mine.enabled ? undefined : "primary"} disabled={busy} onClick={() => void turn(!mine.enabled)}>
              {mine.enabled ? "Turn off" : "Turn on"}
            </button>
            <button type="button" disabled={busy} onClick={() => void askDelete()}>
              Delete
            </button>
          </>
        ) : (
          subject.kind === "shared" && <span className="pill agent-state off">{subject.agent.ownerName}’s · read-only</span>
        )}
      </div>
      {error && <p className="form-error agent-head-note">{error}</p>}
      {deleting && (
        <div className="agent-confirm" role="alertdialog" aria-label={`Delete @${agent.name}?`}>
          <p>
            <strong>Delete @{agent.name}?</strong>{" "}
            {deleting.length
              ? `It leaves ${plural(deleting.length, "chat")} it is in: ${deleting.map((use) => `“${use.title}”`).join(", ")}. Its past replies stay in them.`
              : "It is in no chat."}{" "}
            This cannot be undone.
          </p>
          <div className="skill-form-actions">
            <button type="button" className="danger" disabled={busy} onClick={() => void remove()}>
              Delete
            </button>
            <button type="button" disabled={busy} onClick={() => setDeleting(null)}>
              Cancel
            </button>
          </div>
        </div>
      )}
    </header>
  );
}
