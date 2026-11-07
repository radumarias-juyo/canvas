// An agent's window (shared/agent-window.ts), on the chat's side: who may open it, where its sessions are, and which
// of them it lists. In plain functions, so the tests run them.

import type { AgentWindowSession } from "../../shared/agent-window.ts";
import { chatAgentName } from "../chat-name.ts";
import type { ChatRoster, RosterEntry } from "./roster.ts";
import { seatChatId } from "./seats/names.ts";

/** How many of an agent's newest turns its window lists the sessions of. */
const WINDOW_TURNS = 30;

/** Why someone may not open an agent's window, or steer it: one not theirs (the chat's owner's of a member's seat too). */
export const NOT_YOUR_AGENT = "Only the agent's owner can open its window.";

/**
 * Where `uid`'s window on agent `agentId` of chat `chatId` (whose owner is `chatOwner`) is read: the chat's object for
 * the owner (their agents run there; it refuses one of a member's), and for anyone else their own object of that agent's
 * seat in this room (seatChatId: one per agent and room), never another room's. Named after `uid` from the verified
 * token, so nobody reaches another person's seat.
 */
export async function windowObject(chatOwner: string, uid: string, chatId: string, agentId: string): Promise<{ room: true } | { seat: string }> {
  if (chatOwner === uid) return { room: true };
  return { seat: chatAgentName(uid, await seatChatId(agentId, { ownerUid: chatOwner, chatId })) };
}

/** The roster entry of `uid`'s own agent that runs in the chat's object; null for any other (a member's seat among them). */
export function ownWindowEntry(roster: ChatRoster, agentId: string, uid: string): RosterEntry | null {
  const entry = roster.get(agentId);
  return entry?.ownerUid === uid && entry.seat === undefined ? entry : null;
}

/**
 * The sessions an agent of the chat's object's has here, as its window lists them: the one the chat's turns read, each
 * newest turn's own (a fork, a reply to a run's report), and its runs' sessions (`runs`, when this chat is its home),
 * without one twice.
 */
export function roomWindowSessions(
  roster: ChatRoster,
  entry: RosterEntry,
  runs: readonly { session: string; running: boolean }[] = [],
): AgentWindowSession[] {
  const turns = roster.recentTurns(entry.agentId, WINDOW_TURNS);
  const running = (turn: { status: string }) => turn.status === "running";
  const own = turns.flatMap((turn): AgentWindowSession[] =>
    turn.session === undefined
      ? []
      : [
          {
            id: turn.session,
            kind: turn.forked ? "fork" : "run",
            turn: turn.id,
            askedBy: turn.calledBy.name,
            ...(turn.calledBy.window && { window: true as const }),
            running: running(turn),
          },
        ],
  );
  const shared: AgentWindowSession = {
    id: entry.session,
    kind: "shared",
    running: turns.some((turn) => turn.session === undefined && running(turn)),
  };
  const seen = new Set<string>();
  return [shared, ...own, ...runs.map((run): AgentWindowSession => ({ id: run.session, kind: "run", running: run.running }))].filter((one) => {
    if (seen.has(one.id)) return false;
    seen.add(one.id);
    return true;
  });
}
