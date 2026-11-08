// What pi reads for whom in a chat others are in, as plain functions the tests run. pi acts as the chat's owner, but
// the person who asks decides the tools, as for an agent (worker/agents/turns.ts, allowedTools): a run that answers
// anyone but the owner reads only what the owner shares in the chat (the servers pi shares, the chat's own files).
// What pi read for the owner alone (their private servers and files, before the chat was shared or on their own
// message in it) stays out of such a run's context, and out of what the others' screens show of pi's steps.

import type { AssistantMessage, Message, ToolCall, ToolResultMessage } from "@earendil-works/pi-ai";
import { defineExtension, GenerationTask, hook, ToolTask, type AgentEvent, type EntryRecord, type Extension, type JsonObject } from "@earendil-works/pi-durable";
import type { JsonValue } from "@earendil-works/chord";
import { CHAT_TURN_KIND } from "../../shared/agents.ts";
import { CHAT_COPY_KIND } from "../../shared/chat-kinds.ts";
import {
  CHAT_MESSAGE_KIND,
  CHECK_TOOL,
  heldIn,
  MCP_DISCOVER_TOOL,
  mcpParts,
  PUBLISH_TOOL,
  WRITE_TOOL,
  type ChatMessageData,
  type PiHeld,
  type PrivateMark,
} from "../../shared/protocol.ts";
import { isObject } from "../../shared/util.ts";
import type { AgentTurn } from "../agents/roster.ts";
import { inputLevel } from "../agents/limits/levels.ts";
import { chatOutFolder, FILES_WRITE_TOOL, RUN_BASH_TOOL, RUN_PYTHON_TOOL } from "../chat-traces.ts";
import { literalPath } from "../storage/paths.ts";
import { isToolResult, TOOL_RESULTS } from "../storage/tool-results.ts";
import type { McpToolInfo } from "./mcp.ts";

/** The app's tools that read and list the owner's files (worker/agent/tools.ts). */
export const FILES_READ_TOOL = "files_read";
const FILES_LIST_TOOL = "files_list";
/** The tools whose results hold what the owner's files say: a file's text, or a script's output over the files given it. */
const FILE_TOOLS = new Set([FILES_READ_TOOL, RUN_PYTHON_TOOL, RUN_BASH_TOOL]);

/** What a files_read or sandbox result's details say it read (worker/agent/tools.ts): the paths of the owner's files. */
export type ReadDetails = { read?: string[] };

/**
 * The servers pi reads for anyone in a chat others are in: the owner's list for shared chats when they set one, else
 * those that do not sign in each user (`signsIn`), as an agent's list for shared chats starts.
 */
export function piShares(signsIn: (server: string) => boolean, list?: readonly string[]): (server: string) => boolean {
  return (server) => (list ? list.includes(server) : !signsIn(server));
}

/**
 * Whether one of pi's inputs is the owner's: their own message (also their Yes to an offer, which drafts), or a hand-off
 * from a turn that runs on their own message (inputLevel says 4). Anyone else's message, a hand-off from a turn someone
 * else gave or nobody asked for, and an input the app did not write down are not.
 */
export function ownersInput(
  entry: Pick<EntryRecord, "kind" | "data"> | undefined,
  ownerUid: string,
  turn: (id: number) => Pick<AgentTurn, "byOwner" | "calledBy" | "unattended"> | null,
): boolean {
  if (entry?.kind === CHAT_MESSAGE_KIND) return (entry.data as Partial<ChatMessageData> | undefined)?.uid === ownerUid;
  return entry?.kind === CHAT_TURN_KIND && inputLevel(entry, ownerUid, turn).level === 4;
}

/** What pi reads for a run, as the chat has it now. */
export interface Reach {
  /** pi's MCP tools, by agent tool name. */
  mcp: ReadonlyMap<string, Pick<McpToolInfo, "server">>;
  /** Whether a server's results are shared in this chat (piShares). */
  shares(server: string): boolean;
  /** Whether a path of the owner's files is the chat's (attached here, saved by its sessions, or in its out/ folder). */
  chatFile(path: string): boolean;
  /** pi's replies held for the owner (heldIn): nobody else sees them, nor does pi on anyone else's message. */
  held?: readonly PiHeld[];
}

/** The most of pi's held replies kept apart: past it the two oldest are held as one (withHeld). */
export const MAX_PI_HELD = 50;

