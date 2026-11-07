// Which fields of a definition each tab of the agent page edits, and what a tab's save keeps of the rest. Plain
// functions, so the tests read them without a browser.

import { COPIED_FIELDS, type AgentDefinition, type AgentInput } from "../../shared/agents.ts";
import { LIMIT_FIELDS } from "../../shared/limits.ts";

/**
 * What a tab saves without editing: the rest of the definition (its trigger, scope, workflow, limits) stays as it is.
 * Every field some tab edits is here, or saving another tab would drop it.
 */
const KEPT = [...COPIED_FIELDS, ...LIMIT_FIELDS, "assumed", "reviewBeforePosting"] as const satisfies readonly (keyof AgentInput)[];

/**
 * The fields Setup edits. It also confirms the model's guesses (assumed), which a save of another tab keeps. Every
 * field its form writes is here: one left out would be kept as it was when the form leaves it out (a box turned off).
 */
export const SETUP_FIELDS = [
  "name",
  "job",
  "instructions",
  "avatar",
  "color",
  "model",
  "effort",
  "servers",
  "sharedServers",
  "assumed",
  "reviewBeforePosting",
  "speaksUp",
] as const satisfies readonly (keyof AgentInput)[];

/** What a save of a tab that edits `fields` takes from the agent as it is: the fields it does not edit. */
export function keptBy(fields: readonly string[], agent: AgentDefinition): Partial<AgentInput> {
  return Object.fromEntries(KEPT.filter((key) => !fields.includes(key)).map((key) => [key, agent[key]]));
}
