// The Setup tab's servers table, apart so the tests render it without the rest of the form.

import type { AgentServerInfo } from "../../shared/agents.ts";

/**
 * The servers table: each of the deployment's MCP servers with whether it signs in each user, and two switches, for
 * the agent itself and for shared chats. A server that signs in as the owner and is on for shared chats says that the
 * chat sees what the agent reads from it. The owner's private files close it, as a fixed row (FilesRow).
 */
export function ServersTable({
  servers,
  error,
  own,
  shared,
  name,
  onToggle,
}: {
  servers: AgentServerInfo[] | null;
  error: string | null;
  own: Set<string>;
  shared: Set<string>;
  name: string;
  onToggle: (column: "servers" | "sharedServers", server: string, on: boolean) => void;
}) {
  if (error) return <p className="form-error">Could not read the servers: {error}</p>;
  if (!servers) return <p className="skills-note">Reading the servers…</p>;
  return (
    <table className="agent-servers">
      {!servers.length && <caption className="skills-note">This deployment has no MCP servers: the agent works with what it is told and its tools.</caption>}
      <thead>
        <tr>
          <th scope="col">Server</th>
          <th scope="col">This agent</th>
          <th scope="col">Shared chats</th>
        </tr>
      </thead>
      <tbody>
        {servers.map((server) => {
          const mine = own.has(server.name);
          const theirs = shared.has(server.name) && mine;
          return (
            <tr key={server.name}>
              <th scope="row">
                <span className="agent-server-name">{server.name}</span>
                <small>{server.signsIn ? (server.signedIn ? "signed in as you" : "signs in as you · not yet") : "no sign-in"}</small>
                {server.signsIn && theirs && (
                  <small className="agent-server-warn">
                    Anyone in a shared chat can make @{name || "it"} read this as you, and sees what it reads.
                  </small>
                )}
              </th>
              <td>
                <Switch label={`${server.name} for this agent`} on={mine} onChange={(on) => onToggle("servers", server.name, on)} />
              </td>
              <td>
                <Switch
                  label={`${server.name} in shared chats`}
                  on={theirs}
                  disabled={!mine}
                  onChange={(on) => onToggle("sharedServers", server.name, on)}
                />
              </td>
            </tr>
          );
        })}
        <FilesRow />
      </tbody>
    </table>
  );
}

/**
 * Your private files, as a row of the table: fixed, as the app decides it in code (allowedTools), not a setting. A turn
 * you ask for reads them, apart from the chat; a turn anyone else asks for, or one nobody asked for, never does.
 */
function FilesRow() {
  return (
    <tr className="agent-server-files">
      <th scope="row">
        <span className="agent-server-name">files</span>
        <small>your private files</small>
        <small>Read only on a turn you ask for, apart from the chat: only its reply is posted. Never for anyone else, or in a run.</small>
      </th>
      <td>
        <Switch label="Your files for this agent: on a turn you ask for" on disabled onChange={() => {}} />
      </td>
      <td>
        <Switch label="Your files in shared chats: never" on={false} disabled onChange={() => {}} />
      </td>
    </tr>
  );
}

export function Switch({ label, on, disabled, onChange }: { label: string; on: boolean; disabled?: boolean; onChange: (on: boolean) => void }) {
  return (
    <label className="skill-toggle agent-switch" title={label}>
      <input type="checkbox" checked={on} disabled={disabled} onChange={(e) => onChange(e.target.checked)} aria-label={label} />
    </label>
  );
}
