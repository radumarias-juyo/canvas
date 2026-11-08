// What the Runs tab says of a run, in plain functions the tests read without a browser.

import { stepServers, type AgentDefinition } from "../../shared/agents.ts";
import { firstLine } from "../../shared/replies.ts";
import { readsInStepText } from "../../shared/sign-ins.ts";
import type { AgentRunDetail, AgentRunView, RunDelivery, RunDeliveryKind, RunItemStatus, RunItemView, RunStatus, RunWhy } from "../../shared/runs.ts";
import { plural } from "../../shared/util.ts";

/** A pill's tone, as the stylesheet colours it. */
export type Tone = "on" | "draft" | "off" | "error";

const RUN_STATUS: Record<RunStatus, { text: string; tone: Tone }> = {
  running: { text: "Running", tone: "draft" },
  sent: { text: "Sent", tone: "on" },
  not_today: { text: "Not today", tone: "off" },
  blocked: { text: "Blocked", tone: "error" },
  failed: { text: "Failed", tone: "error" },
  needs_sign_in: { text: "Needs sign-in", tone: "error" },
  waiting: { text: "Waits for you", tone: "draft" },
};

/** A run's status as its pill says it, and the pill's tone: a test that acted "Would send". */
export function runStatusLabel(run: Pick<AgentRunView, "status" | "test">): { text: string; tone: Tone } {
  return run.test && run.status === "sent" ? { ...RUN_STATUS.sent, text: "Would send" } : RUN_STATUS[run.status];
}

const WHY: Record<RunWhy, string> = { schedule: "On its schedule", watch: "Its watch fired", test: "A test run", manual: "Run by hand" };

/** What started a run, in words: the runs list says it as is, a run's post in its byline in lower case. */
export function whyLabel(why: RunWhy): string {
  return WHY[why];
}

const ITEM_STATUS: Record<RunItemStatus, string> = {
  running: "Running",
  acted: "Acted",
  not_today: "Not today",
  blocked: "Blocked",
  failed: "Failed",
  waiting: RUN_STATUS.waiting.text,
};

/** An item's status, in words. */
export function itemStatusLabel(status: RunItemStatus): string {
  return ITEM_STATUS[status];
}

/** One group of a run's items in its detail: those that went the same way, each with its line. */
export interface ItemGroup {
  status: RunItemStatus;
  /** "Acted on", "Not today", … */
  title: string;
  /** How many of how many for the acted ("5 of 7"), else how many. */
  count: string;
  items: { item: RunItemView; line: string }[];
}

/** The groups in the order the detail shows them: what is still going first, then what it did, then why not. */
const GROUPS: [RunItemStatus, string][] = [
  ["running", "Running"],
  ["waiting", RUN_STATUS.waiting.text],
  ["acted", "Acted on"],
  ["blocked", "Blocked"],
  ["failed", "Failed"],
  ["not_today", "Not today"],
];

/**
 * What one item came to, in a line: its report's first line when it acted, why it stopped when it did not (the
 * condition, the failure), else the step it is at.
 */
export function itemLine(item: Pick<RunItemView, "status" | "text" | "reason" | "steps">): string {
  if (item.status === "acted") return firstLine(item.text ?? "", 120);
  if (item.reason) return firstLine(item.reason, 120);
  if (item.status === "waiting") return "Waits for you to approve a call.";
  return item.steps.at(-1)?.label ?? "";
}

/** A run's items grouped as its detail shows them: acted on, not today, and the rest; empty groups left out. */
export function itemGroups(items: readonly RunItemView[]): ItemGroup[] {
  return GROUPS.flatMap(([status, title]) => {
    const these = items.filter((item) => item.status === status);
    if (!these.length) return [];
    const count = status === "acted" ? `${these.length} of ${items.length}` : String(these.length);
    return [{ status, title, count, items: these.map((item) => ({ item, line: itemLine(item) })) }];
  });
}

/** What a run used, as its detail's Used list says it: its skills, how many memory notes, the servers it read, its models. */
export function usedParts(used: AgentRunDetail["used"]): { what: string; text: string }[] {
  const parts: { what: string; text: string }[] = [];
  if (used.skills.length) parts.push({ what: used.skills.length === 1 ? "Skill" : "Skills", text: used.skills.join(", ") });
  if (used.notes > 0) parts.push({ what: "Memory", text: plural(used.notes, "note") });
  if (used.servers.length) parts.push({ what: "Read", text: used.servers.join(", ") });
  if (used.models.length) parts.push({ what: used.models.length === 1 ? "Model" : "Models", text: used.models.join(", ") });
  return parts;
}

/** How a run's items went, when it had a scope: "3 of 6 acted · 3 not today". Empty for a run with one item. */
export function itemsLabel(items: AgentRunView["items"]): string {
  if (items.total <= 1) return "";
  return [
    `${items.acted} of ${items.total} acted`,
    items.notToday && `${items.notToday} not today`,
    items.blocked && `${items.blocked} blocked, not acted on`,
    items.failed && `${items.failed} failed`,
    items.waiting && `${items.waiting} wait for you`,
  ]
    .filter(Boolean)
    .join(" · ");
}

/** Each kind of delivery as done, as a test would have done it, and as not done. */
const DELIVERY_WORDS: Record<RunDeliveryKind, [done: string, would: string, not: string]> = {
  chat: ["Posted in", "Would post in", "Did not post in"],
  notify: ["Notified", "Would notify", "Did not notify"],
  page: ["Updated", "Would update", "Did not update"],
  handOver: ["Handed to", "Would hand to", "Did not hand to"],
  tool: ["Called", "Would call", "Did not call"],
};

/** Where a delivery went, in words: "Posted in its chat", "Would notify you", "Did not update Signups brief". */
export function deliveryLabel(delivery: Pick<RunDelivery, "kind" | "to" | "status">): string {
  const [done, would, not] = DELIVERY_WORDS[delivery.kind];
  if (delivery.status === "waiting") return `${would} ${delivery.to} once you approve it`;
  return `${delivery.status === "sent" ? done : delivery.status === "recorded" ? would : not} ${delivery.to}`;
}

const DELIVERY_STATUS: Record<RunDelivery["status"], { text: string; tone: Tone }> = {
  sent: { text: "Sent", tone: "on" },
  recorded: { text: "Recorded", tone: "draft" },
  waiting: { text: "Waits for you", tone: "draft" },
  refused: { text: "Not sent", tone: "off" },
  failed: { text: "Failed", tone: "error" },
};

/** A delivery's status as its pill says it, and the pill's tone. */
export function deliveryStatusLabel(status: RunDelivery["status"]): { text: string; tone: Tone } {
  return DELIVERY_STATUS[status];
}

/**
 * What a run waiting for these sign-ins can do without them: a server its agent reads in a step it cannot go without
 * (change the steps, or turn it off); one its work only may use, Disconnect lets the runs go on without.
 */
export function signInWayOut(agent: Pick<AgentDefinition, "name" | "trigger" | "scope" | "workflow">, servers: readonly string[]): string[] {
  const steps = stepServers(agent);
  const read = servers.filter((server) => steps.has(server));
  const rest = servers.filter((server) => !steps.has(server));
  return [
    ...(read.length ? [`No access any more? ${readsInStepText(`@${agent.name}`, read)}`] : []),
    ...(rest.length
      ? [`Signed in to ${rest.join(", ")} before and no access any more? Disconnect it under Sign-ins in the account menu, and runs go on without it.`]
      : []),
  ];
}
