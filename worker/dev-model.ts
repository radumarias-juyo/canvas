// The scripted model of local development: with DEV_MODEL=script and DEV_TOOLS=true (pnpm dev only, never deployed;
// cloudflare.config.ts leaves DEV_MODEL empty unless it is set), it is the picker's only model and what every chat,
// agent and run starts on (a chat or agent that picked a model earlier keeps it, so start from an empty local state),
// so turns, hand-offs, offers and runs work with no model at all, and the e2e suite (e2e/) can drive them.
// It follows a tiny script written in the conversation:
//   /say <text>          reply with exactly <text>, which may take several lines: up to the next script line or a blank line
//   /tool <name> <json>  call one tool with the input on the rest of the line (`server.tool` names an MCP tool, as
//                        crm.list_deals; any other name is the tool's own, as checklist), then go on with the next step;
//                        after the last one, reply with the tool's name and the start of its result
// The script is the one in the turn's message, the last user message (a person's, an agent's "Your turn", a run's work
// step), where it may follow other text ("@helper /say hi"); with none there, lines that start with /say or /tool
// in the instructions (an agent's own, the owner's system prompt, a work step's); with none at all, "ok: <the message,
// cut to 80 characters>". Each model call of a turn takes the next step: those done are its assistant messages so far.

import {
  contentText,
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
  getSystemMessageText,
  type AssistantMessage,
  type JsonObject,
  type Message,
  type Model,
  type Provider,
} from "@earendil-works/pi-ai";
import { textOf } from "../shared/canonical.ts";
import { modelKey } from "../shared/models.ts";
import { excerpt } from "../shared/replies.ts";
import { mcpToolName } from "./agent/mcp.ts";
import type { Embedder } from "./agents/funnel.ts";

export const SCRIPT_PROVIDER = "script";
const SCRIPT_ID = "scripted";
/** The picker's id of the scripted model. */
export const SCRIPT_MODEL = modelKey(SCRIPT_PROVIDER, SCRIPT_ID);

/** Whether this deployment runs on the scripted model: only a local one with DEV_TOOLS on. */
export function scriptOn(env: { DEV_MODEL?: string; DEV_TOOLS?: string }): boolean {
  return env.DEV_MODEL === "script" && env.DEV_TOOLS === "true";
}

/** Places in the scripted interest model's vectors. */
const WORD_DIMS = 256;

/**
 * On the scripted model, the interest stage of agents that speak up (worker/agents/funnel.ts) reads this in place of
 * INTEREST_MODEL: a text's vector counts its words of four letters or more, each hashed to one of WORD_DIMS places, so
 * two texts are as close as the words they share. The same every time, and nothing leaves the Worker.
 */
export const scriptEmbedder: Embedder = {
  id: "script-words",
  embed: async (texts) => texts.map(wordVector),
};

function wordVector(text: string): number[] {
  const vector = new Array<number>(WORD_DIMS).fill(0);
  for (const [word] of text.toLowerCase().matchAll(/\p{L}{4,}/gu)) {
    // FNV-1a.
    let hash = 0x811c9dc5;
    for (let i = 0; i < word.length; i++) hash = Math.imul(hash ^ word.charCodeAt(i), 0x01000193);
    vector[(hash >>> 0) % WORD_DIMS]++;
  }
  return vector;
}

/** A DEV_* setting's milliseconds, on the scripted model only; undefined anywhere else, or for one that is no whole number. */
function scriptMs(env: { DEV_MODEL?: string; DEV_TOOLS?: string }, value: string | undefined): number | undefined {
  const ms = Number(value || NaN);
  return scriptOn(env) && Number.isSafeInteger(ms) && ms >= 0 ? ms : undefined;
}

/**
 * How long a chat stays quiet before an agent may speak up in it, on the scripted model with DEV_PAUSE_MS set (the e2e
 * suite's, so it waits seconds, not minutes); undefined anywhere else: PAUSE_MS.
 */
export function scriptPauseMs(env: { DEV_MODEL?: string; DEV_TOOLS?: string; DEV_PAUSE_MS?: string }): number | undefined {
  return scriptMs(env, env.DEV_PAUSE_MS);
}

/**
 * The shortest time between two of an agent's unprompted posts in a chat, on the scripted model with DEV_GAP_MS set (the
 * e2e suite's, so an agent may speak up again within seconds); undefined anywhere else: the limits' gapMinutes.
 */
export function scriptGapMs(env: { DEV_MODEL?: string; DEV_TOOLS?: string; DEV_GAP_MS?: string }): number | undefined {
  return scriptMs(env, env.DEV_GAP_MS);
}

/** A script's step: a reply, or one tool call. A /tool line that cannot be read is a reply saying why. */
type Step = { say: string } | { tool: string; input: JsonObject };

