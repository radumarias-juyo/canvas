// The scripted model of local development: with DEV_MODEL=script and DEV_TOOLS=true (pnpm dev only, never deployed;
// cloudflare.config.ts leaves DEV_MODEL empty unless it is set), it is the picker's only model and what every chat,
// agent and run starts on (a chat or agent that picked a model earlier keeps it, so start from an empty local state),
// so turns, hand-offs, offers and runs work with no model at all, and the e2e suite (e2e/) can drive them.
// It follows a tiny script written in the conversation:
//   /say <text>          reply with exactly <text>, which may take several lines: up to the next script line or a blank line
//   /tool <name> <json>  call one tool with the input on the rest of the line (`server.tool` names an MCP tool, as
//                        crm.list_deals; any other name is the tool's own, as checklist), then go on with the next step;
//                        after the last one, reply with the tool's name and the start of its result. "{{draft}}" in the
//                        input is the draft id an earlier artifact_write of the turn answered with
//   /recall <text>       reply with the newest line of the conversation before the turn's message that holds <text>
//                        (case aside; lines with a script in them are skipped): what the agent read, such as its catch-up
//   /pad <n> <text>      reply with <text>, then <n> characters of filler (at most 200,000): a long reply, to spend tokens
//   /for <name>          the steps after it, up to the next /for, are only for the speaker <name> (an agent's handle, as
//                        its instructions name it; pi otherwise): one message can give each agent it names its own script
// The script is the one in the turn's message, the last user message (a person's, an agent's "Your turn", a run's work
// step), where it may follow other text ("@helper /say hi"); with none there, lines that start with a script marker
// in the instructions (an agent's own, the owner's system prompt, a work step's); with none at all, "ok: <the message,
// cut to 80 characters>". Each model call of a turn takes the next step: those done are its assistant messages so far.
// The one request it answers on its own is compiling an agent's instructions to a workflow (scriptWorkflow), so a
// draft edited in dev gets steps that follow its words.

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
import { COMPILE_PROMPT_START } from "./agents/runs/compile.ts";

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

/** A script's step: a reply, a recall, or one tool call. A /tool line that cannot be read is a reply saying why. */
type Step = { say: string } | { recall: string } | { tool: string; input: JsonObject } | { for: string };

/** A script marker, after a space or at the start (`lineStart`: only at the start of a line). */
const marker = (lineStart: boolean) => new RegExp(`${lineStart ? "(?:^|\\n)[ \\t]*" : "(?:^|\\s)"}\\/(say|tool|recall|pad|for)(?=\\s|$)`, "g");
/** The most filler /pad writes. */
const MAX_PAD = 200_000;

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
    const line = rest.split("\n")[0]!.trim();
    if (match[1] === "recall") return { recall: line };
    if (match[1] === "for") return { for: line.split(/\s/)[0]!.replace(/^@/, "").toLowerCase() };
    if (match[1] === "pad") {
      const [, count, said = ""] = /^(\d+)\s*([\s\S]*)$/.exec(line) ?? [];
      const n = Math.min(MAX_PAD, Number(count ?? 0));
      return { say: `${said}\n\n${"filler ".repeat(Math.ceil(n / 7)).slice(0, n)}`.trim() };
    }
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

/**
 * The steps of `steps` for `speaker`: those before any /for, and those after a /for that names it (up to the next).
 * A script with /for sections that has none for the speaker gives only the steps before the first /for.
 */
export function stepsFor(steps: readonly Step[], speaker: string): Step[] {
  const mine: Step[] = [];
  let section: string | undefined;
  for (const step of steps) {
    if ("for" in step) section = step.for;
    else if (section === undefined || section === speaker) mine.push(step);
  }
  return mine;
}

/** Who answers: the agent its instructions name ("In this chat you are @research"), else pi. */
function speakerOf(messages: readonly Message[]): string {
  const said = messages
    .filter((message): message is Said => message.role === "system")
    .map(messageText)
    .join("\n");
  return /In this chat you are @([a-z][a-z0-9-]*)/.exec(said)?.[1] ?? "pi";
}

/** The newest line before the turn's message that holds `text` (and no script), as the agent read it. */
function recalled(messages: readonly Message[], from: number, text: string): string {
  const wanted = text.toLowerCase();
  for (let i = from - 1; i >= 0; i--) {
    const message = messages[i];
    if (message.role !== "user") continue;
    const lines = messageText(message).split("\n").reverse();
    const line = lines.find((one) => one.toLowerCase().includes(wanted) && !marker(false).test(one));
    if (line) return `recalled: ${excerpt(line.trim(), 300)}`;
  }
  return `recalled nothing for "${text}"`;
}