/** `held` with `range` added; past MAX_PI_HELD the two oldest become one, which holds what came between them too. */
export function withHeld(held: readonly PiHeld[], range: PiHeld): PiHeld[] {
  const all = [...held, range];
  if (all.length > MAX_PI_HELD) {
    const [first, second] = all;
    all.splice(0, 2, { from: first.from, through: second.through, ...(first.review && second.review && { review: true as const }) });
  }
  return all;
}

/**
 * The hold pi's run takes as it reads what only the owner sees at `at`, if it takes one now: with nobody but the owner in
 * the chat (`alone`: held should someone join before it ends), or in a chat others are in with the owner's review before
 * posting on (`review`: a run that reads such a result runs on the owner's own message there). None when it holds
 * already, or in a chat others are in without review (only the owner's message reads it, and the reply is theirs to give).
 */
export function holdOnRead(hold: PiHeld | undefined, { alone, review }: { alone: boolean; review: boolean }, at: number): PiHeld | undefined {
  if (hold) return undefined;
  if (alone) return { from: at };
  return review ? { from: at, review: true } : undefined;
}

/** Whether a log entry is one of pi's held replies (heldIn, by when its message started). */
export function heldReply(entry: Pick<EntryRecord, "kind" | "model">, held: readonly PiHeld[]): boolean {
  const message = entry.model?.[0];
  return entry.kind === "pi.assistant" && message?.role === "assistant" && heldIn(held, message.timestamp);
}

/**
 * The log's pages without pi's held replies (`held`, read once per page): what the agents' catch-ups and chat_history
 * read, whose sessions members' questions reach. Nothing is left out while nothing is held.
 */
export async function* withoutHeld(pages: AsyncIterable<readonly EntryRecord[]>, held: () => readonly PiHeld[]): AsyncGenerator<readonly EntryRecord[]> {
  for await (const page of pages) {
    const now = held();
    yield now.length ? page.filter((entry) => !heldReply(entry, now)) : page;
  }
}

/** Whether a held reply is still being written (a run that started alone with the owner goes on). */
function holding(held: readonly PiHeld[] | undefined): boolean {
  return !!held?.some((range) => range.through === undefined);
}

/** The MCP tool a saved result came from, by its name (ToolResults.put: the tool's name, a hash), if pi has it. */
function savedFrom(path: string, mcp: Reach["mcp"]): Pick<McpToolInfo, "server"> | undefined {
  const name = path.slice(TOOL_RESULTS.length).replace(/-[0-9a-f]{16}\.txt$/, "");
  for (const [tool, info] of mcp) if (tool.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 60) === name) return info;
  return undefined;
}

/** Whether a file pi reads holds what only the owner sees: one not the chat's, or a saved result of a server not shared. */
function privateFile(path: string, reach: Reach): boolean {
  if (!isToolResult(path)) return !reach.chatFile(path);
  const from = savedFrom(path, reach.mcp);
  return !from || !reach.shares(from.server);
}

/** The server an MCP tool's result came from, as the call recorded it, else by its name; null for a tool no listing knows. */
function serverOf(toolName: string, details: unknown, mcp: Reach["mcp"]): string | null | undefined {
  const recorded = isObject(details) && typeof details.server === "string" ? details.server : undefined;
  if (recorded !== undefined) return recorded;
  const known = mcp.get(toolName)?.server;
  if (known !== undefined) return known;
  return mcpParts(toolName) ? null : undefined;
}

/** The paths a file tool's call names (files_read's `path`, a sandbox run's `files`), as given. */
function namedPaths(toolName: string, args: unknown): string[] | undefined {
  if (!isObject(args)) return undefined;
  if (toolName === FILES_READ_TOOL) return typeof args.path === "string" ? [args.path] : undefined;
  if (args.files === undefined) return [];
  return Array.isArray(args.files) && args.files.every((ref) => typeof ref === "string") ? (args.files as string[]) : undefined;
}

/**
 * Whether a tool's result holds what only the owner sees: from a server pi does not share in the chat (or one nobody
 * can tell), or a read of the owner's files that are not the chat's, by what its details say it read (else by the
 * paths its call named; none known is private). `args`: the call's arguments, when known.
 */