/** A script marker: /say or /tool, after a space or at the start (`lineStart`: only at the start of a line). */
const marker = (lineStart: boolean) => new RegExp(`${lineStart ? "(?:^|\\n)[ \\t]*" : "(?:^|\\s)"}\\/(say|tool)(?=\\s|$)`, "g");

/** The steps of the script in `text`, in order; none when it has no script. */
export function scriptSteps(text: string, lineStart = false): Step[] {
  const found: RegExpExecArray[] = [];
  let toolLineEnd = 0;
  for (const match of text.matchAll(marker(lineStart))) {
    // A /tool step is its whole line: a marker inside its JSON is part of the input.
    if (match.index < toolLineEnd) continue;
    found.push(match);
    if (match[1] !== "tool") continue;
    const end = text.indexOf("\n", match.index + match[0].length);
    toolLineEnd = end < 0 ? text.length : end;
  }
  return found.map((match, i) => {
    const rest = text.slice(match.index + match[0].length, found[i + 1]?.index ?? text.length);
    // A turn's ask indents a message's further lines: the reply has them as written.
    if (match[1] === "say") return { say: rest.split(/\n[ \t]*\n/)[0]!.trim().replace(/\n[ \t]+/g, "\n") };
    const body = rest.split("\n")[0]!.trim();
    const space = body.search(/\s/);
    const name = space < 0 ? body : body.slice(0, space);
    const dot = name.indexOf(".");
    const tool = dot > 0 ? mcpToolName(name.slice(0, dot), name.slice(dot + 1)) : name;
    try {
      const input: unknown = JSON.parse(space < 0 ? "{}" : body.slice(space) || "{}");
      if (!tool || typeof input !== "object" || input === null || Array.isArray(input)) return { say: `/tool needs a name and a JSON object: ${body}` };
      return { tool, input: input as JsonObject };
    } catch (error) {
      return { say: `/tool ${name}: the input is not JSON (${(error as Error).message})` };
    }
  });
}

type Said = Extract<Message, { role: "user" | "system" }>;

/** A user message's text, or a system message's with its sections (an agent's instructions may sit in one). */
function messageText(message: Said): string {
  return message.role === "system" ? getSystemMessageText(message) : contentText(message.content);
}

/** The scripted model's answer to a conversation, as a model message. */
export function scriptReply(messages: readonly Message[]): AssistantMessage {
  // The turn's message is the last user message: an agent's catch-up on the chat, before it, is only context.
  const from = messages.findLastIndex((message) => message.role === "user");
  const text = from >= 0 ? messageText(messages[from] as Said) : "";
  let steps = scriptSteps(text);
  if (!steps.length) {
    const instructions = messages.filter((message): message is Said => message.role === "system").reverse();
    for (const message of instructions) if ((steps = scriptSteps(messageText(message), true)).length) break;
  }
  const turn = messages.slice(from + 1);
  const done = turn.filter((message) => message.role === "assistant").length;
  const step = steps[done];
  if (step && "say" in step) return fauxAssistantMessage(step.say);
  if (step) return fauxAssistantMessage(fauxToolCall(step.tool, step.input), { stopReason: "toolUse" });
  const result = turn.findLast((message) => message.role === "toolResult");
  if (steps.length && result?.role === "toolResult") {
    return fauxAssistantMessage(`${result.toolName}${result.isError ? " failed" : ""}: ${excerpt(textOf(result.content), 160)}`);
  }
  // A turn's message after its label ("[Ana · person]: hi"), else the whole of it.
  const label = text.lastIndexOf("]: ");
  return fauxAssistantMessage(`ok: ${excerpt(label < 0 ? text : text.slice(label + 3), 80)}`);
}

let made: { provider: Provider; model: Model<string> } | undefined;

/** The scripted model's pi provider and its one model, made once per isolate: every call answers by scriptReply. */
export function scriptModel(): { provider: Provider; model: Model<string> } {
  if (made) return made;
  const faux = fauxProvider({
    api: SCRIPT_PROVIDER,
    provider: SCRIPT_PROVIDER,
    models: [{ id: SCRIPT_ID, name: "Scripted model (dev)", contextWindow: 200_000, maxTokens: 16_384 }],
  });
  // The faux provider answers from a queue: one answer goes in before each call. Its prompt cache (for usage figures)
  // would keep every session's prompt for the isolate's life, so it is off.
  const next = () => faux.appendResponses([(context) => scriptReply(context.messages)]);
  const provider: Provider = {
    ...faux.provider,
    stream: (model, context, options) => (next(), faux.provider.stream(model, context, { ...options, cacheRetention: "none" } as typeof options)),
    streamSimple: (model, context, options) => (next(), faux.provider.streamSimple(model, context, { ...options, cacheRetention: "none" })),
  };
  return (made = { provider, model: faux.getModel() });
}