/** The draft id an artifact_write of the turn answered with, newest first; for "{{draft}}" in a tool's input. */
function lastDraft(turn: readonly Message[]): string | undefined {
  for (const message of [...turn].reverse()) {
    if (message.role !== "toolResult") continue;
    const id = /draft "([a-z0-9]+)"/.exec(textOf(message.content))?.[1];
    if (id) return id;
  }
  return undefined;
}

/** Each server's read-only tools, by name, as the compile request lists them ("- name (read-only): …"). */
function listedTools(section: string): Map<string, string[]> {
  const servers = new Map<string, string[]>();
  let current: string[] | undefined;
  for (const line of section.split("\n")) {
    const server = /^Server (\S+):$/.exec(line.trim());
    if (server) servers.set(server[1], (current = []));
    const tool = /^- (\S+) \(read-only\)/.exec(line.trim());
    if (tool && current) current.push(tool[1]);
  }
  return servers;
}

/** A name as a whole word of a text: not part of a longer name. */
const namesWord = (text: string, name: string) => new RegExp(`(?<![\\w-])${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\w-])`, "i").test(text);

/**
 * The scripted answer to a compile request (worker/agents/runs/compile.ts): steps from the instructions' words, as a JSON
 * array. A look step for each listed server the instructions name (its first read-only tool), one work step with the
 * numbered steps that name no server (or the whole instructions), and a tell: by a notification when the instructions
 * say "notif", else in the chat. Null for a request it cannot read.
 */
export function scriptWorkflow(request: string): string | null {
  const section = (tag: string) => new RegExp(`<${tag}>\\n([\\s\\S]*?)\\n</${tag}>`).exec(request)?.[1];
  const instructions = section("instructions");
  const tools = section("tools");
  if (instructions === undefined || tools === undefined) return null;
  const servers = listedTools(tools);
  const looks = [...servers]
    .filter(([server, names]) => names.length && namesWord(instructions, server))
    .map(([server, names]) => ({ kind: "look", server, tool: names[0], input: {} }));
  const numbered = instructions.split("\n").flatMap((line) => /^\s*\d+[.)]\s+(.*)$/.exec(line)?.[1] ?? []);
  const work = numbered.filter((line) => ![...servers.keys()].some((server) => namesWord(line, server)));
  const prompt = (work.length ? work.join("\n") : instructions).trim().slice(0, 4_000) || "Sum up what the steps before found.";
  const via = /notif/i.test(instructions) ? "notify" : "chat";
  return JSON.stringify([...looks, { kind: "work", prompt }, { kind: "tell", to: ["owner"], via }]);
}

/** The scripted model's answer to a conversation, as a model message. */
export function scriptReply(messages: readonly Message[]): AssistantMessage {
  const system = messages.find((message): message is Said => message.role === "system");
  const user = messages.find((message): message is Said => message.role === "user");
  if (system && user && messageText(system).startsWith(COMPILE_PROMPT_START)) {
    const steps = scriptWorkflow(messageText(user));
    if (steps) return fauxAssistantMessage(steps);
  }
  // The turn's message is the last user message: an agent's catch-up on the chat, before it, is only context.
  const from = messages.findLastIndex((message) => message.role === "user");
  const text = from >= 0 ? messageText(messages[from] as Said) : "";
  const speaker = speakerOf(messages);
  let steps = stepsFor(scriptSteps(text), speaker);
  if (!steps.length) {
    const instructions = messages.filter((message): message is Said => message.role === "system").reverse();
    for (const message of instructions) if ((steps = stepsFor(scriptSteps(messageText(message), true), speaker)).length) break;
  }
  const turn = messages.slice(from + 1);
  const done = turn.filter((message) => message.role === "assistant").length;
  const step = steps[done];
  if (step && "say" in step) return fauxAssistantMessage(step.say);
  if (step && "recall" in step) return fauxAssistantMessage(recalled(messages, from, step.recall));
  if (step && "tool" in step) {
    const draft = lastDraft(turn);
    const input = draft ? (JSON.parse(JSON.stringify(step.input).replaceAll("{{draft}}", draft)) as JsonObject) : step.input;
    return fauxAssistantMessage(fauxToolCall(step.tool, input), { stopReason: "toolUse" });
  }
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
