// The write gate: every MCP call whose tool is not read-only goes through `WriteGate.check` before it leaves the chat
// object (McpHub.call asks it). The caller's level and the guardrails decide whether the call runs, is refused, or is
// held as an action for the owner (shared/limits.ts). An action the owner approves comes back through the same gate,
// which runs it exactly as stored, after checking the rules that block once more (a quiet date may have begun).

import { AUTONOMY_LABELS, type AgentDefinition, type AutonomyLevel, type StepInput } from "../../../shared/agents.ts";
import {
  DEFAULT_APPROVAL_HOURS,
  hitText,
  strictest,
  violation,
  type ActionActor,
  type CallOutcome,
  type GuardrailRule,
  type PendingActionView,
  type RuleHit,
} from "../../../shared/limits.ts";
import type { ToolInfo } from "../../../shared/protocol.ts";
import type { ActionOrigin, NewAction } from "./actions.ts";

/** Who makes a call, as the caller of McpHub.call says it. */
export type GateContext =
  /** A model's tool call in one of the chat's pi sessions (pi's own, an agent's, a run's). */
  | { kind: "session"; session: string }
  /** A run's do step, or its tell through an outside tool. `test`: a Test it run, which changes nothing. */
  | { kind: "run"; agentId: string; dueAt: number; item: string; step: string; test?: boolean }
  /** A published page's call, by its author (pages call write tools only for their author). */
  | { kind: "page"; artifactId: string }
  /** An action its owner approved: run as stored. */
  | { kind: "approved"; actionId: string };

/** Who a context comes to: whose call it is, how far it may go, and where a held action's outcome goes back. */
export interface Caller {
  actor: ActionActor;
  /** The agent whose own rules and wait apply; none for pi or a page (the owner's rules for all agents still do). */
  agent?: Pick<AgentDefinition, "id" | "name" | "guardrails" | "approvalHours">;
  level: AutonomyLevel;
  /** Why it is at that level, in words: "on a member's message". */
  because: string;
  origin: Omit<ActionOrigin, "level">;
  /** A page cannot wait for an approval: what would be held is refused, with what to do instead. */
  noHold?: true;
}

/** A call as the gate sees it. */
export interface GateCall {
  server: string;
  tool: string;
  input: StepInput;
  /** Its listing; absent for a tool the server does not list (treated as one that changes data). */
  info?: ToolInfo;
}

export type GateVerdict =
  | { run: true; warnings: string[]; caller: Caller; actionId?: string }
  | { run: false; outcome: "refused"; message: string }
  | { run: false; outcome: "held"; message: string; action: PendingActionView };

/** What the gate needs of the chat object it guards. Tests pass fakes. */
export interface GateHost {
  now(): number;
  /** Who a context is; throws when it names nobody that may call (an unknown session). */
  caller(context: GateContext): Promise<Caller>;
  /** The owner's rules for all their agents (and pi, and pages). */
  userRules(): Promise<GuardrailRule[]>;
  /** A read-only tool's result's value at `path`, for a maxChange rule; undefined when it cannot be read. */
  readValue(server: string, tool: string, input: StepInput, path: string): Promise<unknown>;
  /** How many calls of server.tool ran since `since` (epoch ms), the owner's in all their chats. */
  callsSince(server: string, tool: string, since: number): Promise<number>;
  /** Midnight of the day `at` falls on, in `tz`. */
  dayStart(at: number, tz: string): number;
  /** Keep a call in the owner's log of calls. Never throws. */
  log(entry: { actor: string; server: string; tool: string; outcome: CallOutcome; detail?: string }): void;
  /** Hold a call as an action: kept, its card posted, the owner told; the action as kept. */
  hold(action: NewAction): Promise<PendingActionView>;
  /** One of the owner's agents, for the rules it has now; null when it is gone. */
  agent(agentId: string): Promise<Pick<AgentDefinition, "guardrails"> | null>;
  /** An approved action about to run, if it is one and is running now (its owner pressed Approve). */
  approved(actionId: string): { action: PendingActionView; origin: ActionOrigin } | null;
}