export function privateResult(toolName: string, details: unknown, reach: Reach, args?: unknown): boolean {
  // Marked as it was read (markedPrivate): a server shared since, or a file the chat has since, shows none of it.
  if (isObject(details) && details.private === true) return true;
  const server = serverOf(toolName, details, reach.mcp);
  if (server !== undefined) return server === null || !reach.shares(server);
  if (!FILE_TOOLS.has(toolName)) return false;
  const read = isObject(details) && Array.isArray(details.read) ? (details.read as unknown[]) : undefined;
  const paths = read?.every((path) => typeof path === "string") ? (read as string[]) : namedPaths(toolName, args)?.map((ref) => literalPath(ref) ?? "");
  return !paths || paths.some((path) => !path || privateFile(path, reach));
}

/** What pi needs to tell a call on a run that answers someone else (othersCall). */
export interface OthersCall extends Reach {
  chatId: string;
  /** The paths of the chat's files that are still there. */
  chatFiles(): Promise<readonly string[]>;
  /** The servers a draft of the chat declares; undefined for no such draft. */
  draftServers(draftId: string): Promise<string[] | undefined>;
}

/** What a run that answers someone else is told when it reaches for the owner's own. */
const OWNER_ONLY = "only the owner's own message reads it. Say so; the owner can ask you themselves.";

/**
 * The chat's file a name means (the path itself, or the one chat file whose path ends with it), so a run that answers
 * someone else reads only the chat's files, never another of the owner's by the same name; undefined for none or more.
 */
function chatFileNamed(ref: string, reach: Reach, files: readonly string[]): string | undefined {
  if (isToolResult(ref)) return privateFile(ref, reach) ? undefined : ref;
  const path = literalPath(ref);
  if (path !== undefined && reach.chatFile(path)) return path;
  const found = files.filter((file) => file === ref || file.endsWith(`/${ref}`));
  return found.length === 1 ? found[0] : undefined;
}

/**
 * Whether pi may make a call on a run that answers anyone but the owner, in a chat others are in: refused (`block`,
 * what the model is told) for a server pi does not share there, a file of the owner's that is not the chat's, a file
 * written outside the chat's folder, or a page that would call a server not shared; for the chat's files, the call
 * with each name put in place of the chat's file it means (`arguments`); undefined to let it go as it is.
 */
export async function othersCall(call: Pick<ToolCall, "name" | "arguments">, reach: OthersCall): Promise<{ block: string } | { arguments: JsonObject } | undefined> {
  const { name } = call;
  const args = (call.arguments ?? {}) as JsonObject;
  // What lists the owner's own: every file of theirs, every server and their sign-ins.
  if (name === FILES_LIST_TOOL || name === MCP_DISCOVER_TOOL) return { block: `Not listed: ${OWNER_ONLY}` };
  const server = serverOf(name, undefined, reach.mcp);
  if (server === null) return { block: `Not called: ${name} is no tool of a server this chat shares; ${OWNER_ONLY}` };
  if (server !== undefined) return reach.shares(server) ? undefined : { block: `Not called: ${server} is not shared in this chat, so ${OWNER_ONLY}` };
  if (name === FILES_READ_TOOL || name === RUN_PYTHON_TOOL || name === RUN_BASH_TOOL) {
    const refs = namedPaths(name, args) ?? [""];
    if (!refs.length) return undefined;
    const files = await reach.chatFiles();
    const found = refs.map((ref) => chatFileNamed(ref, reach, files));
    const missing = refs.filter((_, i) => found[i] === undefined);
    if (missing.length) {
      return { block: `Not read: ${missing.join(", ")} ${missing.length === 1 ? "is" : "are"} not among this chat's files (name one by its full path), and ${OWNER_ONLY}` };
    }
    const paths = found as string[];
    return { arguments: name === FILES_READ_TOOL ? { ...args, path: paths[0] } : { ...args, files: paths } };
  }
  if (name === FILES_WRITE_TOOL) {
    const path = typeof args.path === "string" ? literalPath(args.path) : undefined;
    const folder = chatOutFolder(reach.chatId);
    if (path?.startsWith(folder)) return undefined;
    return { block: `Not saved: on someone else's message you save files only in this chat's folder, ${folder}.` };
  }
  if (name === WRITE_TOOL || name === CHECK_TOOL || name === PUBLISH_TOOL) {
    const declared = Array.isArray(args.mcp) ? args.mcp.flatMap((entry) => (isObject(entry) && typeof entry.server === "string" ? [entry.server] : [])) : [];
    const draft = name !== WRITE_TOOL && typeof args.draft_id === "string" ? await reach.draftServers(args.draft_id) : undefined;
    const closed = [...new Set([...declared, ...(draft ?? [])])].filter((one) => !reach.shares(one));
    if (closed.length) return { block: `Not done: the page calls ${closed.join(", ")}, not shared in this chat, so ${OWNER_ONLY}` };
  }
  return undefined;
}

