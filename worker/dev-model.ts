// The scripted model of local development: with DEV_MODEL=script and DEV_TOOLS=true (pnpm dev only, never deployed;
// cloudflare.config.ts leaves DEV_MODEL empty unless it is set), it is the picker's only model and every chat's, agent's
// and run's, so turns, hand-offs, offers and runs work with no model at all, and the e2e suite (e2e/) can drive them.
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
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
  type AssistantMessage,
  type JsonObject,
  type Message,
  type Model,
  type Provider,
} from "@earendil-works/pi-ai";
import { textOf } from "../shared/canonical.ts";
import { excerpt } from "../shared/replies.ts";
import { mcpToolName } from "./agent/mcp.ts";

export const SCRIPT_PROVIDER = "script";
/** The picker's id of the scripted model (modelKey of its provider and id). */
export const SCRIPT_MODEL = `${SCRIPT_PROVIDER}/scripted`;

/** Whether this deployment runs on the scripted model: only a local one with DEV_TOOLS on. */
export function scriptOn(env: { DEV_MODEL?: string; DEV_TOOLS?: string }): boolean {
  return env.DEV_MODEL === "script" && env.DEV_TOOLS === "true";
}

type Step = { say: string } | { tool: string; input: JsonObject } | { bad: string };

/** A script marker: /say or /tool, after a space or at the start (`lineStart`: only at the start of a line). */
const marker = (lineStart: boolean) => new RegExp(`${lineStart ? "(?:^|\\n)[ \\t]*" : "(?:^|\\s)"}\\/(say|tool)(?=\\s|$)`, "g");

/** The steps of the script in `text`, in order; none when it has no script. */
export function scriptSteps(text: string, lineStart = false): Step[] {
  const found = [...text.matchAll(marker(lineStart))];
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
      if (!tool || typeof input !== "object" || input === null || Array.isArray(input)) return { bad: `/tool needs a name and a JSON object: ${body}` };
      return { tool, input: input as JsonObject };
    } catch (error) {
      return { bad: `/tool ${name}: the input is not JSON (${(error as Error).message})` };
    }
  });
}

const messageText = (message: Message): string =>
  message.role === "system"
    ? [typeof message.content === "string" ? message.content : textOf(message.content), ...Object.values(message.sections ?? {})].join("\n")
    : message.role === "assistant"
      ? ""
      : typeof message.content === "string"
        ? message.content
        : textOf(message.content);

/** The scripted model's answer to a conversation, as a model message. */
export function scriptReply(messages: readonly Message[]): AssistantMessage {
  // The turn's message is the last user message: an agent's catch-up on the chat, before it, is only context.
  const from = messages.findLastIndex((message) => message.role === "user");
  const text = from >= 0 ? messageText(messages[from]!) : "";
  let steps = scriptSteps(text);
  if (!steps.length) {
    const instructions = messages.filter((message) => message.role === "system").reverse();
    for (const message of instructions) if ((steps = scriptSteps(messageText(message), true)).length) break;
  }
  const turn = messages.slice(from + 1);
  const done = turn.filter((message) => message.role === "assistant").length;
  const step = steps[done];
  if (step && "say" in step) return fauxAssistantMessage(step.say);
  if (step && "bad" in step) return fauxAssistantMessage(step.bad);
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
    models: [{ id: SCRIPT_MODEL.slice(SCRIPT_PROVIDER.length + 1), name: "Scripted model (dev)", contextWindow: 200_000, maxTokens: 16_384 }],
  });
  // The faux provider answers from a queue: one answer goes in before each call.
  const next = () => faux.appendResponses([(context) => scriptReply(context.messages)]);
  const provider: Provider = {
    ...faux.provider,
    stream: (model, context, options) => (next(), faux.provider.stream(model, context, options)),
    streamSimple: (model, context, options) => (next(), faux.provider.streamSimple(model, context, options)),
  };
  return (made = { provider, model: faux.getModel() });
}
