import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { SystemEntry, type ContextEdit, type Conversation, type EntryRecord } from "@earendil-works/pi-durable";

/** The entry that leaves a conversation's earlier prompts out of its context (see freshPrompt). */
export const MEMORY_FRESH_KIND = "chat.memory-fresh";

/** Edits that leave every prompt entry (`pi.system`) of `entries` out of the model's context. */
export function omitPrompts(entries: readonly EntryRecord[]): ContextEdit[] {
  return entries.filter((entry) => SystemEntry.is(entry)).map((entry) => ({ target: entry.id, action: "omit" }));
}

/**
 * Make `conversation`'s next model request carry its prompt afresh: an entry leaves every earlier prompt entry out of
 * its context, so the prompt planner finds none and writes all of the sections and tools again, as they are then. The
 * transcript keeps them; no model reads them. Placed at once when the conversation is idle, else at its next step.
 */
export async function freshPrompt(conversation: Pick<Conversation, "context" | "submit">): Promise<void> {
  const view = await conversation.context(BACKGROUND_CONTEXT);
  const edits = omitPrompts(view.entries);
  if (!edits.length) return;
  await conversation.submit({ type: "write", entry: { kind: MEMORY_FRESH_KIND, edits } }, BACKGROUND_CONTEXT);
}
