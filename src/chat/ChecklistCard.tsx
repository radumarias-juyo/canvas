import { defaultAvatar, defaultColor } from "../../shared/agents.ts";
import { checklistCount, type ChatChecklistData, type ChecklistStatus } from "../../shared/checklist.ts";
import { AGENT_NAME } from "../../shared/mentions.ts";
import { AgentAvatar, type AgentBadge } from "./people.tsx";

/** Each status as a screen reader says it; the mark beside the step shows it. */
const STATUS_WORDS: Record<ChecklistStatus, string> = { todo: "to do", doing: "in progress", done: "done", skipped: "skipped" };

/** The badge of the agent that posted a checklist: none for pi's (its own), else the one the entry names, or its name's. */
function badgeOf(by: ChatChecklistData["by"]): AgentBadge | undefined {
  if (by.agentId === undefined) return undefined;
  return { avatar: by.avatar || defaultAvatar(by.name), color: by.color ?? defaultColor(by.name) };
}

/** How far a plan is, in a line: "3 of 5 done", with how many were skipped. */
export function countLine(steps: ChatChecklistData["steps"]): string {
  const { done, skipped, total } = checklistCount(steps);
  return `${done} of ${total} done${skipped ? ` · ${skipped} skipped` : ""}`;
}

/**
 * The plan an agent posted for a big ask (a `chat.checklist` entry), drawn where it was first posted with what its
 * latest entry says: who posted it, its title, how far it is, and each step with its mark (todo an empty circle, doing
 * a pulsing dot, done a check, skipped struck through) and its note. It edits in place as the agent updates it.
 */
export function ChecklistCard({ data }: { data: ChatChecklistData }) {
  const badge = badgeOf(data.by);
  const count = countLine(data.steps);
  return (
    <section className={data.final ? "checklist-card final" : "checklist-card"} aria-label={`Plan: ${data.title}`}>
      <header className="checklist-head">
        <AgentAvatar badge={badge} />
        <span className="checklist-title">
          <strong>{data.title}</strong>
          <small>
            {badge ? `@${data.by.name}` : AGENT_NAME}'s plan · <span aria-live="polite">{count}</span>
          </small>
        </span>
      </header>
      <ol className="checklist-steps">
        {data.steps.map((step, i) => (
          <li key={i} className={`checklist-step ${step.status}`}>
            <span className="checklist-mark" aria-hidden="true" />
            <span className="checklist-text">
              <span className="sr-only">{STATUS_WORDS[step.status]}: </span>
              <span className="checklist-step-text">{step.text}</span>
              {step.note && <small>{step.note}</small>}
            </span>
          </li>
        ))}
      </ol>
    </section>
  );
}
