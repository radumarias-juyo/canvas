// Editing a drafted agent in place, on its card (DraftCard.tsx): the words of its instructions that name one of its "at
// a glance" rows, and the two-way sync between the two. Changing a row rewrites the sentence it came from (or, when no
// sentence names it, adds a short line), and editing a sentence changes the rows it names; neither goes stale. Plain
// functions, so the tests read them without a browser.

import { allSteps, inputOf, WEEKDAYS, type AgentDefinition, type AgentInput, type AgentStep, type AgentTrigger, type Weekday } from "../../shared/agents.ts";
import { ASSUMED_FIELDS, DAY_NAMES, isAssumed, withoutAssumed, type GlanceRow } from "./glance.ts";

export type RowKey = GlanceRow["key"];

/** What the app knows that the instructions may name: the deployment's servers, the user's skills, people in the chat. */
export interface Known {
  servers: readonly string[];
  skills: readonly string[];
  people?: readonly string[];
}

/** A run of the instructions' text, and the row it names (a linked word), assumed when the model guessed that row. */
export interface Segment {
  text: string;
  row?: RowKey;
  assumed?: boolean;
}

/** A clock time in the text: "07:00", "7:30". */
const TIME = /\b([01]?\d|2[0-3]):([0-5]\d)\b/;
/** The words that say which days. */
const DAY = "(?:mon|tues|wednes|thurs|fri|satur|sun)day|mon|tue|wed|thu|fri|sat|sun";
const DAY_WORDS = [
  "every day|each day|daily|every morning|every evening",
  "every weekday|on weekdays|weekdays|every weekend|on weekends|weekends",
  `every (?:${DAY})s?|on (?:${DAY})s?(?:(?:\\s*,\\s*|\\s+and\\s+)(?:${DAY})s?)*`,
];
const DAY_PHRASE = new RegExp(`\\b(?:${DAY_WORDS.join("|")})\\b`, "i");
/** An email address. */
const EMAIL = /[^\s@<>(),;:"]+@[^\s@<>(),;:"]+\.[^\s@<>(),;:".]+/g;

/** The ways the owner is named in a tell step's recipients (the agent's own chat). */
const OWNER_NAMES = new Set(["owner", "me", "you"]);

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** A name as a whole word of the text: not part of a longer name ("crm" not in "crm-eu"). */
const wordOf = (name: string, flags = "i") => new RegExp(`(?<![\\w-])${escape(name)}(?![\\w-])`, flags);

type Tell = Extract<AgentStep, { kind: "tell" }>;
const tellsOf = (agent: Pick<AgentDefinition, "workflow">): Tell[] => allSteps(agent.workflow).filter((step): step is Tell => step.kind === "tell");
const skillsOf = (agent: Pick<AgentDefinition, "workflow">) => [
  ...new Set(allSteps(agent.workflow).flatMap((step) => (step.kind === "work" && step.skill ? [step.skill] : []))),
];
/** The servers the agent's steps, scope and watch read: those it surely uses. */
function stepServers(agent: Pick<AgentDefinition, "workflow" | "scope" | "trigger">): string[] {
  const steps = allSteps(agent.workflow);
  return [
    ...new Set([
      ...steps.flatMap((step) => (step.kind === "look" || step.kind === "do" ? [step.server] : [])),
      ...steps.flatMap((step) => (step.kind === "tell" && typeof step.via === "object" ? [step.via.server] : [])),
      ...(agent.scope ? [agent.scope.list.server] : []),
      ...(agent.trigger?.kind === "watch" ? [agent.trigger.step.server] : []),
    ]),
  ];
}

/** The servers a step reads, which the Reads row cannot drop: a step would name a server the agent may not use. */
export function lockedServers(agent: Pick<AgentDefinition, "workflow" | "scope" | "trigger">): string[] {
  return stepServers(agent);
}

/**
 * The instructions' text split into runs, each word that names a row linked to it: a server (Reads), a skill (Knows),
 * the scope's tool (Scope), a time or the days (Runs), a recipient or the outside tool it tells through (Tells). The
 * longest name wins where two overlap.
 */
export function linkedSegments(text: string, agent: AgentDefinition, known: Known): Segment[] {
  const terms: { pattern: RegExp; row: RowKey }[] = [];
  const add = (names: readonly string[], row: RowKey) => {
    for (const name of names) if (name.trim().length > 1) terms.push({ pattern: wordOf(name.trim(), "gi"), row });
  };
  add([...known.skills, ...skillsOf(agent)], "knows");
  add([...known.servers, ...(agent.servers ?? [])], "reads");
  if (agent.scope) add([agent.scope.list.tool], "scope");
  const tells = tellsOf(agent);
  add(
    tells.flatMap((step) => step.to.filter((to) => !OWNER_NAMES.has(to.toLowerCase()))),
    "tells",
  );
  add(
    tells.flatMap((step) => (typeof step.via === "object" ? [step.via.tool] : [])),
    "tells",
  );
  add(known.people ?? [], "tells");
  terms.push({ pattern: new RegExp(TIME.source, "g"), row: "runs" }, { pattern: new RegExp(DAY_PHRASE.source, "gi"), row: "runs" });
  const hits: { at: number; end: number; row: RowKey }[] = [];
  for (const { pattern, row } of terms) {
    for (const match of text.matchAll(pattern)) hits.push({ at: match.index, end: match.index + match[0].length, row });
  }
  hits.sort((one, other) => one.at - other.at || other.end - other.at - (one.end - one.at));
  const segments: Segment[] = [];
  let at = 0;
  for (const hit of hits) {
    if (hit.at < at) continue;
    if (hit.at > at) segments.push({ text: text.slice(at, hit.at) });
    segments.push({ text: text.slice(hit.at, hit.end), row: hit.row, assumed: isAssumed(agent.assumed, ASSUMED_FIELDS[hit.row]) });
    at = hit.end;
  }
  if (at < text.length) segments.push({ text: text.slice(at) });
  return segments;
}

/** A list in words: "a", "a and b", "a, b and c". */
export function listWords(items: readonly string[]): string {
  return items.length <= 2 ? items.join(" and ") : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;
}

/** What may stand between the names of a list in a sentence: commas, "and", "or", "the", "plus". */
const LIST_GLUE = /^(?:\s|,|;|\/|&|\band\b|\bor\b|\bthe\b|\bplus\b)*$/i;

/**
 * The instructions with the names `before` replaced by `after` where they stand together in one line (the one naming
 * most of them), as a list in words; null when no line names any of them, or the names there are not one list, or
 * nothing is left to say.
 */
export function rewriteNames(text: string, before: readonly string[], after: readonly string[]): string | null {
  if (!before.length || !after.length) return null;
  const lines = text.split("\n");
  let best: { line: number; spans: { at: number; end: number }[] } | null = null;
  lines.forEach((line, index) => {
    const spans = before.flatMap((name) => {
      const match = wordOf(name).exec(line);
      return match ? [{ at: match.index, end: match.index + match[0].length }] : [];
    });
    if (spans.length && (!best || spans.length > best.spans.length)) best = { line: index, spans };
  });
  if (!best) return null;
  const { line, spans } = best as { line: number; spans: { at: number; end: number }[] };
  spans.sort((one, other) => one.at - other.at);
  const source = lines[line];
  for (let i = 1; i < spans.length; i++) if (!LIST_GLUE.test(source.slice(spans[i - 1].end, spans[i].at))) return null;
  lines[line] = `${source.slice(0, spans[0].at)}${listWords(after)}${source.slice(spans.at(-1)!.end)}`;
  return lines.join("\n");
}

/** The days as a sentence says them: "every day", "every weekday", "every weekend", "on Mon, Wed". */
export function daysWords(days: readonly Weekday[] | undefined): string {
  if (!days || days.length === 7) return "every day";
  const set = new Set(days);
  if (set.size === 5 && !set.has("sat") && !set.has("sun")) return "every weekday";
  if (set.size === 2 && set.has("sat") && set.has("sun")) return "every weekend";
  return `on ${WEEKDAYS.filter((day) => set.has(day))
    .map((day) => DAY_NAMES[day])
    .join(", ")}`;
}

/** The days a phrase says; undefined for every day, null for one it does not read. */
export function daysOf(phrase: string): Weekday[] | undefined | null {
  const said = phrase.toLowerCase();
  if (/every day|each day|daily|every morning|every evening/.test(said)) return undefined;
  if (/weekday/.test(said)) return ["mon", "tue", "wed", "thu", "fri"];
  if (/weekend/.test(said)) return ["sat", "sun"];
  const days = WEEKDAYS.filter((day) => new RegExp(`\\b${day}`).test(said));
  return days.length ? days : null;
}

const sameDays = (one: readonly Weekday[] | undefined, other: readonly Weekday[] | undefined) =>
  (one ?? WEEKDAYS).length === (other ?? WEEKDAYS).length && (one ?? WEEKDAYS).every((day) => (other ?? WEEKDAYS).includes(day));

/** The instructions with a schedule's time and days changed in the line that names its time; null without one. */
export function rewriteSchedule(text: string, before: AgentTrigger | undefined, after: AgentTrigger): string | null {
  if (before?.kind !== "schedule" || after.kind !== "schedule") return null;
  const lines = text.split("\n");
  // "07:00" may be written "7:00".
  const time = new RegExp(`(?<![\\d:])0?${escape(before.at.replace(/^0/, ""))}(?![\\d])`);
  const index = lines.findIndex((line) => time.test(line));
  if (index < 0) return null;
  let line = lines[index].replace(time, after.at);
  if (!sameDays(before.days, after.days)) {
    if (!DAY_PHRASE.test(line)) return null;
    line = line.replace(DAY_PHRASE, (phrase) => (/^[A-Z]/.test(phrase) ? capital(daysWords(after.days)) : daysWords(after.days)));
  }
  lines[index] = line;
  return lines.join("\n");
}

const capital = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

/** How a tell step goes, as the Tells row's picker sets it. */
export type TellVia = Tell["via"];

/** A change to one row, as its picker makes it. */
export type RowEdit =
  | { key: "runs"; trigger: AgentTrigger | null }
  | { key: "reads"; servers: string[] | null }
  | { key: "tells"; to: string[]; via: TellVia }
  | { key: "knows"; skill: string | null }
  | { key: "scope"; list: { server: string; tool: string } | null };

/** How a row change reached the instructions: a sentence rewritten, a line added, or none needed. */
export type Rewrite = "sentence" | "line" | "none";

/** The line a row change adds when no sentence names it ("Runs: every weekday at 08:00."), in place of an older one. */
function withLine(text: string, label: string, line: string): string {
  const lines = text.replace(/\s+$/, "").split("\n");
  const at = lines.findIndex((one) => one.startsWith(`${label}: `));
  if (at >= 0) {
    lines[at] = `${label}: ${line}`;
    return lines.join("\n");
  }
  return `${lines.join("\n")}\n\n${label}: ${line}`;
}

const viaWords = (via: TellVia) => (via === "chat" ? "in the chat" : via === "notify" ? "by a notification" : `through ${via.server} ${via.tool}`);
const sameVia = (one: TellVia, other: TellVia) =>
  typeof one === "object" && typeof other === "object" ? one.server === other.server && one.tool === other.tool : one === other;

/** The steps with every work step's skill set (`skill`), or removed (null). */
function withSkill(steps: readonly AgentStep[], skill: string | null): AgentStep[] {
  return steps.map((step): AgentStep => {
    if (step.kind === "if") return { ...step, then: withSkill(step.then, skill), ...(step.else && { else: withSkill(step.else, skill) }) };
    if (step.kind !== "work") return step;
    const { skill: _, ...rest } = step;
    return skill ? { ...rest, skill } : rest;
  });
}

/** The steps with every tell step going to `to` by `via`; one is added at the end when there is none. */
function withTells(steps: readonly AgentStep[], to: string[], via: TellVia): AgentStep[] {
  let found = false;
  const each = (list: readonly AgentStep[]): AgentStep[] =>
    list.map((step): AgentStep => {
      if (step.kind === "if") return { ...step, then: each(step.then), ...(step.else && { else: each(step.else) }) };
      if (step.kind !== "tell") return step;
      found = true;
      return { kind: "tell", to, via };
    });
  const changed = each(steps);
  return found ? changed : [...changed, { kind: "tell", to, via }];
}

/**
 * A row changed by its picker: the definition's fields as saved after it, the instructions rewritten where a sentence
 * names it (else a short line added), and the row's assumed fields confirmed.
 */
export function applyRowEdit(agent: AgentDefinition, edit: RowEdit): { input: AgentInput; rewrite: Rewrite } {
  const input = inputOf(agent);
  const text = agent.instructions;
  let instructions: string | null = null;
  let line: string;
  let label: string;
  switch (edit.key) {
    case "runs": {
      label = "Runs";
      if (edit.trigger) input.trigger = edit.trigger;
      else delete input.trigger;
      const after = edit.trigger;
      if (after?.kind === "schedule") {
        instructions = rewriteSchedule(text, agent.trigger, after);
        line = `${daysWords(after.days)} at ${after.at} (${after.tz}).`;
      } else line = after ? `checks ${after.step.server} every ${after.everyMinutes} minutes, when ${after.when}.` : "only when someone calls it.";
      break;
    }
    case "reads": {
      label = "Reads";
      if (edit.servers) input.servers = edit.servers;
      else delete input.servers;
      const was = agent.servers ?? stepServers(agent);
      const same = edit.servers && edit.servers.length === was.length && edit.servers.every((server) => was.includes(server));
      instructions = same ? text : edit.servers ? rewriteNames(text, was, edit.servers) : null;
      line = edit.servers ? `${listWords(edit.servers) || "no servers"}.` : "any of your servers.";
      break;
    }
    case "tells": {
      label = "Tells";
      input.workflow = withTells(agent.workflow ?? [], edit.to, edit.via);
      const tells = tellsOf(agent);
      const was = tells[0];
      const named = (to: readonly string[]) => to.filter((one) => !OWNER_NAMES.has(one.toLowerCase()));
      if (was && sameVia(was.via, edit.via)) instructions = rewriteNames(text, named(was.to), named(edit.to));
      else if (was && typeof was.via === "object" && typeof edit.via === "object" && named(was.to).join() === named(edit.to).join()) {
        instructions = rewriteNames(text, [was.via.tool], [edit.via.tool]);
        if (instructions && was.via.server !== edit.via.server) {
          instructions = rewriteNames(instructions, [was.via.server], [edit.via.server]) ?? instructions;
        }
      }
      line = `${listWords(edit.to.map((one) => (OWNER_NAMES.has(one.toLowerCase()) ? "you" : one)))}, ${viaWords(edit.via)}.`;
      break;
    }
    case "knows": {
      label = "Knows";
      input.workflow = withSkill(agent.workflow ?? [], edit.skill);
      const [was] = skillsOf(agent);
      instructions = was && edit.skill ? rewriteNames(text, [was], [edit.skill]) : null;
      line = edit.skill ? `the ${edit.skill} skill.` : "your skills.";
      break;
    }
    case "scope": {
      label = "Scope";
      if (edit.list) input.scope = { list: { kind: "look", server: edit.list.server, tool: edit.list.tool, input: {} }, each: true };
      else delete input.scope;
      const was = agent.scope?.list;
      if (was && edit.list) {
        instructions = rewriteNames(text, [was.tool], [edit.list.tool]);
        if (instructions && was.server !== edit.list.server) {
          instructions = rewriteNames(instructions, [was.server], [edit.list.server]) ?? instructions;
        }
      }
      line = edit.list ? `each item of ${edit.list.server} ${edit.list.tool}, one by one.` : "one run at a time.";
      break;
    }
  }
  const rewrite: Rewrite = instructions === text ? "none" : instructions ? "sentence" : "line";
  input.instructions = instructions ?? withLine(text, label, capitalFirst(line));
  const assumed = withoutAssumed(agent.assumed ?? [], ASSUMED_FIELDS[edit.key]);
  if (assumed.length) input.assumed = assumed;
  else delete input.assumed;
  return { input, rewrite };
}

const capitalFirst = (text: string) => (/^[a-z]/.test(text) ? capital(text) : text);

/** Where each numbered step of the instructions is, by line: its first line and the line after its last. */
function stepLines(instructions: string): { from: number; to: number }[] {
  const lines = instructions.split("\n");
  const spans: { from: number; to: number }[] = [];
  for (let at = 0; at < lines.length; at++) {
    if (/^\s*\d+[.)]\s+/.test(lines[at])) spans.push({ from: at, to: at + 1 });
    // A line that goes on the step before it (indented), as instructionSteps reads it.
    else if (spans.length && spans.at(-1)!.to === at && /^\s{2,}\S/.test(lines[at]) && !/^\s*([-*+]|\d+[.)])\s/.test(lines[at])) {
      spans.at(-1)!.to = at + 1;
    }
  }
  return spans;
}

