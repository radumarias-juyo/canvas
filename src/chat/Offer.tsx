import { useContext } from "react";
import { Icon } from "../Icon.tsx";
import { useStoredState } from "../layout.tsx";
import { FoldScope } from "./Fold.tsx";

/** What the viewer answered to an offer: kept in this browser by chat and entry, so No thanks stays after a reload. */
type Answer = "yes" | "no" | null;

const isAnswer = (value: unknown): value is Answer => value === "yes" || value === "no" || value === null;

/**
 * The next step a reply offers (shared/offers.ts), as a row under its bubble: an arrow and the question. For the chat's
 * owner, on the latest offer in the chat (`onYes`), Yes and No thanks: Yes replies to the message asking its agent to
 * set it up (`onYes`, false when it could not be sent), No thanks hides them. Anyone else, and older offers, see the
 * question only.
 */
export function OfferRow({ offer, entry, onYes }: { offer: string; entry?: number; onYes?: () => boolean }) {
  const chatId = useContext(FoldScope);
  // An offer with no entry has no Yes or No thanks (no onYes), so nothing is kept for it.
  const [answered, answer] = useStoredState<Answer>(`offer.${chatId}.${entry ?? "none"}`, null, isAnswer);
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
