// How often agents may speak up unasked (worker/agents/funnel.ts) and how often the router may pick one: the chat's
// owner sets limits for their chat (ChatAgentSettings.speakUpLimits), an agent's owner for their agent
// (AgentDefinition.speakUpLimits), and the stricter of the two holds. As plain functions, so the app and the Worker
// answer the same question.

import { isObject } from "./util.ts";

/** The limits, each optional: an absent one is the other side's, else its default (SPEAK_UP_DEFAULTS). */
export interface SpeakUpLimits {
  /** How many minutes the chat stays quiet before the agent may speak up. */
  pauseMinutes?: number;
  /** The fewest minutes between two of the agent's unprompted posts in the chat. */
  gapMinutes?: number;
  /** Its unprompted posts in the chat a day (UTC), follow-ups included. */
  perDay?: number;
  /** At most one of its unprompted posts per this many of the people's messages in the chat (one routed answer too). */
  perMessages?: number;
}

export type SpeakUpLimitField = keyof SpeakUpLimits;
export const SPEAK_UP_FIELDS = ["pauseMinutes", "gapMinutes", "perDay", "perMessages"] as const satisfies readonly SpeakUpLimitField[];

/** What holds when neither the chat nor the agent sets a limit. */
export const SPEAK_UP_DEFAULTS: Required<SpeakUpLimits> = { pauseMinutes: 2, gapMinutes: 30, perDay: 3, perMessages: 5 };

/** Each limit's smallest and largest value. */
export const SPEAK_UP_BOUNDS: Record<SpeakUpLimitField, readonly [number, number]> = {
  pauseMinutes: [1, 24 * 60],
  gapMinutes: [1, 7 * 24 * 60],
  perDay: [1, 50],
  perMessages: [1, 200],
};

/** Each limit as a person reads it, for errors and labels. */
export const SPEAK_UP_LABELS: Record<SpeakUpLimitField, string> = {
  pauseMinutes: "Quiet before speaking up (minutes)",
  gapMinutes: "Minutes between its posts",
  perDay: "Posts a day",
  perMessages: "One post per this many messages",
};

/** Thrown by checkSpeakUpLimits with what to fix. */
export class SpeakUpLimitsError extends Error {}

/** Limits as a request carries them, checked: each a whole number within its bounds; none at all is undefined. */
export function checkSpeakUpLimits(input: unknown): SpeakUpLimits | undefined {
  if (input === undefined || input === null) return undefined;
  if (!isObject(input)) throw new SpeakUpLimitsError("Speaking-up limits are an object of numbers.");
  const limits: SpeakUpLimits = {};
  for (const field of SPEAK_UP_FIELDS) {
    const value = input[field];
    if (value === undefined || value === null) continue;
    const [min, max] = SPEAK_UP_BOUNDS[field];
    if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
      throw new SpeakUpLimitsError(`${SPEAK_UP_LABELS[field]} is a whole number from ${min} to ${max}.`);
    }
    limits[field] = value;
  }
  return Object.keys(limits).length ? limits : undefined;
}

/**
 * The limits that hold for an agent in a chat: the stricter of the chat's and the agent's for each one set (the longer
 * pause and gap, the fewer posts a day, one post per more messages), else its default.
 */
export function strictestLimits(...sides: (SpeakUpLimits | undefined)[]): Required<SpeakUpLimits> {
  const pick = (field: SpeakUpLimitField, stricter: (a: number, b: number) => number) => {
    const set = sides.flatMap((side) => (side?.[field] === undefined ? [] : [side[field]]));
    return set.length ? set.reduce((one, other) => stricter(one, other)) : SPEAK_UP_DEFAULTS[field];
  };
  return {
    pauseMinutes: pick("pauseMinutes", Math.max),
    gapMinutes: pick("gapMinutes", Math.max),
    perDay: pick("perDay", Math.min),
    perMessages: pick("perMessages", Math.max),
  };
}
