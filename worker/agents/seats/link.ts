// What a chat (the room) and a member's agent object (where the member's agent has its seat) say to each other by
// RPC. The room keeps the log and the turn controller; the seat keeps a pi session per room for the agent, with its
// owner's sign-ins, files, skills and budget, which never leave the owner's object. Only labelled lines of the log go
// in, and only a turn's reply (with what the app recorded of its calls) comes back.

import type { ChatAgentReplyData, ChatTurnData } from "../../../shared/agents.ts";
import type { TurnResult } from "../controller.ts";

/** Which room a seat is for: the chat's owner and id, from which its object's name is built. */
export interface RoomRef {
  ownerUid: string;
  chatId: string;
}

/**
 * Lines of the room's log for a seat's session: the labelled messages (CatchUp) of the entries after `from - 1` through
 * `through`. A seat places a batch once: one through what it has is a duplicate, and one that starts after it has a gap,
 * which the seat fills by pulling the range from the room (`RoomLink.log`).
 */
export interface SeatBatch {
  /** The first log entry the batch covers: the one after what the room last saw the seat take. */
  from: number;
  /** The newest log entry it covers. */
  through: number;
  /** The text to write; empty when nothing in the range is for the agent to read. */
  text: string;
  /** The turn it goes before: its input carries the message it answers, which the batch leaves out. */
  turn: number;
}

/** A turn the room gives a seat: its id in the room, who asked, and the input (turnInput) that starts it. */
export interface SeatTurn extends ChatTurnData {
  input: string;
  /** The agent's owner's name as the room shows it: its instructions name them. */
  ownerName: string;
  /** Its owner asked for it: the seat checks this against the asker itself before it offers any private server. */
  byOwner: boolean;
}

/** How a seat's turn ended, with what the app recorded of it: the room builds the reply from it. */
export interface SeatResult extends TurnResult {
  published: NonNullable<ChatAgentReplyData["published"]>;
  items: NonNullable<ChatAgentReplyData["items"]>;
  /** The servers outside the agent's shared list it called (only in a fork of a turn its owner asked for). */
  sources: string[];
  /** It ran in a fork of the seat's session: only its reply reaches the shared one, from the room's log. */
  forked?: boolean;
  /** Its owner reviews a reply built on a private server before it is posted (reviewBeforePosting). */
  review?: boolean;
}

/** What the room's turn controller calls on an agent's seat (one per roster entry with a `seat`). */
export interface SeatLink {
  /** Deliver lines of the log; the newest entry the seat has taken after it (its delivered seq). */
  deliver(batch: SeatBatch): Promise<number>;
  /** Give the agent a turn; returns once its input is in. Giving one twice places it once. The link adds its owner's name. */
  give(turn: Omit<SeatTurn, "ownerName">): Promise<void>;
  /** Stop a turn the seat runs. */
  abort(turn: number): Promise<void>;
  /** Have the seat send again the results of the turns it ended that the room has not taken (after a restart of either). */
  wake(): Promise<void>;
}

/** What a seat calls on its room. */
export interface RoomLink {
  /** The lines of the log after entry `after`, for turn `turn`: what fills a gap. */
  log(after: number, turn: number): Promise<SeatBatch>;
  /** A turn ended. True once the room took it (also when it had already, or the turn is gone): the seat lets it go. */
  ended(turn: number, result: SeatResult): Promise<boolean>;
}
