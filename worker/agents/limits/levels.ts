// How far a call in a chat may go (shared/limits.ts), as plain functions the tests run: what the input a pi run answers
// allows, and what an agent's turn allows. A run goes as far as its agent's autonomy (gate.ts reads it from the
// definition); a page runs as its author.

import { CHAT_TURN_KIND, mayUseServer, type AgentDefinition, type ChatTurnData } from "../../../shared/agents.ts";
import { chatAllowsServer } from "../../../shared/agent-settings.ts";
import type { CallerLevel } from "../../../shared/limits.ts";
import { CHAT_MESSAGE_KIND, type ChatMessageData } from "../../../shared/protocol.ts";
import type { AgentTurn } from "../roster.ts";
import type { SeatTurn } from "../seats/link.ts";
import type { SeatTurnIn } from "../seats/seat.ts";
import type { Caller, GateCall } from "./gate.ts";

/**
 * What one of pi's inputs allows: the chat owner's own message runs (4), but not their Yes to an offer, which only drafts
 * (its tools are narrowed to reading and agent_propose; anything else that changes data only proposes); anyone else's
 * only proposes (2); an input of a kind the app does not know only proposes. A hand-off runs (4) only when the turn that
 * handed it is the chat owner's own (`ownersChain`: their own message, directly, to one of their own agents run here,
 * never a member's seat or a run's chain) and ran on it (turnLevel); a member's agent's hand-off, on its owner's own
 * message too, only proposes: pi acts as the chat's owner, and a member never gives it their level.
 */
export function inputLevel(
  entry: { kind: string; data?: unknown } | undefined,
  ownerUid: string,
  turn: (id: number) => Pick<AgentTurn, "byOwner" | "calledBy" | "unattended" | "ownersChain"> | null,
): CallerLevel {
  if (entry?.kind === CHAT_MESSAGE_KIND) {
    const data = entry.data as ChatMessageData;
    if (data.uid !== ownerUid) return { level: 2, because: `on ${data.name}'s message` };
    return data.drafts ? { level: 2, because: YES_ONLY_DRAFTS } : { level: 4, because: "on your own message" };
  }
  if (entry?.kind === CHAT_TURN_KIND) {
    const data = entry.data as ChatTurnData;
    const handing = turn(data.turn);
    if (handing?.ownersChain && !handing.unattended && handing.calledBy.uid === ownerUid && turnLevel(handing).level === 4) {
      return { level: 4, because: "handed over on your own message" };
    }
    return { level: 2, because: `handed over by ${data.calledBy.name}` };
  }
  return { level: 2, because: "on a message the app did not write down" };
}

/** The lowest of the levels a run's inputs allow: a run answering several goes no further than the least of them. */
export function lowestLevel(levels: readonly CallerLevel[]): CallerLevel | undefined {
  return levels.length ? levels.reduce((low, one) => (one.level < low.level ? one : low)) : undefined;
}

/** Why the owner's Yes to an offer only proposes a change: it drafts a routine, nothing more. */
const YES_ONLY_DRAFTS = "on your Yes to an offer, which only drafts";

/**
 * What an agent's turn in a chat allows: its owner's own message that names it runs (4). A turn nobody asked of it
 * only proposes (2): one the chat's router picked it for (the owner named nobody), one it took on its own (speaking up,
 * a follow-up), as does the owner's Yes to an offer (it drafts, with draftTools, and nothing more). Any other turn (a
 * member's, a hand-off) proposes too, and is offered no tool that changes data in the first place (allowedTools).
 */
export function turnLevel(turn: Pick<AgentTurn, "byOwner" | "calledBy">): CallerLevel {
  const { calledBy } = turn;
  if (calledBy.unprompted) return { level: 2, because: "on a turn nobody asked of it" };
  if (!turn.byOwner) return { level: 2, because: `on a turn ${calledBy.name} gave it` };
  if (calledBy.routed) return { level: 2, because: "on your message, which named no agent (the chat picked it)" };
  if (calledBy.drafts) return { level: 2, because: YES_ONLY_DRAFTS };
  return { level: 4, because: "on your own message" };
}

/**
 * What a turn of a member's agent in its seat allows (worker/agents/seats/), `turn` as the seat checked it (its
 * `byOwner` holds only for its owner's own message, directly): as a turn in its owner's own chat would (turnLevel), but
 * one anyone else gave it, or a chain no person started, changes nothing (1). Such a turn has no tool that changes data,
 * and what it asked for would wait for its owner, who did not ask. What both the seat's tools and the write gate go by.
 */
export function seatLevel(turn: Pick<SeatTurn, "byOwner" | "calledBy" | "unattended">): CallerLevel {
  if (!turn.byOwner || turn.unattended) return { level: 1, because: `on a turn ${turn.calledBy.name} gave it in someone else's chat` };
  return turnLevel(turn);
}

/**
 * Who a call from a seat's session is (the write gate's caller, in the member's own object): the seat's agent, at the
 * level its turn allows (seatLevel), with its own rules; a held action goes to the room the turn is in (`origin.seat`).
 * Throws, so the call is refused, for an agent of this object's owner that is gone or off, or a server it may not use.
 */
export function seatCaller(found: SeatTurnIn, agent: AgentDefinition | null, call: Pick<GateCall, "server">, session: string): Caller {
  if (!agent) throw new Error("this seat's agent is gone.");
  if (!agent.enabled) throw new Error(`@${agent.name} is off.`);
  if (!mayUseServer(agent, call.server)) throw new Error(`${call.server} is not one of the servers @${agent.name} may use.`);
  const { room, agentId, turn } = found;
  if (!chatAllowsServer(turn, call.server)) throw new Error(`${call.server} is not one of the servers agents may use in this chat.`);
  return {
    actor: { name: agent.name, agentId: agent.id, avatar: agent.avatar, color: agent.color },
    agent,
    ...seatLevel(turn),
    origin: { session, seat: { ownerUid: room.ownerUid, chatId: room.chatId, agentId } },
  };
}
