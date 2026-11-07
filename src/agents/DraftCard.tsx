import { useEffect, useState } from "react";
import type { AgentDefinition, AgentInput, AgentProposedDetails } from "../../shared/agents.ts";
import { AGENT_NAME } from "../../shared/mentions.ts";
import { errorMessage } from "../../shared/util.ts";
import { api } from "../api.ts";
import { Markdown } from "../chat/Markdown.tsx";
import { AgentAvatar, useSharedChat } from "../chat/people.tsx";
import { AppLink } from "../layout.tsx";
import { applyRowEdit, applySentenceEdit, linkedSegments, type RowEdit, type RowKey } from "./draft-edit.ts";
import { CONFLICT_NOTICE, glanceRows, instructionSteps, isConflict, runsLabel, stateLabel } from "./glance.ts";
import { agentPath } from "./nav.ts";
import { RowPicker, type PickerKnown } from "./RowPicker.tsx";
import { putAgent, readServers, reloadAgents, useAgents } from "./store.ts";

/**
 * Where the model drafted an agent (agent_propose), in place of a plain step: its badge, name and job, whether it is
 * on, the instructions as numbered steps, and the "at a glance" rows (scope, runs, reads, tells, knows), each with a
 * Change that opens a picker in place (RowPicker) and an Assumed badge where the model guessed. A word of the
 * instructions that names a row opens that row's picker too (dashed when guessed); a row changed rewrites the sentence
 * that said it, and a step edited changes the rows it names, then its steps are compiled from it (draft-edit.ts).
 * Test it runs it on today's data, nothing sent; Turn on turns it on as the owner read it, and brings it into this chat. Only whose
 * directory it was saved in has the draft: the chat's owner for pi's, the agent's owner for a roster agent's (`by`).
 * Anyone else sees who drafted it, for whom.
 */
export function DraftCard({ details, chatId, mine, by }: { details: AgentProposedDetails; chatId: string; mine: boolean; by?: string }) {
  const { agents } = useAgents();
  const agent = mine ? agents?.find((known) => known.id === details.agentId) : undefined;
  const drafter = by ? `@${by}` : AGENT_NAME;
  if (!mine) {
    return (
      <div className="agent-card compact">
        <p>
          {drafter} drafted an agent, <strong>@{details.name}</strong>, for {by ? "its" : "the chat's"} owner to review.
        </p>
      </div>
    );
  }
  if (!agent) {
    return (
      <div className="agent-card compact">
        <p>{agents === null ? `Loading the draft of @${details.name}…` : `The draft of @${details.name} was deleted.`}</p>
      </div>
    );
  }
  // A report can go to this chat only when it is the user's own: pi's draft, or one in their private chat.
  return <Card agent={agent} chatId={chatId} drafter={drafter} ownChat={!by} />;
}