/** The values a rule needs that the call does not carry: the current value (maxChange), today's calls (callsPerDay). */
async function factsFor(host: GateHost, rule: GuardrailRule, call: GateCall, at: number) {
  if (rule.kind === "callsPerDay") return { callsToday: await host.callsSince(call.server, call.tool, host.dayStart(at, rule.tz ?? "UTC")) };
  if (rule.kind !== "maxChange" || !rule.current) return {};
  const input = fillFromCall(rule.current.input, call.input);
  try {
    const value = await host.readValue(call.server, rule.current.tool, input, rule.current.path);
    const number = typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value) : NaN;
    return { current: Number.isFinite(number) ? number : null };
  } catch {
    return { current: null };
  }
}

/** A read's input with each "{{input.path}}" filled from the call's input (a whole one keeps its type). */
export function fillFromCall(template: StepInput, input: StepInput): StepInput {
  const at = (path: string): unknown =>
    path
      .split(".")
      .reduce<unknown>((value, key) => (value && typeof value === "object" ? (value as Record<string, unknown>)[key] : undefined), input);
  const fill = (value: unknown): unknown => {
    if (typeof value === "string") {
      const whole = /^\{\{\s*input\.([A-Za-z0-9_.$-]+)\s*\}\}$/.exec(value.trim());
      if (whole) return at(whole[1]) ?? null;
      return value.replace(/\{\{\s*input\.([A-Za-z0-9_.$-]+)\s*\}\}/g, (_, path: string) => {
        const found = at(path);
        return typeof found === "string" ? found : JSON.stringify(found ?? null);
      });
    }
    if (Array.isArray(value)) return value.map(fill);
    if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, fill(item)]));
    return value;
  };
  return fill(template) as StepInput;
}

/** The rules that fire for a call, of `rules`. */
export async function hitsFor(host: GateHost, rules: readonly GuardrailRule[], call: GateCall, at: number): Promise<RuleHit[]> {
  const checked = await Promise.all(
    rules.map(async (rule): Promise<RuleHit | null> => {
      const facts = await factsFor(host, rule, call, at);
      const reason = violation(rule, { server: call.server, tool: call.tool, input: call.input, at }, facts);
      return reason === null ? null : { rule, reason };
    }),
  );
  return checked.filter((hit): hit is RuleHit => hit !== null);
}

/** The level names a held call's words use: "at Recommend". */
function at(level: AutonomyLevel): string {
  return `at ${AUTONOMY_LABELS[level]}`;
}

export class WriteGate {
  readonly #host: GateHost;

  constructor(host: GateHost) {
    this.#host = host;
  }

