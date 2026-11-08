// Which sandbox (worker/sandbox.ts: a Durable Object with its own Linux container) a pi session's run_python and
// run_bash go to: pi's own sessions use the chat's, and each agent's sessions in the chat use one of the agent's own
// there, so nothing one leaves in its container's /workspace is there for another to read. Inside a sandbox, a run of
// another session than the one before starts with an empty /workspace (workspaceFresh). The chat's files stay shared
// through the chat's folder in the user's files, as before: only the containers are apart. Plain functions, so the
// tests run them.

/** Who a session is, as the chat object tells it (ChatAgent.#memoryAgent): pi (null), an agent, or nobody it knows. */
export type SandboxOwner = null | { agentId: string } | undefined;

/** The name of a chat's own sandbox object: pi's. */
export function sandboxName(uid: string, chatId: string): string {
  return `${uid}-${chatId}`;
}

/** The name of an agent's sandbox object in a chat: apart from pi's and from every other agent's. */
export function agentSandboxName(uid: string, chatId: string, agentId: string): string {
  return `${sandboxName(uid, chatId)}-agent-${agentId}`;
}

/** The sandbox a session's runs go to; null for a session the chat knows nobody of, which runs no code (fail closed). */
export function sandboxFor(owner: SandboxOwner, uid: string, chatId: string): string | null {
  if (owner === null) return sandboxName(uid, chatId);
  if (owner === undefined) return null;
  return agentSandboxName(uid, chatId, owner.agentId);
}

/**
 * Whether a run starts with an empty /workspace: when its session is not the one that ran last in this sandbox (an
 * agent's later turn, in a fork of its own), or the container just started. A session's own runs keep what they left.
 */
export function workspaceFresh(last: string | undefined, session: string, started: boolean): boolean {
  return started || last !== session;
}
