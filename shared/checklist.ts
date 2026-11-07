// Checklists: the plan an agent posts in the chat for a big ask, one step per stage, which it then updates as each
// stage finishes. Each post or update is an entry of the chat's log; the app draws one card per checklist, where it was
// first posted, with what its latest entry says.

import { AGENT_COLORS, type AgentColor } from "./agents.ts";
import { isObject, randomHex } from "./util.ts";

/** The tool an agent posts and updates a checklist with. */
export const CHECKLIST_TOOL = "checklist";

/**
 * The entry a checklist is posted or updated as, in the chat's log everyone sees (the root conversation). Display only:
 * a passive write that starts no run, and that no model needs to read (the agent that posts it has it in its own call).
 */
export const CHAT_CHECKLIST_KIND = "chat.checklist";

export const MAX_CHECKLIST_STEPS = 12;
export const MAX_STEP_CHARS = 200;
export const MAX_NOTE_CHARS = 200;
export const MAX_TITLE_CHARS = 120;
/** A checklist's id, as newChecklistId makes it. */
export const CHECKLIST_ID_PATTERN = /^[a-f0-9]{12}$/;

export const CHECKLIST_STATUSES = ["todo", "doing", "done", "skipped"] as const;
export type ChecklistStatus = (typeof CHECKLIST_STATUSES)[number];

/** One stage of a plan: what it does, where it is, and a short note on how it went (or why it was skipped). */
export type ChecklistStep = { text: string; status: ChecklistStatus; note?: string };

/** A checklist as the tool's arguments give it, checked: `id` names the one it updates, none for a new one. */
export interface ChecklistInput {
  id?: string;
  title: string;
  steps: ChecklistStep[];
}

/** Who posted a checklist: pi when `agentId` is absent, else an agent of the chat's roster, with its badge. */
export type ChecklistAuthor = { name: string; agentId?: string; avatar?: string; color?: AgentColor };

/** What a checklist entry carries: the whole list as it stands, so the latest entry alone draws the card. A type, so pi can store it. */
export type ChatChecklistData = {
  id: string;
  title: string;
  steps: ChecklistStep[];
  by: ChecklistAuthor;
  updatedAt: number;
  /** Every step is done or skipped: the plan is over. */
  final?: true;
};

/** Thrown by checkChecklist with what to fix. */
export class ChecklistError extends Error {}

function fail(message: string): never {
  throw new ChecklistError(message);
}

/** A new checklist's id. */
export function newChecklistId(): string {
  return randomHex(6);
}

/** One line of text, trimmed, its runs of spaces and line breaks as one space; undefined when there is none. */
function line(value: unknown, what: string, max: number): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") fail(`${what} must be text.`);
  const text = value.replace(/\s+/g, " ").trim();
  if (text.length > max) fail(`${what} is at most ${max} characters; say it shorter.`);
  return text || undefined;
}

/**
 * The checklist tool's arguments, checked: a title, and 1 to MAX_CHECKLIST_STEPS steps, each with its text, one of
 * the statuses and an optional note, every text on one line. Throws a ChecklistError with what to fix.
 */
export function checkChecklist(input: unknown): ChecklistInput {
  if (!isObject(input)) fail("Expected a checklist as an object: {title, steps}.");
  let id: string | undefined;
  if (input.id !== undefined && input.id !== null && input.id !== "") {
    if (typeof input.id !== "string" || !CHECKLIST_ID_PATTERN.test(input.id.trim()))
      fail("A checklist's id is the one its first call returned (12 letters and digits); leave it out to post a new checklist.");
    id = input.id.trim();
  }
  const title = line(input.title, "A checklist's title", MAX_TITLE_CHARS);
  if (!title) fail("A checklist needs a title: what the plan is for, in a few words.");
  if (!Array.isArray(input.steps) || input.steps.length === 0) fail("A checklist needs its steps: a list of {text, status}.");
  if (input.steps.length > MAX_CHECKLIST_STEPS) fail(`A checklist has at most ${MAX_CHECKLIST_STEPS} steps; merge some stages.`);
  const steps = input.steps.map((step: unknown, i): ChecklistStep => {
    const n = `Step ${i + 1}`;
    if (!isObject(step)) fail(`${n} must be an object: {text, status, note?}.`);
    const text = line(step.text, `${n}'s text`, MAX_STEP_CHARS);
    if (!text) fail(`${n} needs its text: what the stage does.`);
    const status = step.status ?? "todo";
    if (!(CHECKLIST_STATUSES as readonly unknown[]).includes(status)) fail(`${n}'s status is one of ${CHECKLIST_STATUSES.join(", ")}.`);
    const note = line(step.note, `${n}'s note`, MAX_NOTE_CHARS);
    return { text, status: status as ChecklistStatus, ...(note && { note }) };
  });
  return { ...(id && { id }), title, steps };
}