  /** Whether a call that changes data may run now; when not, it is refused or held (see the file's head). */
  async check(call: GateCall, context: GateContext): Promise<GateVerdict> {
    const host = this.#host;
    if (context.kind === "approved") return this.#approved(call, context.actionId);
    let caller: Caller;
    try {
      caller = await host.caller(context);
    } catch (error) {
      const message = `Not run: ${error instanceof Error ? error.message : String(error)}`;
      host.log({ actor: "unknown", server: call.server, tool: call.tool, outcome: "refused", detail: message });
      return { run: false, outcome: "refused", message };
    }
    const who = caller.actor.agentId ? `@${caller.actor.name}` : caller.actor.name;
    const refuse = (message: string): GateVerdict => {
      host.log({ actor: who, server: call.server, tool: call.tool, outcome: "refused", detail: message });
      return { run: false, outcome: "refused", message };
    };
    if (context.kind === "run" && context.test) return refuse("Not run: a test changes nothing.");
    const now = host.now();
    const rules = [...(caller.agent?.guardrails ?? []), ...(await host.userRules())];
    const hits = await hitsFor(host, rules, call, now);
    const effect = strictest(hits);
    const said = (wanted: GuardrailRule["effect"]) => hits.filter((hit) => hit.rule.effect === wanted).map(hitText);
    if (effect === "block") return refuse(`Not run: a rule blocks it: ${said("block").join("; ")}.`);
    if (caller.level === 1) {
      return refuse(`Not run: ${who} is ${at(1)} ${caller.because}, so it changes nothing. Say what you would do instead.`);
    }
    const warnings = said("warn");
    const asks = effect === "approve" ? said("approve") : [];
    if (caller.level === 4 && !asks.length) {
      // Logged as it ends, with what it came to (WriteGate.ran).
      return { run: true, warnings, caller };
    }
    if (caller.noHold)
      return refuse(`Not run: it needs your approval (${asks.join("; ")}), which a page cannot wait for. Ask for it in a chat instead.`);
    const kind = caller.level === 2 ? "proposal" : "approval";
    const why =
      caller.level === 4
        ? `A rule asks for your approval: ${asks.join("; ")}.`
        : `${who} is ${at(caller.level)} ${caller.because}${asks.length ? `, and a rule asks for your approval: ${asks.join("; ")}` : ""}.`;
    const hours = caller.agent?.approvalHours ?? DEFAULT_APPROVAL_HOURS;
    const action = await host.hold({
      kind,
      actor: caller.actor,
      server: call.server,
      tool: call.tool,
      input: call.input,
      why,
      ...(warnings.length && { warnings }),
      expiresAt: now + hours * 3_600_000,
      origin: { ...caller.origin, level: caller.level },
    });
    host.log({ actor: who, server: call.server, tool: call.tool, outcome: "held", detail: why });
    // A run's record is read by its owner; a session's answer by the model.
    const owner = context.kind === "run" ? { to: "you", whose: "your" } : { to: "your owner", whose: "your owner's" };
    const message =
      kind === "proposal"
        ? `Not run yet: proposed to ${owner.to} as a card with this exact call; it runs only if ${owner.to === "you" ? "you press" : "they press"} Run (it expires in ${hours} hours). ${why}`
        : `Not run yet: waiting for ${owner.whose} approval, with this exact call (it expires in ${hours} hours). ${why}`;
    return { run: false, outcome: "held", message, action };
  }

  /** An action its owner approved: only while it runs, only its stored call, and not when a rule now blocks it. */
  async #approved(call: GateCall, actionId: string): Promise<GateVerdict> {
    const host = this.#host;
    const found = host.approved(actionId);
    const same =
      found &&
      found.action.server === call.server &&
      found.action.tool === call.tool &&
      JSON.stringify(found.action.input) === JSON.stringify(call.input);
    if (!found || !same) return { run: false, outcome: "refused", message: "Not run: no such approved action, or not its call." };
    const { action, origin } = found;
    const agent = action.actor.agentId ? await host.agent(action.actor.agentId).catch(() => null) : null;
    const rules = [...(agent?.guardrails ?? []), ...(await host.userRules())];
    const hits = (await hitsFor(host, rules, call, host.now())).filter((hit) => hit.rule.effect === "block");
    const actor = action.actor.agentId ? `@${action.actor.name}` : action.actor.name;
    if (hits.length) {
      const message = `Not run: a rule blocks it now: ${hits.map(hitText).join("; ")}.`;
      host.log({ actor, server: call.server, tool: call.tool, outcome: "refused", detail: message });
      return { run: false, outcome: "refused", message };
    }
    return {
      run: true,
      warnings: [],
      actionId,
      caller: { actor: action.actor, level: origin.level as AutonomyLevel, because: "approved by you", origin: {} },
    };
  }

  /** A call the gate let through ended: logged with what it came to. */
  ran(call: Pick<GateCall, "server" | "tool">, verdict: Extract<GateVerdict, { run: true }>, error?: string): void {
    const actor = verdict.caller.actor.agentId ? `@${verdict.caller.actor.name}` : verdict.caller.actor.name;
    const notes = [...(verdict.actionId ? ["approved"] : []), ...verdict.warnings, ...(error ? [error] : [])];
    this.#host.log({
      actor,
      server: call.server,
      tool: call.tool,
      outcome: error ? "failed" : verdict.warnings.length ? "warned" : "ran",
      ...(notes.length && { detail: notes.join("; ").slice(0, 500) }),
    });
  }
}
