import { useState } from "react";
import type { AgentInput } from "../../shared/agents.ts";
import type { AgentTabProps } from "../agents/AgentPage.tsx";
import { useAgents } from "../agents/store.ts";
import { LearnedOvernight } from "./Dreams.tsx";
import { AddNote, NoteList, Reach, type NoteTargets } from "./Notes.tsx";
import { useMemory } from "./store.ts";

/**
 * What one agent knows: the notes it reads (its own, and the user's own in private chats), those it learned in chats,
 * and what it reaches (its servers, the user's files, the skills). Only for the user's own agent: someone else's,
 * shared in a chat, keeps its notes with its owner.
 */
export function KnowsTab({ subject, save }: AgentTabProps) {
  const { notes, coverage, dreams, error } = useMemory();
  const { agents } = useAgents();
  const [adding, setAdding] = useState(false);
  if (subject.kind !== "own") {
    return (
      <p className="skills-note">
        {subject.kind === "new" ? "Save the agent first: then you can give it notes." : "What this agent knows stays with its owner."}
      </p>
    );
  }
  const { agent } = subject;
  const targets: NoteTargets = { agents: agents ?? [], chats: [] };
  // Its own notes and those it learned in chats, and the user's own, which it reads in private chats. Those its dreams
  // wrote show under Learned overnight.
  const known = (notes ?? []).filter((note) => (note.agentId === agent.id || note.scope === "user") && !(note.source === "overnight" && note.agentId === agent.id));
  return (
    <div className="memory knows">
      <div className="knows-head">
        <p className="skills-note">
          @{agent.name} reads its own notes wherever it works, and yours (Just me) in your private chats. What it learns in a shared chat stays with
          that chat.
        </p>
        <button type="button" onClick={() => setAdding(true)} disabled={adding}>
          + Add a note
        </button>
      </div>
      {adding && <AddNote targets={targets} initial={`agent:${agent.id}`} onDone={() => setAdding(false)} />}
      <LearnedOvernight
        subject={agent.id}
        who={`@${agent.name}`}
        notes={notes ?? []}
        dreams={dreams}
        learns={agent.learns === true}
        // The page's save keeps the rest of the definition as it is (keptBy): only `learns` changes.
        onLearns={(learns) => save({ learns } as AgentInput, agent.version)}
        about="Each night it reads how people worked with it that day and keeps what saves time. What it learns in a shared chat stays with that chat; a lesson for everywhere, or a fact, waits for you here and in Needs you."
      />
      {error && <p className="form-error">Could not read the notes: {error}</p>}
      {notes === null ? (
        <p className="skills-note">Loading…</p>
      ) : (
        <NoteList notes={known} targets={targets} empty={`@${agent.name} has no notes yet.`} />
      )}
      <Reach coverage={coverage} servers={agent.servers} who={`@${agent.name}`} />
    </div>
  );
}
