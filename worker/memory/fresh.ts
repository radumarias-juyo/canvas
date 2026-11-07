import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { ToolResultMessage } from "@earendil-works/pi-ai";
import { CompactionEntry, SystemEntry, ToolResultEntry, type ContextEdit, type Conversation, type EntryRecord } from "@earendil-works/pi-durable";
import { MEMORY_RECALL_TOOL } from "../../shared/memory.ts";

/** The entry that leaves a conversation's earlier prompts out of its context (see freshPrompt). */
const MEMORY_FRESH_KIND = "chat.memory-fresh";

/** What a memory_recall result says once it is left out. */
const RECALL_LEFT_OUT = "(The notes this call found are left out: more people read this chat now. Call it again for those you may read.)";

/** What a summary of the conversation says once it is left out. */
const SUMMARY_LEFT_OUT = "(A summary of the earlier conversation is left out here: more people read this chat now.)";

/**
 * Edits that leave the owner's notes out of the model's context: every prompt entry (`pi.system`) of `entries`
 * omitted, every memory_recall result put in place of one that says so (its call stays answered), and a summary of
 * the conversation before it (a compaction, which may have kept the notes) too.
 */
function leaveOutNotes(entries: readonly EntryRecord[]): ContextEdit[] {
  return entries.flatMap((entry): ContextEdit[] => {
    if (SystemEntry.is(entry)) return [{ target: entry.id, action: "omit" }];
    if (CompactionEntry.is(entry) && entry.model?.length)
      return [{ target: entry.id, action: "replace", messages: [{ role: "user", content: SUMMARY_LEFT_OUT, timestamp: Date.now() }] }];
    const result = ToolResultEntry.is(entry) ? (entry.model?.[0] as ToolResultMessage | undefined) : undefined;
    if (result?.role !== "toolResult" || result.toolName !== MEMORY_RECALL_TOOL) return [];
    return [{ target: entry.id, action: "replace", messages: [{ ...result, content: [{ type: "text", text: RECALL_LEFT_OUT }] }] }];
  });
}

/**
 * Make `conversation`'s next model request carry no note it read so far: its prompt starts afresh (every earlier
 * prompt entry left out, so the planner finds none and writes all of the sections and tools again, as they are
 * then), and what memory_recall found is left out. The transcript keeps them; no model reads them. Placed at once when
 * the conversation is idle, else at its next step.
 */
export async function freshPrompt(conversation: Pick<Conversation, "context" | "submit">): Promise<void> {
  const view = await conversation.context(BACKGROUND_CONTEXT);
  const edits = leaveOutNotes(view.entries);
  if (!edits.length) return;
  await conversation.submit({ type: "write", entry: { kind: MEMORY_FRESH_KIND, edits } }, BACKGROUND_CONTEXT);
}
