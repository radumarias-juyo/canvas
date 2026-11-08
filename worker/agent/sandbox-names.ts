// Which sandbox (worker/sandbox.ts: a Durable Object with its own Linux container) a pi session's run_python and
// run_bash go to: pi's own sessions use the chat's, and each agent's sessions in the chat use one of the agent's own
// there, so nothing one leaves in its container's /workspace is there for another to read. Inside a sandbox, a run of
// another session than the one before starts with an empty /workspace (workspaceFresh), and a session's runs are keyed
// by whom they answer too (sandboxSession): pi's conversation is one session for the owner and for everyone else, so a
// run on someone else's message never finds what a run on the owner's own left there, nor the other way round. The
// chat's files stay shared through the chat's folder in the user's files, as before: only the containers are apart.
// Plain functions, so the tests run them.

/**
 * Who a session is, as the chat object tells it (ChatAgent.#memoryAgent): pi (null), an agent (`byOwner`: on a turn its
 * owner asked for), or nobody it knows.
 */
export type SandboxOwner = null | { agentId: string; byOwner?: boolean } | undefined;

/** Where a session's runs go: the sandbox object, and the session as the sandbox keys /workspace by (sandboxSession). */
export interface SandboxTarget {
  name: string;
  session: string;
}

/** What a session's key in the sandbox ends with on a run that answers anyone but the owner (sandboxSession). */
export const OTHERS_SUFFIX = ":others";

/**
 * The session a run is keyed by in its sandbox: pi's on a run that answers anyone but the owner (`answersOthers`), and
 * an agent's on a turn its owner did not ask for (which gets no sandbox tools: in case one ever does), end with
 * OTHERS_SUFFIX. pi's conversation is the same for the owner's runs and for anyone else's, so without it a member's run
 * would read what the owner's left in /workspace (their private files' copies, their script): the audience switching
 * either way is another session, in a fresh container (audienceSwitched).
 */
export function sandboxSession(owner: SandboxOwner, session: string, answersOthers: boolean): string {
  const others = owner === null ? answersOthers : owner?.byOwner !== true;
  return others ? `${session}${OTHERS_SUFFIX}` : session;
}

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

/**
 * Whether a run answers someone else than the last run in its sandbox did (sandboxSession), or nothing tells whom that
 * one answered: then the container starts afresh, as /workspace alone is not all a run leaves (its /tmp, its home, a
 * process it left running).
 */
export function audienceSwitched(last: string | undefined, session: string): boolean {
  return last === undefined || last.endsWith(OTHERS_SUFFIX) !== session.endsWith(OTHERS_SUFFIX);
}

/** The sandbox's working directory. */
export const WORKSPACE = "/workspace";

/** The scripts a run is written to (Sandbox.runPython, runBash): removed before each run, whichever it is. */
export const ENTRY_SCRIPTS = ["main.py", "run.sh"] as const;

/** What empties /workspace for a run of another session (workspaceFresh). */
export const WIPE_COMMAND: readonly string[] = ["sh", "-c", `find ${WORKSPACE} -mindepth 1 -delete`];

/**
 * What every run starts with, after the wipe if any: fresh ./files, ./skills and ./out (made with `dirs`, passed as
 * arguments so their names need no quoting), and neither entry script, so the one it writes is the only one there.
 */
export function prepareCommand(dirs: readonly string[]): string[] {
  const gone = [`${WORKSPACE}/files`, `${WORKSPACE}/skills`, `${WORKSPACE}/out`, ...ENTRY_SCRIPTS.map((name) => `${WORKSPACE}/${name}`)];
  return ["sh", "-c", `rm -rf ${gone.join(" ")} && mkdir -p "$@"`, "sh", ...dirs];
}
