import { useContext, useState } from "react";
import { Icon } from "../Icon.tsx";
import { FoldScope } from "./Fold.tsx";

/** What the viewer answered to an offer: kept in this browser by chat and entry, so No thanks stays after a reload. */
type Answer = "yes" | "no";

function answerKey(chatId: string, entry: number): string {
  return `offer.${chatId}.${entry}`;
}

function storedAnswer(key: string): Answer | null {
  try {
    const value = localStorage.getItem(key);
    return value === "yes" || value === "no" ? value : null;
  } catch {
    return null;
  }
}

function storeAnswer(key: string, answer: Answer): void {
  try {
    localStorage.setItem(key, answer);
  } catch {
    // Not remembered: the buttons still go for now, and come back after a reload.
  }
}

/**
 * The next step a reply offers (shared/offers.ts), as a row under its bubble: an arrow and the question. For the chat's
 * owner, on the latest offer in the chat (`onYes`), Yes and No thanks: Yes replies to the message asking its agent to
 * set it up (`onYes`, false when it could not be sent), No thanks hides them. Anyone else, and older offers, see the
 * question only.
 */
export function OfferRow({ offer, entry, onYes }: { offer: string; entry?: number; onYes?: () => boolean }) {
  const chatId = useContext(FoldScope);
  const key = entry === undefined ? undefined : answerKey(chatId, entry);
  const [answered, setAnswered] = useState<Answer | null>(() => (key ? storedAnswer(key) : null));
  const answer = (value: Answer) => {
    setAnswered(value);
    if (key) storeAnswer(key, value);
  };
  const live = onYes && !answered;
  return (
    <div className={live ? "offer live" : "offer"} role="group" aria-label="Offered next step">
      <span className="offer-icon">
        <Icon size={15} box={16} stroke={1.7}>
          <path d="M3 4v3.5a2.5 2.5 0 0 0 2.5 2.5H13M10 7l3 3-3 3" />
        </Icon>
      </span>
      <span className="offer-text">{offer}</span>
      {live && (
        <span className="offer-actions">
          <button type="button" className="offer-yes" onClick={() => onYes() && answer("yes")} title="Reply to it, asking the agent to set it up">
            Yes
          </button>
          <button type="button" className="offer-no" onClick={() => answer("no")}>
            No thanks
          </button>
        </span>
      )}
    </div>
  );
}
