// How a chat's agents behave in that chat, as its owner sets it: whether a router picks agents for a message that names
// nobody, whether agents may post unprompted, which servers they may use here, and a daily token budget for the chat.
// The chat object keeps these (worker/chat-agent.ts); the rules that read them are functions here, so the app and the
// Worker answer the same question.

import { answersEveryMessage, type ChatKind } from "./chat-kinds.ts";
import { isObject } from "./util.ts";

/** What the chat's owner sets, as the chat keeps it. An absent field is the default. */
export interface ChatAgentSettings {
  /** Pick agents for a message that names nobody (agentRouterOn); the default for the chat's kind when absent. */
  router?: boolean;
  /** Let agents whose owner allows it post unprompted here, and offer to pick up a question nobody answered. */
  speakUp?: boolean;
  /** The MCP servers the roster's agents may use in this chat, by name; every one they may use when absent. */
  servers?: string[];
  /** How many tokens the chat's model calls (pi's, its agents', their runs') may use a day (UTC); no cap when absent. */
  dailyTokens?: number;
}

/** What everyone in the chat sees of its settings, and what the owner's panel shows. */
export interface ChatAgentSettingsView {
  /** The settings as stored. */
  settings: ChatAgentSettings;
  /** Whether the router picks agents here now (the setting, or its default for the chat's kind). */
  router: boolean;
  /** The deployment has a router model and a model for interest: without them, the switches do nothing. */
  available: { router: boolean; speakUp: boolean };
  /** The chat's model calls today (UTC): tokens and dollars. */
  today: { tokens: number; costUsd: number };
  /** The servers of the deployment, for the owner's list. */
  servers: string[];
}

/** The most servers a chat's list may name, and the largest daily budget it may set. */
export const MAX_CHAT_SERVERS = 50;
export const MAX_DAILY_TOKENS = 100_000_000;
/** The smallest daily budget: below it, a single answer would stop. */
export const MIN_DAILY_TOKENS = 10_000;

/** Thrown by checkAgentSettings with what to fix. */
export class AgentSettingsError extends Error {}

/**
 * The owner's change to the settings, checked: each field given replaces the stored one, and null clears it (back to
 * the default). Throws an AgentSettingsError with what to fix.
 */
export function checkAgentSettings(input: unknown, current: ChatAgentSettings): ChatAgentSettings {
  if (!isObject(input)) throw new AgentSettingsError("Expected the settings as an object.");
  const next: ChatAgentSettings = { ...current };
  for (const field of ["router", "speakUp"] as const) {
    if (!Object.hasOwn(input, field)) continue;
    const value = input[field];
    if (value === null) delete next[field];
    else if (typeof value === "boolean") next[field] = value;
    else throw new AgentSettingsError(`${field} is true, false or null.`);
  }
  if (Object.hasOwn(input, "servers")) {
    const servers = input.servers;
    if (servers === null) delete next.servers;
    else if (!Array.isArray(servers) || servers.some((server) => typeof server !== "string" || !server.trim() || server.length > 200))
      throw new AgentSettingsError("servers is a list of server names, or null for all of them.");
    else if (servers.length > MAX_CHAT_SERVERS) throw new AgentSettingsError(`A chat lists at most ${MAX_CHAT_SERVERS} servers.`);
    else next.servers = [...new Set((servers as string[]).map((server) => server.trim()))];
  }
  if (Object.hasOwn(input, "dailyTokens")) {
    const tokens = input.dailyTokens;
    if (tokens === null) delete next.dailyTokens;
    else if (typeof tokens !== "number" || !Number.isInteger(tokens) || tokens < MIN_DAILY_TOKENS || tokens > MAX_DAILY_TOKENS)
      throw new AgentSettingsError(
        `A daily budget is a whole number of tokens from ${MIN_DAILY_TOKENS.toLocaleString("en")} to ${MAX_DAILY_TOKENS.toLocaleString("en")}, or null for none.`,
      );
    else next.dailyTokens = tokens;
  }
  return next;
}

/**
 * Whether the router picks agents for a message that names nobody: as the owner set it, else on in a private chat
 * (whose agents answer every message) and off in any other, where agents answer only when called.
 */
export function agentRouterOn(settings: Pick<ChatAgentSettings, "router">, kind: ChatKind): boolean {
  return settings.router ?? answersEveryMessage(kind);
}

/** Whether an agent may use `server` in a chat with these settings: any of its own when the chat names none. */
export function chatAllowsServer(settings: Pick<ChatAgentSettings, "servers">, server: string): boolean {
  return !settings.servers || settings.servers.includes(server);
}

/** The day (UTC) a time falls on, as the budgets count it: "2026-11-07". */
export function budgetDay(at: number): string {
  return new Date(at).toISOString().slice(0, 10);
}

/** What the chat says when its daily budget is used up. */
export function budgetNotice(tokens: number): string {
  // Worded so pi-ai never takes it for a passing failure to retry (no "limit", "timeout" or status codes).
  return `This chat's daily budget of ${tokens.toLocaleString("en")} tokens is used up, so nothing more runs in it today (UTC). Its owner can raise the budget in the chat's agent settings.`;
}

/**
 * A daily cap was reached: the chat's token budget (no more model calls in it today), or the owner's spend on runs. Its
 * own entry kind, not a chat.event: an app from before it skips a kind it does not know.
 */
export const CHAT_BUDGET_KIND = "chat.budget";
export type ChatBudgetData = { scope: "chat" | "runs"; text: string };
