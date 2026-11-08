/**
 * pi's settings, the owner's for all their chats, as an agent's definition has them (shared/agents.ts): the servers pi
 * may read for anyone else in a chat they share (worker/agent/reach.ts), and whether its replies built on what only they
 * see wait for them first there. pi's instructions are the owner's system prompt (shared/system-prompt.ts), and its model
 * and effort the chat's picker's; neither is kept here.
 */

/** The most servers pi's list for shared chats may name. */
export const MAX_PI_SERVERS = 50;

export interface PiSettings {
  /**
   * The servers pi reads for anyone in a shared chat, by name: when absent, those that do not sign in each user. Any
   * other server's results stay the owner's alone.
   */
  sharedServers?: string[];
  /**
   * In a shared chat, a run on the owner's own message that reads what only they see has its replies held for them
   * first, as an agent's review before posting: they show them to the chat, or keep them.
   */
  reviewBeforePosting?: true;
}

/** `input` as pi's settings to save (null or absent fields go back to their defaults), or why it cannot be. */
export function checkPiSettings(input: unknown): PiSettings | { error: string } {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return { error: "Expected {sharedServers?, reviewBeforePosting?}." };
  const { sharedServers, reviewBeforePosting } = input as Record<string, unknown>;
  const settings: PiSettings = {};
  if (sharedServers !== undefined && sharedServers !== null) {
    if (!Array.isArray(sharedServers) || sharedServers.some((server) => typeof server !== "string" || !server.trim() || server.length > 200)) {
      return { error: "sharedServers is a list of server names, or null for those that do not sign in each user." };
    }
    if (sharedServers.length > MAX_PI_SERVERS) return { error: `pi's list for shared chats names at most ${MAX_PI_SERVERS} servers.` };
    settings.sharedServers = [...new Set((sharedServers as string[]).map((server) => server.trim()))].sort();
  }
  if (reviewBeforePosting !== undefined && reviewBeforePosting !== null && typeof reviewBeforePosting !== "boolean") {
    return { error: "reviewBeforePosting is true or false." };
  }
  if (reviewBeforePosting === true) settings.reviewBeforePosting = true;
  return settings;
}
