import { useEffect, useState, type ReactNode } from "react";
import {
  chatAllowsServer,
  DEFAULT_MESSAGE_TOKENS,
  MAX_DAILY_TOKENS,
  MIN_DAILY_TOKENS,
  type ChatAgentSettings,
  type ChatAgentSettingsView,
} from "../../shared/agent-settings.ts";
import type { ChatAgentView } from "../../shared/agents.ts";
import { errorMessage } from "../../shared/util.ts";
import { api } from "../api.ts";

/** A change to the settings, as the owner makes it: each field given replaces the stored one, null clears it. */
type SettingsChange = { [K in keyof ChatAgentSettings]?: ChatAgentSettings[K] | null };

const tokens = (n: number) => n.toLocaleString("en");

/**
 * A whole number the owner sets, saved by its own Save: empty clears it (back to `unset`, the placeholder). The
 * stored value (`value`) wins whenever it changes.
 */
export function NumberSetting({
  id,
  label,
  hint,
  value,
  min,
  max,
  unset,
  disabled,
  onSave,
}: {
  id: string;
  label: string;
  hint: ReactNode;
  value: number | undefined;
  min: number;
  max: number;
  unset: string;
  disabled: boolean;
  onSave: (value: number | null) => void;
}) {
  const [text, setText] = useState(value === undefined ? "" : String(value));
  useEffect(() => setText(value === undefined ? "" : String(value)), [value]);
  const number = Number(text.replace(/[,_\s]/g, ""));
  const empty = text.trim() === "";
  const valid = empty || (Number.isInteger(number) && number >= min && number <= max);
  const changed = (empty ? undefined : number) !== value;
  return (
    <form
      className="agent-budget"
      onSubmit={(e) => {
        e.preventDefault();
        if (valid && changed) onSave(empty ? null : number);
      }}
    >
      <label htmlFor={id}>
        {label}
        <small>{hint}</small>
      </label>
      <div className="agent-budget-row">
        <input id={id} inputMode="numeric" placeholder={unset} value={text} aria-invalid={!valid} onChange={(e) => setText(e.target.value)} />
        <button type="submit" disabled={disabled || !valid || !changed}>
          Save
        </button>
      </div>
      {!valid && (
        <small className="form-error">
          A whole number from {tokens(min)} to {tokens(max)}, or empty for {unset.toLowerCase()}.
        </small>
      )}
    </form>
  );
}

/**
 * The chat's agent settings, for its owner, under the list of agents to add: whether a router picks agents for a
 * message that names nobody, whether agents may speak up unprompted, which servers they may use here, a daily token
 * budget for every model call of the chat, today's use, a budget per message for its agents' turns, and the agents
 * muted here. Each change is saved at once.
 */
export function AgentSettingsPanel({
  chatId,
  view,
  agents,
}: {
  chatId: string;
  view: ChatAgentSettingsView | null;
  agents: readonly ChatAgentView[];
}) {
  const [shown, setShown] = useState(view);
  const [error, setError] = useState<string>();
  const [saving, setSaving] = useState(false);
  // The socket's word wins: it is what the chat holds now.
  useEffect(() => setShown(view), [view]);
  if (!shown) return <p className="agent-menu-empty">Loading settings…</p>;
  const { settings, available, today } = shown;

  const save = async (change: SettingsChange) => {
    setSaving(true);
    setError(undefined);
    try {
      setShown(await api.setAgentSettings(chatId, change));
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setSaving(false);
    }
  };
  const unmute = async (agentId: string) => {
    setError(undefined);
    try {
      await api.muteChatAgent(chatId, agentId, false);
    } catch (e) {
      setError(errorMessage(e));
    }
  };
  const allowed = (server: string) => chatAllowsServer(settings, server);
  const toggleServer = (server: string, on: boolean) => {
    const list = shown.servers.filter((name) => (name === server ? on : allowed(name)));
    void save({ servers: list.length === shown.servers.length ? null : list });
  };
  const muted = agents.filter((agent) => agent.muted);

  return (
    <div className="agent-settings">
      <div className="section-head">In this chat</div>
      <label className="skill-toggle" title={available.router ? undefined : "This deployment has no model to pick agents with."}>
        <input
          type="checkbox"
          checked={shown.router}
          disabled={saving || !available.router}
          onChange={(e) => void save({ router: e.target.checked })}
        />
        <span>
          Pick agents for messages that name nobody
          <small>{available.router ? "Up to two, from their job lines." : "Not available on this deployment."}</small>
        </span>
      </label>
      <label className="skill-toggle" title={available.speakUp ? undefined : "This deployment has no model to tell what an agent cares about."}>
        <input
          type="checkbox"
          checked={!!settings.speakUp}
          disabled={saving || !available.speakUp}
          onChange={(e) => void save({ speakUp: e.target.checked || null })}
        />
        <span>
          Let agents speak up
          <small>
            {available.speakUp
              ? "Agents whose owner allows it may post after a pause, or offer to pick up a question nobody answered."
              : "Not available on this deployment."}
          </small>
        </span>
      </label>
      {muted.length > 0 && (
        <ul className="agent-runs">
          {muted.map((agent) => (
            <li key={agent.id} className="agent-run">
              <span>@{agent.name} is muted here</span>
              <button type="button" className="link-button" onClick={() => void unmute(agent.id)}>
                Unmute
              </button>
            </li>
          ))}
        </ul>
      )}
      <NumberSetting
        id={`budget-${chatId}`}
        label="Daily token budget"
        hint={
          <>
            Every model call of this chat counts: {tokens(today.tokens)} tokens{today.costUsd > 0 && ` ($${today.costUsd.toFixed(2)})`} today (UTC).
          </>
        }
        value={settings.dailyTokens}
        min={MIN_DAILY_TOKENS}
        max={MAX_DAILY_TOKENS}
        unset="No budget"
        disabled={saving}
        onSave={(value) => void save({ dailyTokens: value })}
      />
      <NumberSetting
        id={`message-budget-${chatId}`}
        label="Token budget per message"
        hint="What the agents a message calls, and their hand-offs, may use together; past it, the rest of them do not run."
        value={settings.messageTokens}
        min={MIN_DAILY_TOKENS}
        max={MAX_DAILY_TOKENS}
        unset={`Default (${tokens(DEFAULT_MESSAGE_TOKENS)})`}
        disabled={saving}
        onSave={(value) => void save({ messageTokens: value })}
      />
      {shown.servers.length > 0 && (
        <fieldset className="agent-servers-here">
          <legend>
            Servers agents may use here
            <small>Each agent still uses only the servers its owner lets it.</small>
          </legend>
          {shown.servers.map((server) => (
            <label key={server} className="skill-toggle">
              <input type="checkbox" checked={allowed(server)} disabled={saving} onChange={(e) => toggleServer(server, e.target.checked)} />
              <span>{server}</span>
            </label>
          ))}
        </fieldset>
      )}
      {error && <div className="chat-error">{error}</div>}
    </div>
  );
}
