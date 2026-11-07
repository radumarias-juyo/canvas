import { useEffect, useState } from "react";
import {
  chatAllowsServer,
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
 * The chat's agent settings, for its owner, under the list of agents to add: whether a router picks agents for a
 * message that names nobody, whether agents may speak up unprompted, which servers they may use here, a daily token
 * budget for every model call of the chat, today's use, and the agents muted here. Each change is saved at once.
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
  const [budget, setBudget] = useState(() => (view?.settings.dailyTokens ? String(view.settings.dailyTokens) : ""));
  useEffect(() => setBudget(view?.settings.dailyTokens ? String(view.settings.dailyTokens) : ""), [view?.settings.dailyTokens]);
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
  const budgetValue = Number(budget.replace(/[,_\s]/g, ""));
  const budgetValid = budget.trim() === "" || (Number.isInteger(budgetValue) && budgetValue >= MIN_DAILY_TOKENS && budgetValue <= MAX_DAILY_TOKENS);
  const budgetChanged = (budget.trim() === "" ? undefined : budgetValue) !== settings.dailyTokens;
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
      <form
        className="agent-budget"
        onSubmit={(e) => {
          e.preventDefault();
          if (budgetValid && budgetChanged) void save({ dailyTokens: budget.trim() === "" ? null : budgetValue });
        }}
      >
        <label htmlFor={`budget-${chatId}`}>
          Daily token budget
          <small>
            Every model call of this chat counts: {tokens(today.tokens)} tokens{today.costUsd > 0 && ` ($${today.costUsd.toFixed(2)})`} today (UTC).
          </small>
        </label>
        <div className="agent-budget-row">
          <input
            id={`budget-${chatId}`}
            inputMode="numeric"
            placeholder="No budget"
            value={budget}
            aria-invalid={!budgetValid}
            onChange={(e) => setBudget(e.target.value)}
          />
          <button type="submit" disabled={saving || !budgetValid || !budgetChanged}>
            Save
          </button>
        </div>
        {!budgetValid && (
          <small className="form-error">
            A whole number from {tokens(MIN_DAILY_TOKENS)} to {tokens(MAX_DAILY_TOKENS)}, or empty for none.
          </small>
        )}
      </form>
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
