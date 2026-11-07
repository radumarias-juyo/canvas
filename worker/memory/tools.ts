import { Type } from "@earendil-works/pi-ai";
import { defineExtension, defineTool, section, type Extension } from "@earendil-works/pi-durable";
import {
  MAX_NOTE_CHARS,
  MAX_RECALLED,
  MEMORY_FORGET_TOOL,
  MEMORY_NOTE_TOOL,
  MEMORY_RECALL_TOOL,
  noteLine,
  type MemoryKind,
  type MemoryNote,
  type MemoryScope,
} from "../../shared/memory.ts";
import { text } from "../agent/output.ts";
import type { Learned, LearnedNote } from "./memory.ts";

/**
 * What the memory tools and section need from the chat they run in. Each call names the conversation (pi's, or an
 * agent's session) it comes from: the chat tells from it who reads and who asks, so the model never says whose notes
 * it may see.
 */
export interface MemoryHost {
  note(conversation: string, note: LearnedNote): Promise<Learned>;
  recall(conversation: string, query: string): Promise<MemoryNote[]>;
  forget(conversation: string, id: string): Promise<MemoryNote | { error: string }>;
  /** The prompt's memory section for the conversation: its notes as they were when its turn started. */
  section(conversation: string): Promise<string>;
}

/** What memory_note says it saved. */
function savedText(saved: Exclude<Learned, { error: string }>): string {
  const { note } = saved;
  const where =
    note.scope === "user" ? "for the owner, in their private chats" : note.scope === "agent" ? "for you, wherever you work" : "for this chat";
  const narrowed = saved.narrowed ? " This chat is shared, so what is learned here stays with it, until the owner moves it under Memory." : "";
  const wait = note.confirmed ? "" : " It waits for the owner to confirm it under Memory; until then no agent reads it.";
  return `${saved.existed ? "Already kept" : "Saved"} [${note.id}] ${where}.${narrowed}${wait}`;
}

/**
 * memory_note, memory_recall and memory_forget, and the prompt section with the notes this conversation reads. A turn
 * its owner did not ask for gets only memory_recall (allowedTools), and pi in a chat others are in saves only notes
 * that wait for a confirm (UserMemory.learn).
 */
export function memoryExtension(host: MemoryHost): Extension {
  return defineExtension({
    name: "memory",
    sections: [section("memory", ({ conversationId }) => host.section(String(conversationId)))],
    tools: [
      defineTool({
        name: MEMORY_NOTE_TOOL,
        description:
          "Keep a short note for later conversations: how the owner wants things (a preference: units, format, tone, who to ask), or a fact worth knowing " +
          "next time (a fact: a target, an id, a rule your numbers depend on). Save one when the owner tells you, or clearly shows it; never secrets, passwords, " +
          "keys or what others in the chat say about themselves. A fact waits for the owner to confirm it before anyone reads it. " +
          'scope: "user" for something about the owner, "agent" for something only you need, "chat" for something about this chat. In a shared chat a note stays with the chat.',
        parameters: Type.Object({
          text: Type.String({ description: `One short sentence that makes sense on its own, up to ${MAX_NOTE_CHARS} characters.` }),
          kind: Type.Union([Type.Literal("preference"), Type.Literal("fact")]),
          scope: Type.Union([Type.Literal("user"), Type.Literal("agent"), Type.Literal("chat")]),
        }),
        execute: async (args, api) => {
          const saved = await host.note(String(api.conversationId), {
            text: args.text,
            kind: args.kind as MemoryKind,
            scope: args.scope as MemoryScope,
          });
          if ("error" in saved) throw new Error(`Not saved: ${saved.error}`);
          return { output: text(savedText(saved)) };
        },
      }),
      defineTool({
        name: MEMORY_RECALL_TOOL,
        description: `Look through the memory notes this conversation may read: those holding every word of query (any, for an empty one), up to ${MAX_RECALLED}, the ones not in your instructions first.`,
        parameters: Type.Object({ query: Type.Optional(Type.String({ description: "Words to look for." })) }),
        execute: async (args, api) => {
          const found = await host.recall(String(api.conversationId), args.query ?? "");
          return { output: text(found.length ? found.map(noteLine).join("\n") : "No notes found.") };
        },
      }),
      defineTool({
        name: MEMORY_FORGET_TOOL,
        description: "Forget one memory note, by the id in brackets, when the owner asks you to. It can be brought back under Memory.",
        parameters: Type.Object({ id: Type.String() }),
        execute: async (args, api) => {
          const forgotten = await host.forget(String(api.conversationId), args.id.replace(/[[\]\s]/g, ""));
          if ("error" in forgotten) throw new Error(forgotten.error);
          // Not its text: a note may be the owner's own, and the result stays in the transcript.
          return { output: text(`Forgot [${forgotten.id}]. The owner can bring it back under Memory.`) };
        },
      }),
    ],
  });
}
