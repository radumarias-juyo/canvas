// Who may publish a new version of a page in a chat, and who may read it. A page belongs to the person whose turn
// published it: the chat's owner for pi's and their own agents' pages (one chat object, one owner, so they may build on
// each other's, as they act as the same person), and a member for the pages of the member's agent, published in that
// member's own object (its seat). Across people it is strict: nobody's agents publish over another person's page.
// Reading is open: any page posted in the chat may be read by every agent in it.

import { CHAT_AGENT_KIND, type ChatAgentReplyData } from "../../shared/agents.ts";
import type { EntryRecord } from "@earendil-works/pi-durable";
import type { ArtifactMeta } from "../../shared/protocol.ts";
import { shownOf, type HeldPage } from "../agents/roster.ts";

/**
 * Whose a page is to a turn in chat `chatId` of `uid`: this chat's (`chat`), another chat's of the same person
 * (`owner`), or another person's (`other`).
 */
export type PageOwner = "chat" | "owner" | "other";

export function pageOwner(meta: Pick<ArtifactMeta, "ownerUid" | "chatId">, uid: string, chatId: string): PageOwner {
  if (meta.ownerUid !== uid) return "other";
  return meta.chatId === chatId ? "chat" : "owner";
}

/**
 * Why a turn of `uid`'s chat `chatId` may not save or publish a new version of `meta`, starting with `what` ("Not
 * saved:"); null when it may (a page of this chat). Worded for the model: what it may do instead.
 */
export function versionRefusal(meta: Pick<ArtifactMeta, "id" | "title" | "ownerUid" | "chatId">, uid: string, chatId: string, what: string): string | null {
  const owner = pageOwner(meta, uid, chatId);
  if (owner === "chat") return null;
  if (owner === "owner")
    return `${what} artifact ${meta.id} is a page of another chat, which stays as it is. To build on it, write your page without artifact_id and publish it as a new artifact.`;
  return (
    `${what} artifact ${meta.id} ("${meta.title}") is a page another person's agent published. Only that person's own agents publish new versions of it; ` +
    "you may read it with artifact_read. To change it, write your version without artifact_id and publish it as a new artifact (new_artifact: true), " +
    "or ask the agent that made it."
  );
}

/**
 * The newest version of `meta` posted in a chat whose log entries these are (any order): the versions the replies of
 * its owner's agents published, as the app recorded them (never what a model wrote). 0 when none was posted there.
 * Replies held for review are not in the log until their owner posts them.
 */
export function postedVersion(entries: Iterable<Pick<EntryRecord, "kind" | "data">>, meta: Pick<ArtifactMeta, "id" | "ownerUid">): number {
  let newest = 0;
  for (const entry of entries) {
    if (entry.kind !== CHAT_AGENT_KIND) continue;
    const reply = entry.data as unknown as Partial<ChatAgentReplyData>;
    if (reply.ownerUid !== meta.ownerUid || !Array.isArray(reply.published)) continue;
    for (const page of reply.published) if (page?.artifactId === meta.id && page.version > newest) newest = page.version;
  }
  return newest;
}

/**
 * Another person's page as a chat reads it: up to the newest version posted there (`page.upTo`, postedVersion), less what
 * the page's own chat holds back from the reader (`page.held`: versions turns apart there published with their replies
 * not posted). The reading chat's log says what was posted; only the page's chat knows what it withholds, and a log
 * brought in by an import could say anything. Null when nothing of it is left.
 */
export function postedPage(meta: ArtifactMeta, page: { upTo: number; held: HeldPage }): ArtifactMeta | null {
  const posted = upTo(meta, page.upTo);
  return posted && shownOf(posted, page.held);
}

/** `meta` as a chat that shows it up to version `newest` has it: null when it shows none of it. */
export function upTo(meta: ArtifactMeta, newest: number): ArtifactMeta | null {
  const versions = meta.versions.filter((version) => version.version <= newest);
  if (!versions.length) return null;
  return { ...meta, latest: Math.max(...versions.map((version) => version.version)), versions };
}

/**
 * The newest version of `meta` someone in the room (`room`, its owner and chat) reads: the room's own page as that
 * reader is shown it (`shown`: what turns apart hold left out), another person's page as their agents posted it here
 * (`posted`), and none of another chat of the room's owner. 0 for none.
 */
export function readableVersion(
  meta: Pick<ArtifactMeta, "ownerUid" | "chatId">,
  room: { ownerUid: string; chatId: string },
  ways: { shown(): Promise<number>; posted(): Promise<number> },
): Promise<number> {
  if (meta.ownerUid !== room.ownerUid) return ways.posted();
  return meta.chatId === room.chatId ? ways.shown() : Promise.resolve(0);
}
