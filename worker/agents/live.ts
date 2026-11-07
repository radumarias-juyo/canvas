// What a chat's sockets are sent of an agent's session while it has a turn: only that turn, so a socket that attaches
// mid-turn gets the turn's entries, never the agent's whole history, and nothing its owner set it up with.

import type { AgentEvent, AgentState, EntryRecord } from "@earendil-works/pi-durable";
import { CHAT_TURN_KIND, type ChatTurnData } from "../../shared/agents.ts";

/** Whether `entry` is the input that started turn `turn` in its agent's session. */
export function isTurnEntry(entry: Pick<EntryRecord, "kind" | "data">, turn: number): boolean {
  return entry.kind === CHAT_TURN_KIND && (entry.data as Partial<ChatTurnData> | undefined)?.turn === turn;
}

/** The entries from turn `turn`'s input on; none while that input is not among them (it is still being set up). */
export function turnEntries(entries: readonly EntryRecord[], turn: number): EntryRecord[] {
  const at = entries.findLastIndex((entry) => isTurnEntry(entry, turn));
  return at < 0 ? [] : entries.slice(at);
}

/** What the app reads of an agent session's state: its model and effort, never its instructions or tool lists. */
function shownAgent(agent: AgentState): AgentState {
  return { ...(agent.model && { model: agent.model }), ...(agent.thinkingLevel && { thinkingLevel: agent.thinkingLevel }) };
}

/** The entry an event carries, if any. */
function entryOf(event: AgentEvent): EntryRecord | undefined {
  if (event.type === "message_end" || event.type === "entry_appended") return event.entry;
  if (event.type === "tool_execution_end") return event.entry;
  return undefined;
}

/**
 * Follows one agent session's events for one of its turns, and passes on only what belongs to that turn: a snapshot cut
 * to the turn's entries (and its state to the model and effort), the entries from the turn's input on, and the run's
 * live events. Before the turn's input is placed (the session reads the chat's catch-up first), nothing is passed on:
 * that is the agent's context, not its work. The session's state changes, usage and inbox are left out.
 */
export class TurnFilter {
  #started = false;

  constructor(readonly turn: number) {}

  /** The events of one batch to send, in order; none when nothing in it is the turn's. */
  pass(events: readonly AgentEvent[]): AgentEvent[] {
    return events.flatMap((event): AgentEvent[] => {
      if (event.type === "snapshot") {
        const entries = turnEntries(event.entries, this.turn);
        this.#started ||= entries.length > 0;
        // A snapshot before the turn's input is placed may show the run before it, which is not this turn's.
        const run = this.#started ? event : { ...event, run: undefined, generation: undefined, tools: [], nestedTools: [] };
        return [{ ...run, entries, agent: shownAgent(event.agent), inbox: [] }];
      }
      if (event.type === "agent_changed" || event.type === "usage_changed" || event.type === "inbox_update" || event.type === "submission") return [];
      const entry = entryOf(event);
      if (entry && isTurnEntry(entry, this.turn)) this.#started = true;
      return this.#started ? [event] : [];
    });
  }
}
