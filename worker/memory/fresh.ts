import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Message, ToolResultMessage } from "@earendil-works/pi-ai";
import {
  CompactionEntry,
  LiveDoc,
  SystemEntry,
  ToolResultEntry,
  type ContextEdit,
  type Conversation,
  type EntryRecord,
  type Harness,
  type LiveState,
  type Submission,
  type TaskId,
} from "@earendil-works/pi-durable";
import { MEMORY_FORGET_TOOL, MEMORY_RECALL_TOOL } from "../../shared/memory.ts";

/** The entry that leaves a conversation's earlier prompts out of its context (see freshPrompt). */
const MEMORY_FRESH_KIND = "chat.memory-fresh";

/** What a memory_recall or memory_forget result says once it is left out (the latter quoted the note it forgot). */
const LEFT_OUT: Readonly<Record<string, string>> = {
  [MEMORY_RECALL_TOOL]: "(The notes this call found are left out: more people read this chat now. Call it again for those you may read.)",
  [MEMORY_FORGET_TOOL]: "(What this call said is left out: more people read this chat now.)",
};

/** How a compaction's summary is asked to be placed: its write's request id starts with it. */
const SUMMARY_REQUEST = "compaction:";

/** What a summary of the conversation says once it is left out. */
const SUMMARY_LEFT_OUT = "(A summary of the earlier conversation is left out here: more people read this chat now.)";

/** How a compaction's summary starts in the model's context (pi-durable's CompactionTask; test/memory-prompt.test.ts checks it). */
const SUMMARY_START = "The conversation history before this point was compacted into the following summary:";

/** `messages` with every compaction summary among them put in place of one that says it is left out. */
export function withoutSummaries(messages: readonly Message[]): Message[] {
  return messages.map((message) => {
    if (message.role !== "user") return message;
    const first = typeof message.content === "string" ? message.content : message.content.find((part) => part.type === "text")?.text;
    return first?.startsWith(SUMMARY_START) ? { ...message, content: SUMMARY_LEFT_OUT } : message;
  });
}

/**
 * Edits that leave the owner's notes out of the model's context: every prompt entry (`pi.system`) of `entries`
 * omitted, every memory_recall (and memory_forget) result put in place of one that says so (its call stays answered),
 * and a summary of the conversation before it (a compaction, which may have kept the notes) too.
 */
function leaveOutNotes(entries: readonly EntryRecord[]): ContextEdit[] {
  return entries.flatMap((entry): ContextEdit[] => {
    if (SystemEntry.is(entry)) return [{ target: entry.id, action: "omit" }];
    if (CompactionEntry.is(entry) && entry.model?.length)
      return [{ target: entry.id, action: "replace", messages: [{ role: "user", content: SUMMARY_LEFT_OUT, timestamp: Date.now() }] }];
    const result = ToolResultEntry.is(entry) ? (entry.model?.[0] as ToolResultMessage | undefined) : undefined;
    const leftOut = result?.role === "toolResult" ? LEFT_OUT[result.toolName] : undefined;
    if (!result || !leftOut) return [];
    return [{ target: entry.id, action: "replace", messages: [{ ...result, content: [{ type: "text", text: leftOut }] }] }];
  });
}

/** The harness calls freshPrompt stops a compaction with. */
export type Compactions = Pick<Harness, "inspect" | "abortTask" | "abortSubmission" | "waitForTask">;

/** How many times freshPrompt looks again for a compaction that read the notes before it gives up (the next turn tries again). */
const MAX_LOOKS = 5;

/**
 * Make `conversation`'s next model request carry no note it read so far: its prompt starts afresh (every earlier
 * prompt entry left out, so the planner finds none and writes all of the sections and tools again, as they are
 * then), and what memory_recall found is left out. The transcript keeps them; no model reads them. Resolves once those
 * edits are written: they are placed at once when the conversation is idle, else at its next step.
 *
 * Until they are placed, a compaction may summarize the context as it was, notes included, and place its summary after
 * them. So `done` looks again once they are in, and again after each look that found one: a compaction the
 * conversation runs on its own is stopped, its summary too if it waits to be placed (a later one compacts again); one a
 * turn waits for cannot be (the turn would fail), and is waited for; and every summary placed since the first look is
 * left out too. True once a look finds none; false when MAX_LOOKS were not enough. Until then the caller has each
 * request leave summaries out (withoutSummaries).
 */
export async function freshPrompt(
  conversation: Pick<Conversation, "id" | "context" | "submit" | "viewState">,
  harness: Compactions,
): Promise<{ done: Promise<boolean> }> {
  const view = await conversation.context(BACKGROUND_CONTEXT);
  const seen = new Set(view.entries.map((entry) => entry.id));
  const written = await leaveOut(conversation, view.entries);
  return { done: lookAgain(conversation, harness, seen, written) };
}

async function lookAgain(
  conversation: Pick<Conversation, "id" | "context" | "submit" | "viewState">,
  harness: Compactions,
  seen: Set<EntryRecord["id"]>,
  written: Submission | undefined,
): Promise<boolean> {
  for (let look = 0; look < MAX_LOOKS; look++) {
    await written?.wait(BACKGROUND_CONTEXT);
    const waited = await stopCompactions(conversation, harness);
    await Promise.allSettled(waited.map((taskId) => harness.waitForTask(taskId, BACKGROUND_CONTEXT)));
    const late = (await conversation.context(BACKGROUND_CONTEXT)).entries.filter((entry) => !seen.has(entry.id) && CompactionEntry.is(entry));
    if (!late.length && !waited.length) return true;
    for (const entry of late) seen.add(entry.id);
    written = await leaveOut(conversation, late);
  }
  return false;
}

/**
 * Stop the conversation's compactions that it runs on its own, and the summaries waiting to be placed; the ids of those
 * a turn waits for, which cannot be stopped.
 */
async function stopCompactions(conversation: Pick<Conversation, "id" | "viewState">, harness: Compactions): Promise<TaskId[]> {
  const live = await conversation.viewState(BACKGROUND_CONTEXT);
  let compactions: LiveState["compactions"];
  try {
    compactions = (live.value.docs[LiveDoc.definition.kind] as LiveState | undefined)?.compactions;
  } finally {
    live.dispose();
  }
  await Promise.all(compactions?.filter((each) => !each.blocking).map((each) => harness.abortTask(each.taskId, BACKGROUND_CONTEXT)) ?? []);
  // After the tasks: one that finished meanwhile has its summary waiting here, or placed already (the caller's look).
  const { submissions } = await harness.inspect(BACKGROUND_CONTEXT);
  await Promise.all(
    submissions
      .filter(
        (each) =>
          each.conversationId === conversation.id && each.type === "write" && each.status === "queued" && each.requestId?.startsWith(SUMMARY_REQUEST),
      )
      .map((each) => harness.abortSubmission(each.id, BACKGROUND_CONTEXT, conversation.id)),
  );
  return compactions?.filter((each) => each.blocking).map((each) => each.taskId) ?? [];
}

/** Write the edits that leave the notes of `entries` out, if any. */
async function leaveOut(conversation: Pick<Conversation, "submit">, entries: readonly EntryRecord[]): Promise<Submission | undefined> {
  const edits = leaveOutNotes(entries);
  return edits.length ? conversation.submit({ type: "write", entry: { kind: MEMORY_FRESH_KIND, edits } }, BACKGROUND_CONTEXT) : undefined;
}
