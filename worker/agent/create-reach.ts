// What a page made on someone else's ask may reach (worker/agent/publish.ts, tools.ts): anyone in a chat may ask an
// agent (or pi) to make a new page, also through a hand-off, but such a page calls only the servers that asker may use
// (the servers shared with the chat), never one only its owner reads, and it changes no page the chat already has. A
// page's calls run as its owner's whoever opens it, so the version keeps the servers it may call (ArtifactManifest.reach)
// and its live calls go by that too (ChatAgent.artifactCall). Plain functions, so the tests run them.

import type { ArtifactManifest } from "../../shared/protocol.ts";

/**
 * What a conversation's turn may build into a page when someone other than its owner asked for it (a member's message,
 * a hand-off, a turn the chat picked it for): `servers`, those its page may declare and call (the servers shared with the
 * chat, within the room's list for a member's agent); `newOnly`, it makes new pages only, never a new version of one the
 * chat has. Undefined (no CreateReach) for the owner's own turn, which reaches what it always did.
 */
export interface CreateReach {
  servers: readonly string[];
  newOnly: boolean;
}

/** The servers a manifest declares. */
export function declaredServers(manifest: ArtifactManifest): string[] {
  return (manifest.mcp?.servers ?? []).map((entry) => entry.server);
}

/**
 * Why a page made within `reach` may not declare what `manifest` does, starting with `what` ("Not saved:"), worded for
 * the model; null when every server it declares is one the asker may use.
 */
export function reachRefusal(manifest: ArtifactManifest, reach: CreateReach, what: string): string | null {
  const closed = declaredServers(manifest).filter((server) => !reach.servers.includes(server));
  if (!closed.length) return null;
  const allowed = reach.servers.length ? `only ${reach.servers.join(", ")}` : "no server at all";
  return (
    `${what} the page calls ${closed.join(", ")}, which only your owner's own message may build a page on. A page made on someone else's ask ` +
    `calls ${allowed} (the servers shared with this chat): leave the others out, or say your owner can ask for it themselves.`
  );
}

/** Why a turn within `reach` may not change a page the chat has, starting with `what`; null when it may (not newOnly). */
export function changeRefusal(reach: CreateReach | undefined, what: string): string | null {
  if (!reach?.newOnly) return null;
  return (
    `${what} changing a page the chat already has (a new version, or edits to one) is for your owner's own message. ` +
    "You may make a new page instead: write it as html, then check it and publish it without artifact_id (new_artifact: true)."
  );
}

/** Why a turn within `reach` may not use a draft it did not write itself, starting with `what`. */
export function draftRefusal(id: string, what: string): string {
  return `${what} draft "${id}" is not one this turn wrote. On someone else's ask you build only on your own drafts: write the page as html.`;
}

/** A manifest as a page made within `reach` is published with: it keeps the servers it may call (ArtifactManifest.reach). */
export function withReach(manifest: ArtifactManifest, reach: CreateReach | undefined): ArtifactManifest {
  if (!reach) return manifest;
  return { ...manifest, reach: declaredServers(manifest).filter((server) => reach.servers.includes(server)) };
}

/**
 * Why a published version may not call `server` live (ChatAgent.artifactCall): one made on someone else's ask calls only
 * the servers it kept (`reach`), whatever else it declares. Null when it may, or for a version made on its owner's own.
 */
export function liveCallRefusal(manifest: ArtifactManifest, server: string): string | null {
  if (!manifest.reach || manifest.reach.includes(server)) return null;
  return `${server} is not one of the servers this page may call: it was made on the ask of someone ${server} is not shared with.`;
}

/** The drafts each conversation wrote (in memory, per object), so a turn on someone else's ask builds only on its own. */
export class SessionDrafts {
  readonly #by = new Map<string, Set<string>>();
  readonly #max: number;

  constructor(max = 200) {
    this.#max = max;
  }

  add(session: string, draftId: string): void {
    const drafts = this.#by.get(session) ?? new Set<string>();
    this.#by.delete(session);
    drafts.add(draftId);
    this.#by.set(session, drafts);
    // The sessions written to least recently go first.
    while (this.#by.size > this.#max) this.#by.delete(this.#by.keys().next().value!);
  }

  has(session: string, draftId: string): boolean {
    return this.#by.get(session)?.has(draftId) === true;
  }
}
