import { AGENT_NAME_PATTERN, copyName, RESERVED_AGENT_NAMES } from "../../../shared/agents.ts";
import { sha256Hex } from "../../../shared/util.ts";

/**
 * The chat of its owner's whose object a member's agent has its seat in for one room: one per agent and room, apart
 * from the owner's own chats (no route reaches a chat id with a hyphen). Per room, because everything a chat object
 * keeps by its chat (pages and drafts, saved files and results, the sandbox, held actions, its kind) must never pass
 * from one room to another, whose people differ. The room by its owner and chat, hashed: two owners' chats can share an id.
 */
export async function seatChatId(agentId: string, room: { ownerUid: string; chatId: string }): Promise<string> {
  return `seat-${agentId}-${(await sha256Hex(`${room.ownerUid}:${room.chatId}`)).slice(0, 16)}`;
}

/**
 * A member's agent's handle in a chat: its own name when free there, else that name with its owner's first name
 * ("planner-ana"), else with a number. Null when none fits.
 */
export function memberAgentName(name: string, ownerName: string, taken: (name: string) => boolean): string | null {
  if (!taken(name)) return name;
  const first =
    ownerName
      .normalize("NFKD")
      .replace(/\p{M}/gu, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, " ")
      .trim()
      .split(" ")[0] ?? "";
  const alias = `${name.slice(0, Math.max(2, 23 - first.length))}-${first}`.slice(0, 24).replace(/-+$/, "");
  if (first && AGENT_NAME_PATTERN.test(alias) && !RESERVED_AGENT_NAMES.has(alias) && !taken(alias)) return alias;
  return copyName(name, taken);
}
