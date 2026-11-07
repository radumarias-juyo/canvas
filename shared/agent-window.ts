// An agent's window: what its owner sees of one of their agents in a chat, and how they steer it (the owner alone: the
// chat's owner for their agents there, a member for their agent's seat). Its sessions in the chat (the one it shares
// with the chat, each turn's fork, the sessions of the runs that reply here) with their whole transcript, and a
// composer whose words go to the agent as its owner's, never into the chat's log.

/** The longest instruction the window takes. */
export const MAX_WINDOW_TEXT = 4_000;

/** How many of a session's newest entries the window shows. */
export const WINDOW_ENTRIES = 300;

/** One session of an agent's in the chat, as its window lists it. */
export interface AgentWindowSession {
  id: string;
  /** `shared`: the session the chat's turns read; `fork`: a turn's own, apart from the chat; `run`: a reply to a run's report. */
  kind: "shared" | "fork" | "run";
  /** The turn it served (a fork's, a run reply's), and who asked for it. */
  turn?: number;
  askedBy?: string;
  /** Its owner told it from the window. */
  window?: true;
  /** A turn runs in it now. */
  running: boolean;
}

/** What the window shows: the agent, its sessions newest first, and one session's transcript (pi's snapshot event). */
export interface AgentWindowView {
  agentId: string;
  name: string;
  /** It runs as a seat, in its owner's own object (a member's agent). */
  seat: boolean;
  sessions: AgentWindowSession[];
  /** The session shown, and its snapshot (an AgentEvent of type "snapshot", JSON) with how long its run and calls went. */
  shown?: { session: string; snapshot: unknown; runElapsedMs?: number; toolsElapsedMs?: Record<string, number> };
}

/** What the owner's words did: steered the turn running apart now, or started (or queued after the running one) a turn of their own. */
export interface SteerResult {
  mode: "steered" | "started" | "queued";
  turn: number;
}

/** The text of an instruction from the window, checked; null when it is not one. */
export function windowText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const text = value.trim();
  return text && text.length <= MAX_WINDOW_TEXT ? text : null;
}

/** The line a steering message is written as into the turn's session: its owner's words, as the model reads them. */
export function steerLine(ownerName: string, text: string): string {
  return `[${ownerName} · your owner, steering this turn from your window]: ${text}`;
}
