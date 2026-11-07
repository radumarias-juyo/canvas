import type { MouseEvent } from "react";
import { actorName, callLine, type NeedsYouItem } from "../shared/limits.ts";
import { endedText, expiresText } from "./agents/limits/rules.ts";
import { ActorBadge, DecisionButtons, useDecision, verbOf } from "./chat/ActionCard.tsx";
import { useClock } from "./chat/SentTime.tsx";
import { isBoolean, opensElsewhere, SectionHead, useStoredState } from "./layout.tsx";

/**
 * The sidebar's "Needs you": the actions that wait for the user across their chats, oldest first, each with who made
 * it, its call in one line, the chat it came from and when it expires, and Approve and Decline (Run and Dismiss for a
 * proposal) right there. Hidden while nothing waits; open at first, since what is in it waits on the user.
 */
export function NeedsYou({ items, navigate }: { items: readonly NeedsYouItem[]; navigate: (path: string) => void }) {
  const [open, setOpen] = useStoredState("layout.needsYouOpen", true, isBoolean);
  if (!items.length) return null;
  return (
    <section className="needs-you" aria-label="Needs you">
      <SectionHead name="Needs you" count={items.length} open={open} onToggle={setOpen} what="what waits for you" />
      {open && (
        <ul className="needs-you-list">
          {items.map((item) => (
            <NeedsYouRow key={`${item.chatId}:${item.id}`} item={item} navigate={navigate} />
          ))}
        </ul>
      )}
    </section>
  );
}

function NeedsYouRow({ item, navigate }: { item: NeedsYouItem; navigate: (path: string) => void }) {
  const { view, busy, error, decide } = useDecision(item);
  const now = useClock(view.status === "pending");
  const ended = endedText(view, now);
  const openChat = (event: MouseEvent) => {
    if (opensElsewhere(event)) return;
    event.preventDefault();
    navigate(`/c/${item.chatId}`);
  };
  return (
    <li className="needs-you-item">
      <div className="needs-you-head">
        <ActorBadge actor={view.actor} />
        <span>
          <strong>{actorName(view.actor)}</strong> {verbOf(view.kind)}
        </span>
      </div>
      <code className="needs-you-call" title={callLine(view, 2_000)}>
        {callLine(view, 60)}
      </code>
      <small className="needs-you-where">
        <a href={`/c/${item.chatId}`} onClick={openChat}>
          {item.chatTitle || "Open the chat"}
        </a>
        {ended === null && ` · ${expiresText(view.expiresAt, now)}`}
      </small>
      {ended !== null ? (
        <small className="needs-you-ended">{ended}</small>
      ) : (
        <DecisionButtons className="needs-you-buttons" kind={view.kind} busy={busy} decide={(decision) => void decide(decision)} />
      )}
      {error && <small className="form-error">{error}</small>}
    </li>
  );
}
