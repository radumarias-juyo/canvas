// One offered next step at the end of an answer, such as "Next step: Send this summary every Monday at 09:00?". The
// model ends a reply with it when doing the work again would help; the app shows it under the reply as a question with
// Yes and No thanks for the chat's owner, and Yes replies to that message asking its agent to set it up (for something
// to repeat, a routine: a draft agent with a schedule, saved off until its owner turns it on).

import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { EntryRecord } from "@earendil-works/pi-durable";
import { AGENT_PROPOSE_TOOL, CHAT_AGENT_KIND, type ChatAgentReplyData } from "./agents.ts";
import { withoutUnseen } from "./util.ts";

/** What starts the line an answer offers its next step on. */
export const OFFER_PREFIX = "Next step:";

/**
 * The longest offer, in characters. A longer last line is no offer: it stays in the answer's text, and has no Yes. An
 * offer is never cut, so its Yes never agrees to more than the owner reads.
 */
export const MAX_OFFER = 200;

/**
 * What the chat writes for its owner's Yes, as a reply to the message that made the offer (a reply calls the agent that
 * wrote it). It names the offer only by that reply, never copies it as the owner's words, and the turn it starts may
 * only read and draft (worker/agents/turns.ts, draftTools): a routine (AGENT_PROPOSE_TOOL, saved off for the owner to
 * turn on), not work to do now.
 */
export const OFFER_YES =
  `Yes to the next step your message offers: draft it as a routine with ${AGENT_PROPOSE_TOOL} for me to look over and turn on. ` +
  "Don't do anything else for it now.";

/** The rule in the agents' instructions (pi's and the roster's) for when and how to offer a next step. */
export const OFFER_RULE =
  "When doing the same work again would help (a report, a check or a summary someone would want regularly), end your answer with one line " +
  `\`${OFFER_PREFIX} <a short yes/no question>\`, such as "${OFFER_PREFIX} Send this summary every Monday at 09:00?": at most one, under ${MAX_OFFER} characters, and never after a one-off answer. ` +
  `If the person says yes to it, only draft it: propose a routine with ${AGENT_PROPOSE_TOOL} and a schedule trigger, so its owner gets a draft to turn on.`;

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
 * question without emphasis, and the text before it. Null when the last line is no offer, when it asks nothing, when
 * it is longer than MAX_OFFER (never cut), or when it is the whole text (there would be no answer left to show).
 */
export function offerOf(text: string): { body: string; offer: string } | null {
  const trimmed = text.trimEnd();
  const start = trimmed.lastIndexOf("\n") + 1;
  const match = OFFER_LINE.exec(trimmed.slice(start));
  if (!match) return null;
  const body = trimmed.slice(0, start).trim();
  // Only what the owner sees: nothing hidden rides along with the offer.
  const offer = withoutUnseen(match[1]).replace(/^[\s*_]+|[\s*_]+$/g, "").replace(/\s+/g, " ");
  if (!body || !offer || offer.length > MAX_OFFER) return null;
  return { body, offer };
}

/**
 * The next step one of pi's messages offers (shared/offers.ts), in its last text: only when nothing but its thoughts
 * come after that text, since a message that goes on to call a tool is not the answer yet. `block` is the text's place
 * in the message, where the answer shows without the offer's line.
 */
export function assistantOffer(content: AssistantMessage["content"]): { block: number; body: string; offer: string } | null {
  for (let i = content.length - 1; i >= 0; i--) {
    const block = content[i];
    if (!block || block.type === "thinking") continue;
    if (block.type !== "text") return null;
    if (!block.text.trim()) continue;
    const found = offerOf(block.text);
    return found && { block: i, ...found };
  }
  return null;
}

/** The next step an entry offers: in one of pi's replies, or in another agent's (a `chat.agent` entry). */
export function entryOffer(entry: EntryRecord): string | undefined {
  if (entry.kind === CHAT_AGENT_KIND) return offerOf((entry.data as unknown as ChatAgentReplyData).text ?? "")?.offer;
  const message = entry.model?.[0];
  if (entry.kind === "pi.assistant" && message?.role === "assistant") return assistantOffer(message.content)?.offer;
  return undefined;
}