/** What a result the owner alone may see says in its place, to the model on someone else's run, or on others' screens. */
const LEFT_OUT = {
  model: "(Left out: this came from what only the chat's owner sees. Answer from what the chat shares, or say the owner can ask.)",
  shown: "(Shown only to the chat's owner: it came from their private servers or files.)",
} as const;
/** What one of pi's held replies says in its place, to the model on someone else's run, or on others' screens. */
const HELD_OUT = {
  model: "(Left out: this reply of yours is held for the chat's owner, built on what only they see. Do not repeat what it said.)",
  shown: "(pi's reply here is shown only to the chat's owner for now: it was built on their private servers or files.)",
} as const;

/** An assistant message with its text put in place of `said` and its calls' arguments emptied: one of pi's held replies. */
function heldMessage<M extends AssistantMessage>(message: M, said: string): M {
  let told = false;
  const content: AssistantMessage["content"] = [];
  for (const block of message.content) {
    if (block?.type === "toolCall") content.push({ ...block, arguments: {} });
    else if (block && !told) {
      told = true;
      content.push({ type: "text", text: said });
    }
  }
  return { ...message, content };
}
/** A summary of the conversation, once it is left out of a run that answers someone else (it may have kept such results). */
const SUMMARY_LEFT_OUT = "(A summary of the earlier conversation is left out here: it may hold what only the chat's owner sees.)";
/** How a compaction's summary starts in the model's context (worker/memory/fresh.ts reads it the same way). */
const SUMMARY_START = "The conversation history before this point was compacted into the following summary:";

/** Whether a result is othersCall's refusal, as the harness wrote it for a blocked call: it holds nothing of the owner's. */
function refusedHere(message: ToolResultMessage): boolean {
  return message.isError && message.details === undefined && message.content.some((part) => part.type === "text" && part.text.includes(OWNER_ONLY));
}

function isSummary(message: Message): boolean {
  if (message.role !== "user") return false;
  const first = typeof message.content === "string" ? message.content : message.content.find((part) => part.type === "text")?.text;
  return first?.startsWith(SUMMARY_START) === true;
}

/**
 * pi's context for a request of a run that answers someone else: each result only the owner may see (privateResult)
 * put in place of one that says so, its call's arguments emptied (they may quote such a result), each of pi's held
 * replies (Reach.held) left out, and a summary of the conversation made since pi first read such a result (`since`,
 * epoch ms) left out too. The same array when nothing changed.
 */
export function withoutPrivate(messages: readonly Message[], reach: Reach, since?: number): readonly Message[] {
  const calls = new Map<string, unknown>();
  for (const message of messages) {
    if (message.role === "assistant") for (const block of message.content) if (block?.type === "toolCall") calls.set(block.id, block.arguments);
  }
  const hidden = new Set<string>();
  for (const message of messages) {
    if (message.role !== "toolResult" || refusedHere(message)) continue;
    if (privateResult(message.toolName, message.details, reach, calls.get(message.toolCallId))) hidden.add(message.toolCallId);
  }
  let changed = false;
  const kept = messages.map((message): Message => {
    if (message.role === "assistant" && heldIn(reach.held, message.timestamp)) {
      changed = true;
      return heldMessage(message, HELD_OUT.model);
    }
    if (message.role === "toolResult" && hidden.has(message.toolCallId)) {
      changed = true;
      return { ...message, content: [{ type: "text", text: LEFT_OUT.model }], details: undefined } satisfies ToolResultMessage;
    }
    if (message.role === "assistant" && message.content.some((block) => block?.type === "toolCall" && hidden.has(block.id))) {
      changed = true;
      return { ...message, content: message.content.map((block) => (block?.type === "toolCall" && hidden.has(block.id) ? { ...block, arguments: {} } : block)) };
    }
    if (since !== undefined && isSummary(message) && message.timestamp >= since) {
      changed = true;
      return { role: "user", content: SUMMARY_LEFT_OUT, timestamp: message.timestamp };
    }
    return message;
  });
  return changed ? kept : messages;
}

