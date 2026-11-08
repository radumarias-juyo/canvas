// What a message asks to be made, as the composer's "Make" choice says it: an answer in the chat, a page, a document, an agent that
// runs on its own, a tool (a skill), or Auto, which reads the message for a request to repeat something on a schedule
// or on a change ("every morning…", "when … tell me") and takes that for an agent. The choice reaches the model as one
// line after the message (makeNote), never as part of what the person wrote.

import { AGENT_PROPOSE_TOOL } from "./agents.ts";

export const MAKE_KINDS = ["auto", "answer", "page", "document", "agent", "tool"] as const;
export type MakeKind = (typeof MAKE_KINDS)[number];
/** What Auto comes to: one of the others, or nothing to say (the model decides, as without a choice). */
export type MadeKind = Exclude<MakeKind, "auto">;

/** The choices as the composer's picker lists them: a label, and a line on what comes of it. */
export const MAKE_CHOICES: readonly { kind: MakeKind; label: string; hint: string }[] = [
  { kind: "auto", label: "Auto", hint: "Decides from what you write" },
  { kind: "answer", label: "Answer", hint: "A reply here in the chat" },
  { kind: "page", label: "Page", hint: "A live page, checked before it is published" },
  { kind: "document", label: "Document", hint: "A doc pi writes section by section, for you to edit" },
  { kind: "agent", label: "Agent", hint: "Runs on its own: drafted off, for you to check" },
  { kind: "tool", label: "Tool", hint: "A skill the assistant can use again" },
];

/** A make kind from a client, or undefined for anything else (none given, or not one of MAKE_KINDS). */
export function parseMake(value: unknown): MakeKind | undefined {
  return typeof value === "string" && (MAKE_KINDS as readonly string[]).includes(value) ? (value as MakeKind) : undefined;
}

// A repeat in time: "every morning", "each Monday", "daily", "every 2 hours", "on weekdays".
const EVERY =
  /\b(?:every|each)\s+(?:other\s+|\d+\s+)?(?:morning|evening|night|day|weekday|week|month|quarter|year|hour|minute|monday|tuesday|wednesday|thursday|friday|saturday|sunday|mon|tue|wed|thu|fri|sat|sun|hours|minutes|days|weeks)s?\b|\b(?:daily|weekly|monthly|hourly|nightly)\b|\bon\s+(?:mondays|tuesdays|wednesdays|thursdays|fridays|saturdays|sundays|weekdays)\b/i;
// Time gone by: "last week", "yesterday", "two days ago", "in the past month", "so far this year".
const PAST = /\b(?:last|past|previous)\s+(?:\d+\s+)?(?:day|week|month|quarter|year|days|weeks|months|quarters|years)\b|\byesterday\b|\bago\b|\bso\s+far\b/i;
// Being told: "tell me", "notify the team", "let us know".
const TELL = /\b(?:tell|notify|alert|ping|message|email|remind|warn)\s+(?:me|us|the\s+\w+)\b|\blet\s+(?:me|us)\s+know\b/i;
// The start of a condition, not of a question about one: "when signups drop", not "when did signups drop".
const WHEN = /\b(?:whenever|when|once|as\s+soon\s+as|if)\b(?!\s+(?:did|do|does|was|were|is|are|will|would|has|have|had|can|could|should|you|possible)\b)/i;
// Something that happens, which a watch waits for: "drops", "goes above", "is ready", "a new deal".
const EVENT =
  /\b(?:drops?|dropped|falls?|fell|rises?|rose|goes|go|gets?|changes?|changed|reach(?:es)?|hits?|exceeds?|crosses|passes|moves?|arrives?|comes?\s+in|lands?|closes?|opens?|fails?|breaks?|stops?|starts?|finishes|is\s+(?:ready|done|over|under|above|below|back)|new|any)\b|[<>%]/i;

/**
 * What Auto takes a message for: an agent when it asks for something to repeat on a schedule ("every morning…") or to
 * watch for a change and say so ("when … tell me", "tell me when …"); null when it says neither, and the model decides.
 */
export function autoMake(text: string): MadeKind | null {
  const flat = text.replace(/\s+/g, " ");
  // A question about what already happened ("what were sales every day last week?") asks for an answer, not a routine.
  if (EVERY.test(flat) && !PAST.test(flat)) return "agent";
  const when = WHEN.exec(flat);
  if (!when) return null;
  const before = flat.slice(0, when.index);
  const after = flat.slice(when.index + when[0].length);
  // "tell me when signups drop", or "when signups drop, tell me": being told, and something to wait for after "when".
  if ((TELL.test(before) || TELL.test(after)) && EVENT.test(after)) return "agent";
  return null;
}

/** What a choice comes to for a message: the kind chosen, or on Auto what the message reads as (null: nothing said). */
export function resolveMake(kind: MakeKind | undefined, text: string): MadeKind | null {
  if (kind === undefined) return null;
  return kind === "auto" ? autoMake(text) : kind;
}

/** The line the model reads after the message, for what was chosen (or what Auto read it as); "" for nothing. */
export function makeNote(kind: MakeKind | undefined, text: string): string {
  const made = resolveMake(kind, text);
  const auto = kind === "auto";
  switch (made) {
    case null:
      return "";
    case "answer":
      return "[They chose Answer: reply here in the chat. Make no page, agent or skill unless they ask for one.]";
    case "page":
      return "[They chose Page: build it as a live page (artifact_write, then artifact_check, then artifact_publish).]";
    case "document":
      return "[They chose Document: write it as a document with document_create (an outline with a placeholder per section), then fill each section with document_update.]";
    case "agent":
      return auto
        ? `[This reads as something to run on its own, on a schedule or a change: draft it as an agent with ${AGENT_PROPOSE_TOOL} (saved off for them to check and turn on), unless they asked for something else. Ask only about what the servers' tools cannot tell you.]`
        : `[They chose Agent: draft it with ${AGENT_PROPOSE_TOOL} (saved off for them to check and turn on). Ask only about what the servers' tools cannot tell you.]`;
    case "tool":
      return "[They chose Tool: write it as a skill with skill_propose (saved off until they turn it on), so it can be used again.]";
  }
}