/** The instructions with numbered step `index` (from 0) said as `text`, kept on one line with its number. */
export function replaceStep(instructions: string, index: number, text: string): string {
  const lines = instructions.split("\n");
  const span = stepLines(instructions)[index];
  if (!span) return instructions;
  const number = /^(\s*\d+[.)]\s+)/.exec(lines[span.from])![1];
  lines.splice(span.from, span.to - span.from, `${number}${text.replace(/\s*\n\s*/g, " ").trim()}`);
  return lines.join("\n");
}

/** What `known` names a text names, as whole words. */
const namedIn = (text: string, names: readonly string[]) => names.filter((name) => wordOf(name).test(text));

/**
 * The rows a sentence's edit changes (from `before` to `after`), as fields of the definition: the servers it names
 * added to its list (and those it no longer names dropped, unless a step reads them), the skill its work step uses,
 * the schedule's time and days, the addresses it tells through an outside tool. The rows it touched, whose assumed
 * fields saving confirms. What the words do not say is left to the steps compiled from the instructions afterwards.
 */
export function rowsFromSentence(
  agent: AgentDefinition,
  before: string,
  after: string,
  known: Known,
): { changes: Partial<AgentInput>; touched: RowKey[] } {
  const changes: Partial<AgentInput> = {};
  const touched = new Set<RowKey>();
  const servers = [...new Set([...known.servers, ...(agent.servers ?? [])])];
  const [wasServers, nowServers] = [namedIn(before, servers), namedIn(after, servers)];
  const added = nowServers.filter((server) => !wasServers.includes(server));
  const dropped = wasServers.filter((server) => !nowServers.includes(server) && !lockedServers(agent).includes(server));
  if (agent.servers && (added.length || dropped.length)) {
    changes.servers = [...agent.servers.filter((server) => !dropped.includes(server)), ...added.filter((server) => !agent.servers!.includes(server))];
    touched.add("reads");
  } else if (added.length || dropped.length) touched.add("reads");
  const skills = [...new Set([...known.skills, ...skillsOf(agent)])];
  const [wasSkills, nowSkills] = [namedIn(before, skills), namedIn(after, skills)];
  const newSkill = nowSkills.find((skill) => !wasSkills.includes(skill));
  if (newSkill || wasSkills.some((skill) => !nowSkills.includes(skill))) {
    const skill = newSkill ?? nowSkills[0] ?? null;
    if (allSteps(agent.workflow).some((step) => step.kind === "work")) changes.workflow = withSkill(agent.workflow ?? [], skill);
    touched.add("knows");
  }
  const trigger = agent.trigger;
  if (trigger?.kind === "schedule") {
    const [wasTime, nowTime] = [TIME.exec(before), TIME.exec(after)];
    const at = nowTime && (!wasTime || wasTime[0] !== nowTime[0]) ? `${nowTime[1].padStart(2, "0")}:${nowTime[2]}` : trigger.at;
    const [wasDays, nowDays] = [DAY_PHRASE.exec(before)?.[0], DAY_PHRASE.exec(after)?.[0]];
    const parsed = nowDays && nowDays !== wasDays ? daysOf(nowDays) : null;
    const days = parsed === null ? trigger.days : parsed;
    if (at !== trigger.at || !sameDays(days, trigger.days)) {
      changes.trigger = { kind: "schedule", at, tz: trigger.tz, ...(days && { days }) };
      touched.add("runs");
    }
  }
  const tells = tellsOf(agent);
  const outside = tells.find((step) => typeof step.via === "object");
  if (outside) {
    const wasMail: string[] = before.match(EMAIL) ?? [];
    const nowMail: string[] = after.match(EMAIL) ?? [];
    if (wasMail.join() !== nowMail.join() && nowMail.length) {
      // Those it no longer names go; those it names now come; the rest stay.
      const kept = outside.to.filter((one) => !wasMail.includes(one) || nowMail.includes(one));
      const to = [...kept, ...nowMail.filter((one) => !outside.to.includes(one))];
      changes.workflow = withTells(changes.workflow ?? agent.workflow ?? [], to, outside.via);
      touched.add("tells");
    }
  }
  return { changes, touched: [...touched] };
}

/** A sentence edit saved: the definition's fields after it, with the assumed fields of the rows it touched confirmed. */
export function applySentenceEdit(agent: AgentDefinition, index: number, text: string, known: Known): { input: AgentInput; touched: RowKey[] } {
  const steps = stepLines(agent.instructions);
  const lines = agent.instructions.split("\n");
  const span = steps[index];
  const before = span ? lines.slice(span.from, span.to).join(" ") : agent.instructions;
  const instructions = span ? replaceStep(agent.instructions, index, text) : text.trim();
  const { changes, touched } = rowsFromSentence(agent, before, text, known);
  const input: AgentInput = { ...inputOf(agent), ...changes, instructions };
  const assumed = withoutAssumed(
    agent.assumed ?? [],
    touched.flatMap((row) => ASSUMED_FIELDS[row]),
  );
  if (assumed.length) input.assumed = assumed;
  else delete input.assumed;
  return { input, touched };
}