/** Whether a log entry is one of pi's tool results that only the owner may see (privateResult), not othersCall's refusal. */
export function piPrivateEntry(entry: Pick<EntryRecord, "kind" | "model">, reach: Reach): boolean {
  const message = entry.model?.[0];
  return entry.kind === "pi.tool-result" && message?.role === "toolResult" && !refusedHere(message) && privateResult(message.toolName, message.details, reach);
}

/** `message` as `owner` or anyone else sees it, if it is a result only the owner may see; undefined for any other. */
function shownResult(message: Message | undefined, reach: Reach, owner: boolean): ToolResultMessage | undefined {
  if (message?.role !== "toolResult" || refusedHere(message) || !privateResult(message.toolName, message.details, reach)) return undefined;
  const server = serverOf(message.toolName, message.details, reach.mcp) ?? undefined;
  const mark: PrivateMark = { private: true, ...(server !== undefined && { server }) };
  if (owner) return { ...message, details: { ...(isObject(message.details) ? message.details : {}), ...mark } };
  return { ...message, content: [{ type: "text", text: LEFT_OUT.shown }], details: mark };
}

function shownEntry(entry: EntryRecord, reach: Reach, owner: boolean): EntryRecord {
  // A copy in a branch of one of pi's replies held for the owner where it came from (ChatCopyData.held).
  if (!owner && entry.kind === CHAT_COPY_KIND && (entry.data as Partial<{ held: unknown }> | undefined)?.held === true) {
    return { ...entry, data: { from: "pi", text: HELD_OUT.shown, held: true } };
  }
  const [first, ...rest] = entry.model ?? [];
  if (!owner && first?.role === "assistant" && heldIn(reach.held, first.timestamp)) return { ...entry, model: [heldMessage(first, HELD_OUT.shown), ...rest] };
  const shown = shownResult(first, reach, owner);
  return shown ? { ...entry, model: [shown, ...rest] } : entry;
}

/** What pi reads for whom when the chat cannot tell: nothing is shared, so others' screens show no tool's result. */
export const CLOSED_REACH: Reach = { mcp: new Map(), shares: () => false, chatFile: () => false };

/** The events shownPiEvent may change: those that carry a tool's result, or a reply as it streams (held for the owner). */
const SHOWN_TYPES = new Set(["snapshot", "message_start", "message_update", "message_end", "entry_appended", "tool_execution_end", "tool_execution_update"]);

/** Whether shownPiEvent may change an event: a batch with none needs no reach. */
export function showsResults(event: AgentEvent): boolean {
  return SHOWN_TYPES.has(event.type);
}

/**
 * A result only the owner may see, marked so in its details as it is read (PrivateMark), with the server it came from:
 * it stays theirs whatever pi shares later (privateResult), so widening pi's list for shared chats never shows others
 * what it read before.
 */
export function markedPrivate<R extends { details?: JsonValue }>(toolName: string, result: R, reach: Reach): R {
  const server = serverOf(toolName, result.details, reach.mcp) ?? undefined;
  const mark: PrivateMark = { private: true, ...(server !== undefined && { server }) };
  return { ...result, details: { ...(isObject(result.details) ? (result.details as JsonObject) : {}), ...mark } };
}

/** Whether a running call's output may hold what only the owner sees, by its tool alone (its server, or a file tool). */
function privateCall(toolName: string, reach: Reach): boolean {
  const server = serverOf(toolName, undefined, reach.mcp);
  return server === undefined ? FILE_TOOLS.has(toolName) : server === null || !reach.shares(server);
}

/**
 * What a socket gets of one of pi's events: a result only the owner may see (privateResult) marked so for its owner, and
 * for anyone else put in place of one that says it is the owner's, in the transcript's entries, in a result's message
 * as it starts and in a call's running output. Who called which tool still shows: what a fork of an agent's shows
 * anyone else (shownToMembers). Every event type is named, so a new one fails the typecheck until it is placed here.
 */