/** Text that Markdown would format: a step with it shows as Markdown, without linked words. */
const MARKDOWN = /[*_`[\]<>#|]/;

/** What the card's pickers and linked words know: the deployment's servers, the user's skills, the chat's people. */
function useKnown(chatId: string, ownChat: boolean): PickerKnown {
  const people = useSharedChat();
  const [servers, setServers] = useState<string[]>([]);
  const [skills, setSkills] = useState<string[]>([]);
  useEffect(() => {
    let gone = false;
    void readServers().then(
      (list) => !gone && setServers(list.map((server) => server.name)),
      () => {},
    );
    void api.skills().then(
      (list) => !gone && setSkills(list.filter((skill) => skill.enabled).map((skill) => skill.name)),
      () => {},
    );
    return () => {
      gone = true;
    };
  }, []);
  const names = people ? [people.owner, ...people.members].map((person) => person.name) : [];
  return { servers, skills, people: names, ...(ownChat && { chat: { id: chatId } }) };
}

function Card({ agent, chatId, drafter, ownChat }: { agent: AgentDefinition; chatId: string; drafter: string; ownChat: boolean }) {
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ text: string; error?: boolean; run?: number } | null>(null);
  const [picking, setPicking] = useState<RowKey | null>(null);
  const [writing, setWriting] = useState<{ index: number; text: string } | null>(null);
  // The row whose words light up in the instructions, and the words whose row lights up: one or the other is pointed at.
  const [lit, setLit] = useState<RowKey | null>(null);
  const known = useKnown(chatId, ownChat);
  const state = stateLabel(agent, drafter);
  const steps = instructionSteps(agent.instructions);
  // A report sent to this chat names it by id: here, it is "This chat".
  const rows = glanceRows(agent).map((row) => (row.key === "tells" ? { ...row, value: row.value.replace(chatId, "This chat") } : row));
  const runs = runsLabel(agent.trigger);
  const scope = agent.scope?.list;
  const when = [runs && `${runs.value}${runs.note ? ` (${runs.note})` : ""}`, scope && `for each item of ${scope.server} ${scope.tool}`]
    .filter(Boolean)
    .join(", ");

  /** Save what an edit made of the definition: the card shows the version saved, or a newer one after a conflict. */
  const save = async (input: AgentInput): Promise<AgentDefinition | null> => {
    try {
      const saved = await api.saveAgent(agent.id, { ...input, version: agent.version });
      putAgent(saved);
      return saved;
    } catch (e) {
      if (isConflict(e)) {
        setNote({ text: CONFLICT_NOTICE, error: true });
        await reloadAgents();
      } else setNote({ text: errorMessage(e), error: true });
      return null;
    }
  };
  const saveRow = async (edit: RowEdit) => {
    setBusy(true);
    setNote(null);
    const { input, rewrite } = applyRowEdit(agent, edit);
    const saved = await save(input);
    if (saved) {
      setPicking(null);
      setNote({
        text:
          rewrite === "sentence"
            ? "Changed, and the sentence that said it now says the new value."
            : rewrite === "line"
              ? "Changed. No sentence said it plainly, so a short line at the end of the instructions says it now."
              : "Saved.",
      });
    }
    setBusy(false);
  };
  const saveStep = async () => {
    if (!writing?.text.trim()) return;
    setBusy(true);
    setNote(null);
    const { input, touched } = applySentenceEdit(agent, writing.index, writing.text, known);
    const saved = await save(input);
    if (saved) {
      setWriting(null);
      const rowsSaid = touched.length ? `Updated what it ${touched.map((key) => ROW_WORDS[key]).join(" and what it ")}` : "";
      setNote({ text: rowsSaid ? `${rowsSaid}. Updating its steps…` : "Updating its steps…" });
      // The steps that run follow the new words: compiled again from them (the rows the words named changed already).
      try {
        putAgent(await api.compileAgent(saved.id));
        setNote({ text: rowsSaid ? `${rowsSaid}, and its steps follow the new sentence.` : "Its steps follow the new sentence." });
      } catch (e) {
        const why = errorMessage(e);
        setNote({ text: `Saved, but its steps were not updated from the new sentence: ${why} Try again on its Workflow tab.`, error: true });
      }
    }
    setBusy(false);
  };

  const turnOn = async () => {
    setBusy(true);
    setNote(null);
    try {
      putAgent(await api.setAgentEnabled(agent, true));
      // Drafted for this chat: it joins it, so it can be called here at once.
      const joined = await api.addChatAgent(chatId, agent.id).then(
        () => null,
        (e: unknown) => errorMessage(e),
      );
      setNote(
        joined === null
          ? { text: `@${agent.name} is on and in this chat: call it with @${agent.name}.` }
          : { text: `@${agent.name} is on, but it could not join this chat: ${joined}`, error: true },
      );
    } catch (e) {
      setNote({ text: errorMessage(e), error: true });
      void reloadAgents();
    } finally {
      setBusy(false);
    }
  };
  const test = async () => {
    setBusy(true);
    setNote(null);
    try {
      const { dueAt } = await api.testAgent(agent.id);
      setNote({ text: "Testing it on today's data: nothing is sent or changed.", run: dueAt });
    } catch (e) {
      setNote({ text: errorMessage(e), error: true });
    } finally {
      setBusy(false);
    }
  };

  /** A step's words, each that names a row a button that opens that row's picker. */
  const linked = (text: string) =>
    MARKDOWN.test(text) ? (
      <Markdown text={text} />
    ) : (
      linkedSegments(text, agent, known).map((segment, i) =>
        segment.row ? (
          <button
            key={i}
            type="button"
            className={["agent-link", segment.assumed && "assumed", lit === segment.row && "lit"].filter(Boolean).join(" ")}
            title={`${segment.assumed ? "Guessed: c" : "C"}hange what it ${ROW_WORDS[segment.row]}`}
            onClick={() => (setWriting(null), setPicking(segment.row!))}
            onPointerEnter={() => setLit(segment.row!)}
            onPointerLeave={() => setLit(null)}
            onFocus={() => setLit(segment.row!)}
            onBlur={() => setLit(null)}
          >
            {segment.text}
          </button>
        ) : (
          <span key={i}>{segment.text}</span>
        ),
      )
    );
  /** One step, or the whole text, with its edit: a box in place of the words while it is written. */
  const step = (text: string, index: number) =>
    writing?.index === index ? (
      <form
        className="agent-step-edit"
        onSubmit={(event) => {
          event.preventDefault();
          void saveStep();
        }}
      >
        <textarea
          aria-label={steps ? `Step ${index + 1}` : "Instructions"}
          value={writing.text}
          rows={steps ? 2 : 5}
          autoFocus
          onChange={(e) => setWriting({ index, text: e.target.value })}
          onKeyDown={(e) => {
            if (e.key === "Escape") setWriting(null);
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) void saveStep();
          }}
        />
        <div className="row-picker-actions">
          <button type="submit" className="primary" disabled={busy || !writing.text.trim()}>
            {busy ? "Saving…" : "Save"}
          </button>
          <button type="button" disabled={busy} onClick={() => setWriting(null)}>
            Cancel
          </button>
        </div>
      </form>
    ) : (
      <>
        <span className="agent-step-text">{linked(text)}</span>{" "}
        <button
          type="button"
          className="link-button agent-step-change"
          disabled={busy}
          onClick={() => (setPicking(null), setWriting({ index, text }))}
        >
          Edit<span className="sr-only"> {steps ? `step ${index + 1}` : "the instructions"}</span>
        </button>
      </>
    );

  return (
    <article className="agent-card" aria-label={`Agent @${agent.name}`}>
      <header className="agent-card-head">
        <AgentAvatar badge={agent} />
        <div className="agent-card-title">
          <AppLink path={agentPath({ id: agent.id, chat: chatId })}>
            <strong>{agent.name}</strong>
          </AppLink>
          <span>{agent.job}</span>
        </div>
        <span className={`pill agent-state ${state.tone}`}>{state.text}</span>
        <div className="agent-card-actions">
          <button type="button" disabled={busy} onClick={() => void test()}>
            Test it
          </button>
          {!agent.enabled && (
            <button type="button" className="primary" disabled={busy} onClick={() => void turnOn()}>
              Turn on
            </button>
          )}
        </div>
      </header>
      {when && <p className="agent-card-when">{when}.</p>}
      <div className="agent-card-steps">
        {steps ? (
          <>
            <ol>
              {steps.steps.map((text, i) => (
                <li key={i}>{step(text, i)}</li>
              ))}
            </ol>
            {steps.rest && (
              <details>
                <summary>And its rules</summary>
                <Markdown text={steps.rest} />
              </details>
            )}
          </>
        ) : (
          <div className="agent-card-text">{step(agent.instructions, 0)}</div>
        )}
      </div>
      <dl className="agent-glance">
        {rows.map((row) => (
          <div
            key={row.key}
            className={["agent-glance-row", row.assumed && "assumed", lit === row.key && "lit", picking === row.key && "open"]
              .filter(Boolean)
              .join(" ")}
            onPointerEnter={() => setLit(row.key)}
            onPointerLeave={() => setLit(null)}
          >
            <dt>{row.label}</dt>
            <dd>
              <span className="agent-glance-value">
                {row.value}
                {row.assumed && <span className="pill assumed">Assumed</span>}
              </span>
              {row.note && <small>{row.note}</small>}
            </dd>
            {picking !== row.key && (
              <button
                type="button"
                className="link-button agent-glance-change"
                disabled={busy}
                aria-expanded={false}
                onClick={() => (setWriting(null), setPicking(row.key))}
              >
                Change<span className="sr-only"> {row.label.toLowerCase()}</span>
              </button>
            )}
            {picking === row.key && (
              <RowPicker
                agent={agent}
                row={row.key}
                known={known}
                busy={busy}
                onSave={(edit) => void saveRow(edit)}
                onCancel={() => setPicking(null)}
              />
            )}
          </div>
        ))}
      </dl>
      {note && (
        <p className={note.error ? "form-error" : "skills-note"} role="status">
          {note.text}
          {note.run !== undefined && (
            <>
              {" "}
              <AppLink path={agentPath({ id: agent.id, tab: "runs", chat: chatId, run: note.run })}>See the run</AppLink>
            </>
          )}
        </p>
      )}
    </article>
  );
}

/** What a row is about, as a sentence about the agent says it: "Change what it reads". */
const ROW_WORDS: Record<RowKey, string> = { scope: "covers", runs: "runs on", reads: "reads", tells: "tells", knows: "knows" };
