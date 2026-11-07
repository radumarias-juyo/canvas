import type { AssistantMessage, UserMessage } from "@earendil-works/pi-ai";
import type { EntryRecord } from "@earendil-works/pi-durable";
import { memo, useEffect, useState } from "react";
import type { AgentDefinition } from "../../shared/agents.ts";
import { textOf } from "../../shared/canonical.ts";
import { firstLine } from "../../shared/replies.ts";
import type { AgentRunDetail, AgentRunList, AgentRunView, RunDelivery, RunItemView } from "../../shared/runs.ts";
import { errorMessage } from "../../shared/util.ts";
import { api } from "../api.ts";
import { blocks, userText } from "../chat/entries.ts";
import { Markdown } from "../chat/Markdown.tsx";
import { calendarDay, sentLabel } from "../chat/SentTime.tsx";
import { formatCost } from "../chat/spend.ts";
import { StepRun, StepsProvider, tookFor } from "../chat/Steps.tsx";
import { stepItem, type StepItem } from "../chat/stepRuns.ts";
import { AppLink } from "../layout.tsx";
import { RUNS_EVENT, useLatest, useVisible } from "../sidebar.ts";
import type { AgentTabProps } from "./AgentPage.tsx";
import { runsLabel } from "./glance.ts";
import { agentPath } from "./nav.ts";
import { deliveryLabel, deliveryStatusLabel, itemGroups, itemsLabel, itemStatusLabel, runStatusLabel, signInWayOut, usedParts, whyLabel } from "./runs.ts";

/** How often the tab reads again while a run is going. */
const POLL_MS = 3_000;

/**
 * Read `load` while the page is in view: now, again when `key` changes or the page comes back into view, when the
 * sidebar's socket says this agent's runs changed (or may have, as it opens again; never with no `agentId`), and
 * POLL_MS after each read while `polling` says so (a step's progress within an item has no notice of its own). Only the
 * newest read's answer is kept.
 */
function useRead<T>(load: () => Promise<T>, agentId: string | null, key: string, polling: (value: T) => boolean = () => false) {
  const [error, setError] = useState<string | null>(null);
  const [value, read] = useLatest<T | null>(load, null, (e) => setError(e && errorMessage(e)));
  const visible = useVisible();
  useEffect(() => {
    if (visible) read();
  }, [key, visible, read]);
  useEffect(() => {
    if (agentId === null) return;
    const changed = (event: Event) => {
      const changedId = (event as CustomEvent<string | null>).detail;
      if (changedId === null || changedId === agentId) read();
    };
    addEventListener(RUNS_EVENT, changed);
    return () => removeEventListener(RUNS_EVENT, changed);
  }, [agentId, read]);
  const poll = visible && value !== null && polling(value);
  useEffect(() => {
    if (!poll) return;
    const timer = setTimeout(read, POLL_MS);
    return () => clearTimeout(timer);
  }, [poll, value, read]);
  return { value, error, again: read };
}

/** The agent whose runs the tab shows: the user's own, or someone else's shared in a chat (read-only, `enabled` unknown). */
type RunsAgent = Pick<AgentDefinition, "id" | "name" | "version" | "trigger" | "scope" | "workflow"> & { enabled?: boolean };

/**
 * Someone else's agent, opened from a chat that shares it: the runs show only those that posted their report there,
 * each with only that post (the server keeps the rest), and nothing to start or open.
 */
type Shared = { chatId: string; chatTitle?: string; ownerName: string };

/**
 * The Runs tab: when the agent runs next, Test it, and its runs, newest first; a run opens on what it sent and how it
 * got there, item by item, down to each item's full trace. For someone else's agent shared in a chat, only the runs
 * that posted in that chat, read-only.
 */
export function RunsTab({ subject, place, navigate }: AgentTabProps) {
  if (subject.kind === "new") return <p className="skills-note agent-runs-note">Save the agent first: its runs show here.</p>;
  const shared = subject.kind === "shared" ? { chatId: subject.chatId, chatTitle: subject.chatTitle, ownerName: subject.agent.ownerName } : undefined;
  return place.run === undefined ? (
    <RunList agent={subject.agent} chat={place.chat} shared={shared} navigate={navigate} />
  ) : (
    <RunPage agent={subject.agent} dueAt={place.run} chat={place.chat} shared={shared} navigate={navigate} />
  );
}

/** Where a shared agent's runs were posted, in words: "“Weekly numbers”", or "this chat". */
function chatName(shared: Shared): string {
  return shared.chatTitle ? `“${shared.chatTitle}”` : "this chat";
}

