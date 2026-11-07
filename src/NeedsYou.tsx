import type { MouseEvent } from "react";
import { callLine, type NeedsYouItem } from "../shared/limits.ts";
import { decisionLabels, endedText, expiresText } from "./agents/limits/rules.ts";
import { ActorBadge, actorName, useDecision, useNow } from "./chat/ActionCard.tsx";
import { isBoolean, opensElsewhere, SectionHead, useStoredState } from "./layout.tsx";

/**
 * The sidebar's "Needs you": the actions that wait for the user across their chats, oldest first, each with who made
 * it, its call in one line, the chat it came from and when it expires, and Approve and Decline (Run and Dismiss for a
 * proposal) right there. Hidden while nothing waits; open at first, since what is in it waits on the user.
 */
export function NeedsYou({ items, reload, navigate }: { items: readonly NeedsYouItem[]; reload: () => void; navigate: (path: string) => void }) {
  const [open, setOpen] = useStoredState("layout.needsYouOpen", true, isBoolean);
  if (!items.length) return null;
  return (
    <section className="needs-you" aria-label="Needs you">
      <SectionHead name="Needs you" count={items.length} open={open} onToggle={setOpen} what="what waits for you" />
      {open && (
        <ul className="needs-you-list">
          {items.map((item) => (
            <NeedsYouRow key={`${item.chatId}:${item.id}`} item={item} reload={reload} navigate={navigate} />
          ))}
        </ul>
      )}
    </section>
  );
}

function NeedsYouRow({ item, reload, navigate }: { item: NeedsYouItem; reload: () => void; navigate: (path: string) => void }) {
  const { view, busy, error, decide } = useDecision(item, reload);
  const now = useNow(view.status === "pending");
  const ended = endedText(view, now);
  const labels = decisionLabels(view.kind);
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
          <strong>{actorName(view.actor)}</strong> {view.kind === "proposal" ? "proposes" : "asks to"}
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
        <div className="needs-you-buttons">
          <button type="button" className="primary" disabled={busy} onClick={() => void decide("approve")}>
            {labels.approve}
          </button>
          <button type="button" disabled={busy} onClick={() => void decide("decline")}>
            {labels.decline}
          </button>
        </div>
      )}
      {error && <small className="form-error">{error}</small>}
    </li>
  );
}
