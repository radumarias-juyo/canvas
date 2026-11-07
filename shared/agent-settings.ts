// How a chat's agents behave in that chat, as its owner sets it: whether a router picks agents for a message that names
// nobody, whether agents may post unprompted, which servers they may use here, a daily token budget for the chat, and
// one for each person's message's chain of agent turns.
// The chat object keeps these (worker/chat-agent.ts); the rules that read them are functions here, so the app and the
// Worker answer the same question.

import { answersEveryMessage, type ChatKind } from "./chat-kinds.ts";
import { checkSpeakUpLimits, SpeakUpLimitsError, type SpeakUpLimits } from "./speak-up.ts";
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
  /**
   * How many tokens the agents' turns one person's message starts (the agents it names and their hand-offs, seats'
   * too) may use together; DEFAULT_MESSAGE_TOKENS when absent (messageBudget).
   */
  messageTokens?: number;
  /**
   * How often agents may speak up here, and the router pick one (shared/speak-up.ts): the stricter of these and each
   * agent's own holds; the defaults when neither sets one.
   */
  speakUpLimits?: SpeakUpLimits;
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
/** A message's chain stops past this many tokens unless the owner set another budget (one turn with tools takes ~100k). */
export const DEFAULT_MESSAGE_TOKENS = 1_000_000;

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
  if (Object.hasOwn(input, "speakUpLimits")) {
    try {
      const limits = checkSpeakUpLimits(input.speakUpLimits);
      if (limits) next.speakUpLimits = limits;
      else delete next.speakUpLimits;
    } catch (error) {
      if (error instanceof SpeakUpLimitsError) throw new AgentSettingsError(error.message);
      throw error;
    }
  }
  const budgets = [
    ["dailyTokens", "A daily budget", "none"],
    ["messageTokens", "A budget per message", `the default (${DEFAULT_MESSAGE_TOKENS.toLocaleString("en")})`],
  ] as const;
  for (const [field, what, unset] of budgets) {
    if (!Object.hasOwn(input, field)) continue;
    const tokens = input[field];
    if (tokens === null) delete next[field];
    else if (typeof tokens !== "number" || !Number.isInteger(tokens) || tokens < MIN_DAILY_TOKENS || tokens > MAX_DAILY_TOKENS) {
      const range = `${MIN_DAILY_TOKENS.toLocaleString("en")} to ${MAX_DAILY_TOKENS.toLocaleString("en")}`;
      throw new AgentSettingsError(`${what} is a whole number of tokens from ${range}, or null for ${unset}.`);
    }
    else next[field] = tokens;
  }
  return next;
}

/** How many tokens one person's message's chain of agent turns may use together (ChatAgentSettings.messageTokens). */
export function messageBudget(settings: Pick<ChatAgentSettings, "messageTokens">): number {
  return settings.messageTokens ?? DEFAULT_MESSAGE_TOKENS;
}

/** What the chat says when a message's chain stopped at its budget, with the agents it gave no turn (by name). */
export function messageBudgetNotice(budget: number, spent: number, left: readonly string[]): string {
  const turns = left.length === 1 ? "its turn" : "their turns";
  const who = left.length ? `, so ${left.map((name) => `@${name}`).join(", ")} did not get ${turns}` : "";
  return (
    `The agents' turns for this message used ${spent.toLocaleString("en")} tokens, past its budget of ${budget.toLocaleString("en")}${who}. ` +
    "The chat's owner can raise the budget per message in the chat's agent settings."
  );
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