function RunList({ agent, chat, shared, navigate }: { agent: RunsAgent; chat?: string; shared?: Shared; navigate: (path: string) => void }) {
  const { value, error, again } = useRead<AgentRunList>(
    () => api.agentRuns(agent.id, shared?.chatId),
    agent.id,
    // Read again on a new version too (turned on or off, a new time): its next run moves with it.
    `${agent.id}:${agent.version}`,
    (read) => read.runs.some((run) => run.status === "running"),
  );
  const [testing, setTesting] = useState(false);
  const [testError, setTestError] = useState<string | null>(null);
  const runs = runsLabel(agent.trigger);
  const test = async () => {
    setTesting(true);
    setTestError(null);
    try {
      const { dueAt } = await api.testAgent(agent.id);
      navigate(agentPath({ id: agent.id, tab: "runs", chat, run: dueAt }));
    } catch (e) {
      setTestError(errorMessage(e));
      again();
    } finally {
      setTesting(false);
    }
  };
  const now = Date.now();
  return (
    <section className="agent-runs">
      <div className="agent-runs-head">
        <div className="agent-runs-when">
          <strong>{runs ? runs.value : "Runs only when asked"}</strong>
          {runs?.note && <small>{runs.note}</small>}
          {(shared || agent.enabled) && value?.nextRunAt && <small>Next run {aheadLabel(value.nextRunAt, now)}</small>}
          {runs && !shared && !agent.enabled && <small>Off: it runs again once you turn it on.</small>}
        </div>
        {!shared && (
          <div className="agent-runs-actions">
            {value?.homeChatId && (
              <AppLink path={`/c/${value.homeChatId}`} navigate={navigate} className="button">
                Open its chat
              </AppLink>
            )}
            <button type="button" className="primary" disabled={testing} onClick={() => void test()}>
              {testing ? "Starting…" : "Test it"}
            </button>
          </div>
        )}
      </div>
      {shared ? (
        <p className="skills-note">
          The runs that posted in {chatName(shared)}, with what they posted there. The rest of each run, and its other runs, stay {shared.ownerName}’s.
        </p>
      ) : (
        <p className="skills-note">Test it runs it now on today's data: nothing is sent or changed, and what it would have sent shows in the run.</p>
      )}
      {testError && <p className="form-error">{testError}</p>}
      {error && <p className="form-error">Could not read its runs: {error}</p>}
      {value === null && !error && <p className="skills-note">Reading its runs…</p>}
      {value && !value.runs.length && <p className="skills-note">{shared ? `No runs have posted in ${chatName(shared)} yet.` : "No runs yet."}</p>}
      {value && value.runs.length > 0 && (
        <ol className="run-list">
          {value.runs.map((run) => (
            <li key={run.dueAt}>
              <AppLink path={agentPath({ id: agent.id, tab: "runs", chat, run: run.dueAt })} navigate={navigate} className="run-row">
                <RunPill run={run} />
                <span className="run-row-text">
                  <span className="run-row-when">{[sentLabel(run.startedAt, now), whyLabel(run.why), itemsLabel(run.items)].filter(Boolean).join(" · ")}</span>
                  {run.summary && <span className="run-row-summary">{run.summary}</span>}
                </span>
                {run.cost > 0 && <span className="run-row-cost">{formatCost(run.cost)}</span>}
              </AppLink>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

/** A time ahead, as the runs list says it: "today at 7:00 AM", "Monday at 7:00 AM", or the date. */
function aheadLabel(at: number, now: number): string {
  // Due already (its alarm about to go off): not a weekday a week ahead.
  if (at <= now) return "now";
  const time = new Date(at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  // In calendar days, so a change of clocks between now and then does not move it.
  const days = Math.round((calendarDay(at) - calendarDay(now)) / 86_400_000);
  if (days === 0) return `today at ${time}`;
  if (days === 1) return `tomorrow at ${time}`;
  if (days < 7) return `${new Date(at).toLocaleDateString([], { weekday: "long" })} at ${time}`;
  return `${new Date(at).toLocaleDateString([], { month: "short", day: "numeric" })} at ${time}`;
}

function RunPill({ run }: { run: Pick<AgentRunView, "status" | "test"> }) {
  const state = runStatusLabel(run);
  return (
    <span className="run-pills">
      <span className={`pill run-state ${state.tone}`}>{state.text}</span>
      {run.test && <span className="pill run-test">Test</span>}
    </span>
  );
}

function RunPage({ agent, dueAt, chat, shared, navigate }: { agent: RunsAgent; dueAt: number; chat?: string; shared?: Shared; navigate: (path: string) => void }) {
  const { value: run, error } = useRead<AgentRunDetail>(
    () => api.agentRun(agent.id, dueAt, shared?.chatId),
    agent.id,
    `${agent.id}:${dueAt}`,
    (read) => read.status === "running",
  );
  const back = (
    <AppLink path={agentPath({ id: agent.id, tab: "runs", chat })} navigate={navigate} className="agent-back">
      ← All runs
    </AppLink>
  );
  if (!run) return <section className="agent-runs">{back}<p className={error ? "form-error" : "skills-note"}>{error ? `Could not read this run: ${error}` : "Reading the run…"}</p></section>;
  const scoped = run.itemsList.length > 1 || Boolean(run.itemsList[0]?.label);
  const used = usedParts(run.used);
  return (
    <section className="agent-runs run-detail">
      {back}
      <header className="run-detail-head">
        <RunPill run={run} />
        <h3>{new Date(run.startedAt).toLocaleString([], { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}</h3>
        <small>
          {[
            whyLabel(run.why),
            run.when,
            run.status !== "waiting" && run.endedAt !== undefined && `took ${tookFor(run.endedAt - run.startedAt)}`,
            run.cost > 0 && formatCost(run.cost),
          ]
            .filter(Boolean)
            .join(" · ")}
        </small>
      </header>
      {run.test && <p className="skills-note">A test: nothing was sent or changed. Below is what it would have sent.</p>}
      {run.status === "needs_sign_in" && run.needsSignIn && (
        <p className="form-error">
          It waits for you to sign in to{" "}
          {run.needsSignIn.map((server, index) => (
            <span key={server}>
              {index > 0 && ", "}
              <a href={`/api/mcp/sign-in/${encodeURIComponent(server)}`} target="_blank" rel="noopener">
                {server}
              </a>
            </span>
          ))}
          . The run goes on by itself once you do; if several mornings waited, only the newest goes.{" "}
          {signInWayOut(agent, run.needsSignIn).join(" ")}
        </p>
      )}
      {run.status === "waiting" && (
        <p className="skills-note">
          {run.summary ?? "It waits for you to approve a call."} Approve or decline it in the feed's Needs you or in the run's chat: approved, the run goes on
          from there; declined or expired, that item stops.
        </p>
      )}
      {/* A write the gate refused (its level, a rule that blocks): that item stopped there, nothing of it changed or went out. */}
      {(run.status === "failed" || run.status === "blocked") && run.summary && <p className="form-error">{run.summary}</p>}
      {/* Why nothing went: a condition, or a sign-in that let a newer run go instead. */}
      {run.status === "not_today" && run.summary && <p className="skills-note">{run.summary}</p>}

      {scoped && <ItemGroups items={run.itemsList} />}

      <h4 className="run-section">What it sent</h4>
      {run.deliveries.length ? (
        <ul className="run-deliveries">
          {run.deliveries.map((delivery, index) => (
            <Delivery key={index} delivery={delivery} />
          ))}
        </ul>
      ) : (
        <p className="skills-note">{run.status === "running" || run.status === "waiting" ? "Nothing yet: it sends once every item is done." : "Nothing: no item got to a step that sends."}</p>
      )}

      <h4 className="run-section">How it got there</h4>
      {shared ? (
        <p className="skills-note">Only {shared.ownerName} sees how a run got there: it reads as them, with their sign-ins.</p>
      ) : (
        <ol className="run-items">
          {run.itemsList.map((item, index) => (
            <RunItem key={item.item} id={scoped ? itemAnchor(index) : undefined} agentId={agent.id} dueAt={run.dueAt} item={item} scoped={scoped} />
          ))}
        </ol>
      )}

      {used.length > 0 && (
        <div className="run-used">
          <strong id="run-used-head">Used</strong>
          <dl aria-labelledby="run-used-head">
            {used.map(({ what, text }) => (
              <div key={what}>
                <dt>{what}</dt>
                <dd>{text}</dd>
              </div>
            ))}
          </dl>
        </div>
      )}
    </section>
  );
}

/** An item's place in How it got there, for its line in the groups to scroll to. */
function itemAnchor(index: number): string {
  return `run-item-${index}`;
}

/**
 * A scoped run's items at a glance, grouped by how they went (acted on, not today, …), each with its line; its name
 * scrolls to its steps under How it got there.
 */
function ItemGroups({ items }: { items: readonly RunItemView[] }) {
  const index = new Map(items.map((item, at) => [item.item, at]));
  return (
    <div className="run-groups">
      {itemGroups(items).map((group) => (
        <section key={group.status} className={`run-group ${group.status}`} aria-labelledby={`run-group-${group.status}`}>
          <h4 id={`run-group-${group.status}`} className="run-group-head">
            {group.title}
            <span className="run-group-count">{group.count}</span>
          </h4>
          <ul>
            {group.items.map(({ item, line }) => (
              <li key={item.item}>
                <button
                  type="button"
                  className="link-button run-group-name"
                  onClick={() => document.getElementById(itemAnchor(index.get(item.item)!))?.scrollIntoView({ behavior: "smooth", block: "start" })}
                >
                  {item.label || "This run"}
                </button>
                {line && <span className="run-group-line">{line}</span>}
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}

function Delivery({ delivery }: { delivery: RunDelivery }) {
  const state = deliveryStatusLabel(delivery.status);
  return (
    <li className="run-delivery">
      <div className="run-delivery-line">
        <span>{deliveryLabel(delivery)}</span>
        <span className={`pill run-state ${state.tone}`}>{state.text}</span>
      </div>
      {delivery.detail && <small>{delivery.detail}</small>}
      {delivery.text && (
        <div className="bubble markdown run-report">
          <Markdown text={delivery.text} />
        </div>
      )}
    </li>
  );
}

function RunItem({ id, agentId, dueAt, item, scoped }: { id?: string; agentId: string; dueAt: number; item: RunItemView; scoped: boolean }) {
  const [trace, setTrace] = useState(false);
  // Read on the first Show, then kept: hiding it again only hides it.
  const [opened, setOpened] = useState(false);
  return (
    <li id={id} className={`run-item ${item.status}`}>
      {scoped && (
        <div className="run-item-head">
          <strong>{item.label}</strong>
          <span className="pill">{itemStatusLabel(item.status)}</span>
        </div>
      )}
      <ol className="run-steps">
        {item.steps.map((step, index) => (
          <li key={index} className={step.ok ? "run-step" : "run-step stopped"}>
            <span className="run-step-mark" aria-label={step.ok ? "Done" : "Stopped"}>
              {step.ok ? "✓" : "•"}
            </span>
            <span className="run-step-text">
              <span>{step.label}</span>
              {step.detail && <small>{step.detail}</small>}
            </span>
            <span className="run-step-time">
              {step.ms >= 100 && tookFor(step.ms)}
              {step.cost ? ` · ${formatCost(step.cost)}` : ""}
            </span>
          </li>
        ))}
        {item.status === "running" && <li className="run-step running">Running…</li>}
      </ol>
      {item.reason && item.status !== "acted" && <p className={item.status === "failed" ? "form-error" : "skills-note"}>{item.reason}</p>}
      {item.session && (
        <button
          type="button"
          className="link-button"
          aria-expanded={trace}
          onClick={() => {
            setTrace(!trace);
            setOpened(true);
          }}
        >
          {trace ? "Hide its full trace" : "Show its full trace"}
        </button>
      )}
      {opened && (
        <div hidden={!trace}>
          <RunTrace agentId={agentId} dueAt={dueAt} item={item.item} live={item.status === "running"} />
        </div>
      )}
    </li>
  );
}

/**
 * One item's session as it ran: what it was given, its steps (each as the chat shows a step) and what it answered. Read
 * again as the run moves on while the item is `live`, and once more as it ends; the same props across the run page's
 * reads render nothing new.
 */
const RunTrace = memo(function RunTrace({ agentId, dueAt, item, live }: { agentId: string; dueAt: number; item: string; live: boolean }) {
  const { value, error } = useRead(() => api.agentRunTrace(agentId, dueAt, item), live ? agentId : null, `${agentId}:${dueAt}:${item}:${live}`);
  const entries = value?.entries;
  if (error && !entries) return <p className="form-error">Could not read its trace: {error}</p>;
  if (!entries) return <p className="skills-note">Reading its trace…</p>;
  if (!entries.length) return <p className="skills-note">Its session has nothing yet.</p>;
  return (
    <div className="run-trace">
      <StepsProvider entries={entries} tools={[]} busy={false}>
        {entries.map((entry) => (
          <TraceEntry key={entry.id} entry={entry} />
        ))}
      </StepsProvider>
    </div>
  );
});

function TraceEntry({ entry }: { entry: EntryRecord }) {
  const message = entry.model?.[0];
  if (message?.role === "assistant") {
    const answer = message as AssistantMessage;
    const items = answer.content.flatMap((block, i): StepItem[] => {
      const step = stepItem(answer, block, i, false);
      return step ? [step] : [];
    });
    const text = textOf(blocks(answer.content), "\n\n");
    return (
      <>
        {items.length > 0 && <StepRun items={items} />}
        {text && (
          <div className="bubble markdown">
            <Markdown text={text} />
          </div>
        )}
      </>
    );
  }
  if (message?.role === "user") {
    const text = userText(message as UserMessage);
    if (!text) return null;
    return (
      <details className="run-trace-input">
        <summary>{firstLine(text, 120)}</summary>
        <pre>{text}</pre>
      </details>
    );
  }
  return null;
}