/** Whether a plan is over: every step done or skipped. */
export function isFinal(steps: readonly ChecklistStep[]): boolean {
  return steps.every((step) => step.status === "done" || step.status === "skipped");
}

/** The entry's data for checklist `id` as it stands now, posted by `by` at `at`. */
export function checklistEntry(id: string, checklist: Pick<ChecklistInput, "title" | "steps">, by: ChecklistAuthor, at: number): ChatChecklistData {
  return { id, title: checklist.title, steps: checklist.steps, by, updatedAt: at, ...(isFinal(checklist.steps) && { final: true as const }) };
}

/** A checklist entry's data, when it has a checklist's shape (the log is the chat's own, but older entries could differ). */
export function checklistOf(entry: { kind: string; data?: unknown }): ChatChecklistData | undefined {
  if (entry.kind !== CHAT_CHECKLIST_KIND) return undefined;
  const data = entry.data;
  if (!isObject(data) || typeof data.id !== "string" || typeof data.title !== "string" || !Array.isArray(data.steps)) return undefined;
  if (!isObject(data.by) || typeof data.by.name !== "string") return undefined;
  if (data.by.color !== undefined && !(AGENT_COLORS as readonly unknown[]).includes(data.by.color)) return undefined;
  const steps = data.steps as unknown[];
  const known = (step: unknown) => isObject(step) && typeof step.text === "string" && (CHECKLIST_STATUSES as readonly unknown[]).includes(step.status);
  if (!steps.every(known)) return undefined;
  return data as unknown as ChatChecklistData;
}

/** Where a checklist shows: the entry it was first posted at, and what its latest entry says. */
export interface FoldedChecklist<Id> {
  first: Id;
  latest: ChatChecklistData;
}

/**
 * Each checklist of a log, by its id: the entry it first appeared at, and its latest state (later entries with the
 * same id are updates). An update by another author than the first post's is left out: only its author edits a card.
 * `latest` is the latest entry's own data, so a card whose checklist did not change keeps the same object.
 */
export function foldChecklists<Id extends number | string>(
  entries: readonly { id: Id; kind: string; data?: unknown }[],
): Map<string, FoldedChecklist<Id>> {
  const folded = new Map<string, FoldedChecklist<Id>>();
  for (const entry of entries) {
    const data = checklistOf(entry);
    if (!data) continue;
    const known = folded.get(data.id);
    if (!known) folded.set(data.id, { first: entry.id, latest: data });
    else if (known.latest.by.agentId === data.by.agentId) known.latest = data;
  }
  return folded;
}

/**
 * What a checklist entry draws: the card with its checklist's latest state at the entry that first posted it, and
 * nothing (undefined) at a later entry that updates it, or at any other entry.
 */
export function checklistAt<Id extends number | string>(
  folded: ReadonlyMap<string, FoldedChecklist<Id>>,
  entry: { id: Id; kind: string; data?: unknown },
): ChatChecklistData | undefined {
  if (entry.kind !== CHAT_CHECKLIST_KIND || !isObject(entry.data) || typeof entry.data.id !== "string") return undefined;
  const checklist = folded.get(entry.data.id);
  return checklist?.first === entry.id ? checklist.latest : undefined;
}

/** How far a plan is: how many steps are done, how many skipped, of how many. */
export function checklistCount(steps: readonly ChecklistStep[]): { done: number; skipped: number; total: number } {
  let done = 0;
  let skipped = 0;
  for (const step of steps) {
    if (step.status === "done") done++;
    else if (step.status === "skipped") skipped++;
  }
  return { done, skipped, total: steps.length };
}
