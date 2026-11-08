import { useEffect, useId, useState, type FormEvent } from "react";
import type { AgentServerInfo } from "../../shared/agents.ts";
import { MAX_SYSTEM_PROMPT } from "../../shared/system-prompt.ts";
import { errorMessage } from "../../shared/util.ts";
import { api } from "../api.ts";
import { AgentAvatar } from "../chat/people.tsx";
import { MenuButton } from "../layout.tsx";
import { piForm, piFormChanged, piServerWarning, piSettingsOf, piShared, togglePiShared, type PiForm } from "./pi-form.ts";
import { Switch } from "./ServersTable.tsx";

/**
 * pi's page, in the agent editor's style: its instructions (the owner's system prompt, for all their chats), where its
 * model is picked, the servers it reads for others in shared chats, and review before posting there. pi is no agent
 * definition: it is the main assistant of every chat and acts as its owner, so nothing here turns it off or shares it.
 */
export function PiPage({ onMenu }: { onMenu?: () => void }) {
  const ids = useId();
  const [servers, setServers] = useState<AgentServerInfo[] | null>(null);
  const [saved, setSaved] = useState<PiForm | null>(null);
  const [form, setForm] = useState<PiForm | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    Promise.all([api.systemPrompt(), api.piSettings(), api.agentServers()]).then(
      ([prompt, settings, list]) => {
        if (!live) return;
        const loaded = piForm(prompt.text, settings);
        setServers(list);
        setSaved(loaded);
        setForm(loaded);
      },
      (e) => live && setError(errorMessage(e)),
    );
    return () => {
      live = false;
    };
  }, []);

  const dirty = !!form && !!saved && !!servers && piFormChanged(form, saved, servers);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!form || !saved || !servers) return;
    setSaving(true);
    setError(null);
    setNotice(null);
    try {
      const prompt = form.instructions.trim() !== saved.instructions.trim() ? await api.setSystemPrompt(form.instructions) : { text: saved.instructions };
      const settings = await api.setPiSettings(piSettingsOf(form, servers));
      const next = piForm(prompt.text, settings);
      setSaved(next);
      setForm(next);
      setNotice("Saved: it applies from the next message pi answers, in every chat.");
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setSaving(false);
    }
  };

  const shared = form && servers ? piShared(form, servers) : new Set<string>();
  return (
    <div className="agent-page">
      <header className="agent-head">
        {onMenu && <MenuButton onClick={onMenu} />}
        <AgentAvatar />
        <div className="agent-head-text">
          <h2>pi</h2>
          <p>Your main assistant in every chat. It acts as you: your sign-ins, files and skills.</p>
        </div>
      </header>
      {notice && (
        <p className="skills-note agent-notice" role="status">
          {notice}
        </p>
      )}
      {!form || !servers ? (
        <p className={error ? "form-error" : "skills-note"}>{error ? `Could not open pi's settings: ${error}` : "Loading pi's settings…"}</p>
      ) : (
        <form className="agent-form" onSubmit={submit}>
          <div className="agent-field" data-field="instructions">
            <label className="agent-label" htmlFor={`${ids}-instructions`}>
              Instructions
              <small>Added to pi's built-in instructions in all your chats, the shared ones too. A chat can add its own from its header.</small>
            </label>
            <textarea
              id={`${ids}-instructions`}
              rows={7}
              value={form.instructions}
              onChange={(e) => setForm({ ...form, instructions: e.target.value })}
              maxLength={MAX_SYSTEM_PROMPT}
              placeholder="Answer briefly. Use metric units."
            />
          </div>
          <div className="agent-field" data-field="model">
            <span className="agent-label">
              Model and effort
              <small>Picked in each chat, under the message box: a new chat starts on the one you picked last, or on Auto.</small>
            </span>
          </div>
          <div className="agent-field" data-field="servers">
            <span className="agent-label">
              Servers
              <small>
                On your own messages pi reads every server and your files. "Shared chats" is what it reads when anyone else in a chat you share asks;
                the rest stays yours, and is shown only to you.
              </small>
            </span>
            <table className="agent-servers">
              {!servers.length && <caption className="skills-note">This deployment has no MCP servers.</caption>}
              <thead>
                <tr>
                  <th scope="col">Server</th>
                  <th scope="col">Your messages</th>
                  <th scope="col">Shared chats</th>
                </tr>
              </thead>
              <tbody>
                {servers.map((server) => {
                  const on = shared.has(server.name);
                  const warning = piServerWarning(server, on);
                  return (
                    <tr key={server.name}>
                      <th scope="row">
                        <span className="agent-server-name">{server.name}</span>
                        <small>{server.signsIn ? (server.signedIn ? "signed in as you" : "signs in as you · not yet") : "no sign-in"}</small>
                        {warning && <small className="agent-server-warn">{warning}</small>}
                      </th>
                      <td>
                        <Switch label={`${server.name} on your own messages: always`} on disabled onChange={() => {}} />
                      </td>
                      <td>
                        <Switch
                          label={`${server.name} in shared chats`}
                          on={on}
                          onChange={(value) => setForm(togglePiShared(form, servers, server.name, value))}
                        />
                      </td>
                    </tr>
                  );
                })}
                <tr className="agent-server-files">
                  <th scope="row">
                    <span className="agent-server-name">files</span>
                    <small>your private files</small>
                    <small>Read on your own messages. For anyone else, only the chat's own files: those attached or saved there.</small>
                  </th>
                  <td>
                    <Switch label="Your files on your own messages" on disabled onChange={() => {}} />
                  </td>
                  <td>
                    <Switch label="Your private files in shared chats: never" on={false} disabled onChange={() => {}} />
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
          <div className="agent-field" data-field="reviewBeforePosting">
            <label className="skill-toggle agent-review">
              <input type="checkbox" checked={form.review} onChange={(e) => setForm({ ...form, review: e.target.checked })} />
              <span>
                Review before posting
                <small>
                  In a chat you share, a reply pi builds on a server it does not share there, or on your private files, shows only to you first: show
                  it to the chat, or keep it.
                </small>
              </span>
            </label>
          </div>
          {error && <p className="form-error">{error}</p>}
          <div className="agent-form-actions">
            <button type="submit" className="primary" disabled={saving || !dirty}>
              {saving ? "Saving…" : "Save"}
            </button>
            {dirty && (
              <button type="button" disabled={saving} onClick={() => saved && setForm(saved)}>
                Undo changes
              </button>
            )}
          </div>
        </form>
      )}
    </div>
  );
}
