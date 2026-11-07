// One offered next step at the end of an answer, such as "Next step: Send this summary every Monday at 09:00?". The
// model ends a reply with it when doing the work again would help; the app shows it under the reply as a question with
// Yes and No thanks for the chat's owner, and Yes replies to that message asking its agent to set it up (for something
// to repeat, a routine: a draft agent with a schedule, saved off until its owner turns it on).

import { AGENT_PROPOSE_TOOL } from "./agents.ts";
import { excerpt } from "./replies.ts";

/** What starts the line an answer offers its next step on. */
export const OFFER_PREFIX = "Next step:";

/** The longest offer the app shows, in characters; a longer one is cut. */
export const MAX_OFFER = 200;

/** What Yes sends, as a reply to the message that made the offer: a reply calls the agent that wrote it. */
export const OFFER_YES = "Yes, please set that up.";

/** The rule in the agents' instructions (pi's and the roster's) for when and how to offer a next step. */
export const OFFER_RULE =
  "When doing the same work again would help (a report, a check or a summary someone would want regularly), end your answer with one line " +
  `\`${OFFER_PREFIX} <a short yes/no question>\`, such as "${OFFER_PREFIX} Send this summary every Monday at 09:00?": at most one, and never after a one-off answer. ` +
  `If the person says yes to it, set it up: for something to repeat, propose a routine with ${AGENT_PROPOSE_TOOL} and a schedule trigger, so its owner gets a draft to turn on.`;

/** The words of the prefix, without its colon, as a pattern: "Next step". */
const PREFIX_WORDS = OFFER_PREFIX.replace(/:$/, "")
  .trim()
  .replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  .replace(/\s+/g, "\\s+");

/**
 * The offer's line: an optional quote mark (">"), Markdown emphasis round the prefix or the whole line ("**Next step:**",
 * "_Next step:_", "**Next step**:"), then the question.
 */
const OFFER_LINE = new RegExp(`^\\s*(?:>\\s*)*[*_]{0,3}\\s*${PREFIX_WORDS}\\s*(?:[*_]{0,3}\\s*:|:\\s*[*_]{0,3})(.*)$`, "i");

/**
 * The next step `text` offers: its last line (after trailing whitespace) when that starts with OFFER_PREFIX, as the
 * question without emphasis, cut to MAX_OFFER, and the text before it. Null when the last line is no offer, when it
 * asks nothing, or when it is the whole text (there would be no answer left to show).
 */
export function offerOf(text: string): { body: string; offer: string } | null {
  const trimmed = text.trimEnd();
  const start = trimmed.lastIndexOf("\n") + 1;
  const match = OFFER_LINE.exec(trimmed.slice(start));
  if (!match) return null;
  const body = trimmed.slice(0, start).trim();
  const offer = match[1].replace(/^[\s*_]+|[\s*_]+$/g, "");
  if (!body || !offer) return null;
  return { body, offer: excerpt(offer, MAX_OFFER) };
}
