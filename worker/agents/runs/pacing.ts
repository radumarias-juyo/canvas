// How an agent's runs on their own go easy on its owner's budget, and what is worth a post from them: watches check less
// often as the owner's day of model calls nears the cap for runs (an urgent one keeps its interval); a run whose work
// finds nothing that meets the agent's bar answers QUIET and posts nothing; and a run past the agent's posts for the
// day keeps a quiet line instead of posting. Plain functions, so the tests run them.

import type { AgentDefinition, AgentTrigger } from "../../../shared/agents.ts";
import { instantOf, wallClock } from "./schedule.ts";

/** At these shares of the owner's daily cap for runs, a watch that is not urgent checks 2, then 4 times less often. */
const PACE_STEPS: readonly { share: number; factor: number }[] = [
  { share: 0.75, factor: 4 },
  { share: 0.5, factor: 2 },
];

/**
 * How many times its interval a watch waits between checks now: 1 below half the owner's daily cap for runs (or with
 * none, or for an urgent watch), 2 from half, 4 from three quarters (the cap itself stops runs: RUNS_DAILY_USD).
 */
export function paceFactor(spentUsd: number, capUsd: number | undefined, urgent = false): number {
  if (urgent || capUsd === undefined || !(capUsd > 0)) return 1;
  return PACE_STEPS.find((step) => spentUsd >= step.share * capUsd)?.factor ?? 1;
}

/** The time a check of a watch waits for, in ms: its interval, `factor` times. */
export function paceGap(trigger: Extract<AgentTrigger, { kind: "watch" }>, factor: number): number {
  return trigger.everyMinutes * 60_000 * factor;
}

/**
 * How early a check may come and still count as due: the alarm of an interval fires near, not at, its time. A tenth of
 * the base interval, so a paced watch checks every 2 or 4 ticks of its alarm, never one more.
 */
export function paceSlack(trigger: Extract<AgentTrigger, { kind: "watch" }>): number {
  return trigger.everyMinutes * 6_000;
}

/** What a work step answers when nothing meets the agent's bar for a post (worthPosting): nothing is posted. */
export const QUIET = "QUIET";

/** Whether a work step's answer is QUIET. Punctuation, emphasis and case around it do not matter. */
export function isQuiet(text: string): boolean {
  return /^[\s*_`"'.!>-]*quiet[\s*_`"'.!]*$/i.test(text);
}

/** What a work step's prompt adds for an agent with a bar for what is worth a post. */
export function worthPostingLine(agent: Pick<AgentDefinition, "worthPosting">): string | undefined {
  if (!agent.worthPosting) return undefined;
  return `Report only what meets this bar, set by your owner: ${agent.worthPosting}\nWhen nothing does, answer exactly ${QUIET} and nothing else: nothing is posted then.`;
}

/** The start of the day `at` falls in, for counting an agent's posts: in its schedule's time zone, else UTC. */
export function postDayStart(agent: Pick<AgentDefinition, "trigger">, at: number): number {
  const tz = agent.trigger?.kind === "schedule" ? agent.trigger.tz : "UTC";
  const wall = wallClock(at, tz);
  return instantOf({ year: wall.year, month: wall.month, day: wall.day, hour: 0, minute: 0 }, tz);
}

/** The quiet line a run keeps instead of posting, past the agent's posts for the day. */
export function postsUsedLine(limit: number): string {
  return `it posted ${limit === 1 ? "once" : `${limit} times`} today already, as many as it may`;
}
