// The Setup tab's servers table, apart so the tests render it without the rest of the form.

import type { AgentFiles, AgentServerInfo } from "../../shared/agents.ts";

/**
 * The servers table: each of the deployment's MCP servers with whether it signs in each user, and two switches, for
 * the agent itself and for shared chats. A server that signs in as the owner and is on for shared chats says that the
 * chat sees what the agent reads from it. The owner's private files close it (FilesRow), with the same two switches.
 */
export function ServersTable({
  servers,
  error,
  own,
  shared,
  name,
  onToggle,
  files,
  onFiles,
}: {
  servers: AgentServerInfo[] | null;
  error: string | null;
  own: Set<string>;
  shared: Set<string>;
  name: string;
  onToggle: (column: "servers" | "sharedServers", server: string, on: boolean) => void;
  /** The owner's files setting as it holds (agentFiles), and a change to it: taking them from the agent takes them from shared chats too. */
  files: AgentFiles;
  onFiles: (files: AgentFiles) => void;
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
        <FilesRow files={files} name={name} onChange={onFiles} />
      </tbody>
    </table>
  );
}

/**
 * Your private files, as a row of the table (allowedTools enforces it). "This agent": a turn you ask for reads and
 * writes them, and runs code on them, apart from the chat. "Shared chats": a turn anyone else in a shared chat gives it
 * may read them, and they see what it reads, as with a server that signs in as you. Never in a run, or unprompted.
 */
function FilesRow({ files, name, onChange }: { files: AgentFiles; name: string; onChange: (files: AgentFiles) => void }) {
  return (
    <tr className="agent-server-files">
      <th scope="row">
        <span className="agent-server-name">files</span>
        <small>your private files</small>
        {files.shared && (
          <small className="agent-server-warn">Anyone in a shared chat can make @{name || "it"} read your files, and sees what it reads.</small>
        )}
      </th>
      <td>
        <Switch label="Your files for this agent" on={files.own} onChange={(on) => onChange({ own: on, shared: on && files.shared })} />
      </td>
      <td>
        <Switch label="Your files in shared chats" on={files.shared} disabled={!files.own} onChange={(on) => onChange({ own: files.own, shared: on })} />
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
