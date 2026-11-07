// How far a call in a chat may go (shared/limits.ts), as plain functions the tests run: what the input a pi run answers
// allows, and what an agent's turn allows. A run goes as far as its agent's autonomy (gate.ts reads it from the
// definition); a page runs as its author.

import { CHAT_TURN_KIND, type ChatTurnData } from "../../../shared/agents.ts";
import type { CallerLevel } from "../../../shared/limits.ts";
import { CHAT_MESSAGE_KIND, type ChatMessageData } from "../../../shared/protocol.ts";
import type { AgentTurn } from "../roster.ts";

/**
 * What one of pi's inputs allows: the owner's own message runs (4); anyone else's only proposes (2); a hand-off goes no
 * further than the turn that handed it, which runs only when it was the owner's own (a turn a person gave, never one of
 * a run's chains); an input of a kind the app does not know only proposes.
 */
export function inputLevel(
  entry: { kind: string; data?: unknown } | undefined,
  ownerUid: string,
  turn: (id: number) => Pick<AgentTurn, "byOwner" | "unattended"> | null,
): CallerLevel {
  if (entry?.kind === CHAT_MESSAGE_KIND) {
    const data = entry.data as ChatMessageData;
    return data.uid === ownerUid ? { level: 4, because: "on your own message" } : { level: 2, because: `on ${data.name}'s message` };
  }
  if (entry?.kind === CHAT_TURN_KIND) {
    const data = entry.data as ChatTurnData;
    const handing = turn(data.turn);
    if (handing?.byOwner && !handing.unattended) return { level: 4, because: "handed over on your own message" };
    return { level: 2, because: `handed over by ${data.calledBy.name}` };
  }
  return { level: 2, because: "on a message the app did not write down" };
}

/** The lowest of the levels a run's inputs allow: a run answering several goes no further than the least of them. */
export function lowestLevel(levels: readonly CallerLevel[]): CallerLevel | undefined {
  return levels.length ? levels.reduce((low, one) => (one.level < low.level ? one : low)) : undefined;
}

/**
 * What an agent's turn in a chat allows: its owner's own message runs (4); any other turn (a member's, a hand-off) only
 * proposes (2), and such a turn is offered no tool that changes data in the first place (allowedTools).
 */
export function turnLevel(turn: Pick<AgentTurn, "byOwner" | "calledBy">): CallerLevel {
  return turn.byOwner ? { level: 4, because: "on your own message" } : { level: 2, because: `on a turn ${turn.calledBy.name} gave it` };
}