export function shownPiEvent(event: AgentEvent, reach: Reach, owner: boolean): AgentEvent {
  switch (event.type) {
    case "snapshot": {
      const entries = event.entries.map((entry) => shownEntry(entry, reach, owner));
      const changed = entries.some((entry, i) => entry !== event.entries[i]);
      const tools = owner ? event.tools : event.tools.map((slot) => (privateCall(slot.name, reach) ? { ...slot, output: undefined, details: undefined } : slot));
      // The reply being written, of a run that is held for the owner.
      const partial = event.generation?.message;
      const generation = !owner && partial && heldIn(reach.held, partial.timestamp) ? { ...event.generation!, message: heldMessage(partial, HELD_OUT.shown) } : event.generation;
      if (!changed && generation === event.generation && tools.every((slot, i) => slot === event.tools[i])) return event;
      return { ...event, entries: changed ? entries : event.entries, tools, ...(generation && { generation }) };
    }
    case "message_start": {
      if (owner) return event;
      const { message } = event;
      if (message.role === "assistant") return heldIn(reach.held, message.timestamp) ? { ...event, message: heldMessage(message, HELD_OUT.shown) } : event;
      if (message.role !== "toolResult" || !privateCall(message.toolName, reach)) return event;
      return { ...event, message: { ...message, content: [], details: undefined } };
    }
    case "message_update":
      // A run held for the owner streams its reply to them alone (the message's start said so for anyone else).
      return owner || !holding(reach.held) ? event : { ...event, changes: [] };
    case "message_end":
    case "entry_appended": {
      const entry = shownEntry(event.entry, reach, owner);
      return entry === event.entry ? event : { ...event, entry };
    }
    case "tool_execution_end": {
      const entry = event.entry && shownEntry(event.entry, reach, owner);
      const result = !owner && event.result && privateCall(event.toolName, reach) ? { ...event.result, structuredOutput: undefined, details: undefined } : event.result;
      return entry === event.entry && result === event.result ? event : { ...event, entry, result };
    }
    case "tool_execution_update":
      return owner || !privateCall(event.toolName, reach) ? event : { ...event, output: undefined, details: undefined };
    case "agent_changed":
    case "run_start":
    case "run_end":
    case "turn_start":
    case "turn_end":
    case "tool_execution_start":
    case "inbox_update":
    case "submission":
    case "auto_retry_start":
    case "auto_retry_end":
    case "deferred_poll":
    case "usage_changed":
    case "task_failed":
    case "compaction_start":
    case "compaction_end":
      return event;
    default:
      return event satisfies never;
  }
}

/** What pi's reach extension needs of the chat. */
export interface ReachHost {
  /** Whether pi's conversation is `conversationId`. */
  isPi(conversationId: unknown): boolean;
  /** Whether pi's run now answers anyone but the owner (ownersInput), in a chat others are in; false with nobody else in it. */
  answersOthers(): Promise<boolean>;
  /** What pi reads for a run, as the chat has it now; `files`: with the chat's files (else none is the chat's). */
  reach(files: boolean): Promise<OthersCall>;
  /** When pi first read a result only the owner may see (epoch ms), if it has. */
  privateSince(): number | undefined;
  /** Whether pi's reading a result only the owner may see now changes anything the chat keeps (readPrivate). */
  marksPrivate(): boolean;
  /**
   * pi read a result only the owner may see at `at`: kept as when it first did, and, with nobody but the owner in the
   * chat, as when its run first did (a reply it gives once someone joined is held for the owner).
   */
  readPrivate(at: number): void;
}

/**
 * The hooks that keep pi's reach (see the top of this file): on a run that answers someone else, a call that reaches for
 * the owner's own is refused (othersCall) and each request leaves out what pi read for the owner alone
 * (withoutPrivate); when pi reads such a result, the chat remembers since when (a later summary may hold it, and a run
 * alone with the owner may end after someone joined).
 */
export function reachExtension(host: ReachHost): Extension {
  return defineExtension({
    name: "reach",
    hooks: [
      hook(ToolTask, {
        beforeTool: async (call, api) => {
          if (!host.isPi(api.conversationId) || !(await host.answersOthers())) return undefined;
          return othersCall(call, await host.reach(!mcpParts(call.name)));
        },
        afterTool: async (call, result, api) => {
          if (!host.isPi(api.conversationId) || !privateCall(call.name, await host.reach(false))) return undefined;
          // The chat's files are read only for a tool that reads files: an MCP tool's result goes by its server.
          const reach = await host.reach(FILE_TOOLS.has(call.name));
          if (!privateResult(call.name, result.details, reach, call.arguments)) return undefined;
          if (host.marksPrivate()) host.readPrivate(Date.now());
          return markedPrivate(call.name, result, reach);
        },
      }),
      hook(GenerationTask, {
        beforeRequest: async ({ messages }, api) => {
          if (!host.isPi(api.conversationId) || !(await host.answersOthers())) return undefined;
          const kept = withoutPrivate(messages, await host.reach(true), host.privateSince());
          return kept === messages ? undefined : { messages: kept };
        },
      }),
    ],
  });
}
