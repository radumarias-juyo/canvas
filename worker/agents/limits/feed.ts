// An action waiting for its owner, as their feed has it (shared/feed.ts): one item per action, in "Needs you" until it
// is decided or expires (UserDirectory.removeNeedsYou resolves it), opening the chat where its card is.

import { agentFrom, MAX_FEED_TEXT, type FeedInput } from "../../../shared/feed.ts";
import { actorName, callLine, type PendingActionView } from "../../../shared/limits.ts";
import { excerpt } from "../../../shared/replies.ts";

/** An action's item in its owner's feed: the same ref however often it is added. */
export function approvalRef(chatId: string, id: string): string {
  return `action:${chatId}:${id}`;
}

/** What an action that waits asks, in words: "@deals needs your approval", "pi proposes a change". */
export function approvalAsk(view: Pick<PendingActionView, "kind" | "actor">): string {
  const who = actorName(view.actor);
  return view.kind === "proposal" ? `${who} proposes a change` : `${who} needs your approval`;
}

/** The feed item of an action that waits: who asks, for what call, in which chat (refused there when off the record). */
export function approvalFeed(view: PendingActionView, chatTitle: string, chatKind: string): FeedInput {
  const { actor } = view;
  return {
    kind: "approval",
    ref: approvalRef(view.chatId, view.id),
    at: view.createdAt,
    title: `${approvalAsk(view)} in ${chatTitle}`,
    text: excerpt(`${callLine(view)}: ${view.why}`, MAX_FEED_TEXT),
    from:
      actor.agentId && actor.avatar && actor.color
        ? agentFrom({ id: actor.agentId, name: actor.name, avatar: actor.avatar, color: actor.color })
        : { name: actorName(actor) },
    open: { to: "chat", chatId: view.chatId },
    chat: { id: view.chatId, kind: chatKind },
    needsYou: true,
    ...(actor.agentId && { aboutAgent: actor.agentId }),
  };
}
