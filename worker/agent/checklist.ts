import { Type } from "@earendil-works/pi-ai";
import { defineExtension, defineTool, type Extension } from "@earendil-works/pi-durable";
import {
  CHECKLIST_STATUSES,
  CHECKLIST_TOOL,
  checkChecklist,
  isFinal,
  MAX_CHECKLIST_STEPS,
  MAX_NOTE_CHARS,
  MAX_STEP_CHARS,
  MAX_TITLE_CHARS,
  type ChecklistInput,
} from "../../shared/checklist.ts";
import { text } from "./output.ts";

export { CHECKLIST_TOOL };

/** What the checklist tool needs from the chat. */
export interface ChecklistScope {
  /**
   * Post or update the checklist in the chat's log for the session `conversation` (whose speaker the chat knows).
   * Placed once per `requestId`. Its id, or why not.
   */
  postChecklist(conversation: string, checklist: ChecklistInput, requestId: string): Promise<{ id: string } | { error: string }>;
}

/**
 * checklist: an agent given a big ask (pi, or an agent of the chat's roster, each in its own session) posts its plan
 * in the chat as a card of steps, and calls again as each stage finishes, so people see one card that edits in place.
 * The arguments are checked here; the chat places the entry, as the session's speaker, and keeps each card its author's.
 */
export function checklistExtension(scope: ChecklistScope): Extension {
  return defineExtension({
    name: "checklist",
    tools: [
      defineTool({
        name: CHECKLIST_TOOL,
        // The chat places each call's entry once (its request id), so a rerun after a restart posts nothing twice.
        replay: "safe",
        description:
          "Show your plan in the chat as a checklist card, for an ask with several stages that takes a while (several tool calls, a page built in steps, " +
          "a report from many sources); never for a quick answer or a single step. Post the plan first, before the work, with every step todo (or the " +
          "first doing); the call returns the checklist's id. Then, as each stage finishes, call again with that id and the full list of steps, updated: " +
          "the same card edits in place, so send every step each time, not only the one that changed. Mark a step done when it is, doing while you work " +
          "on it, skipped when it turns out not to be needed (say why in its note). Finish with every step done or skipped. Keep steps short, one line each.",
        parameters: Type.Object({
          id: Type.Optional(
            Type.String({ description: "The id the first call returned, to update that checklist; leave it out to post a new one." }),
          ),
          title: Type.String({ description: `What the plan is for, in a few words. Up to ${MAX_TITLE_CHARS} characters.` }),
          steps: Type.Array(
            Type.Object({
              text: Type.String({ description: `One stage, as a short line. Up to ${MAX_STEP_CHARS} characters.` }),
              status: Type.Union(
                CHECKLIST_STATUSES.map((status) => Type.Literal(status)),
                { description: "todo, doing (working on it now), done, or skipped." },
              ),
              note: Type.Optional(
                Type.String({ description: `A short note: what it found, or why it was skipped. Up to ${MAX_NOTE_CHARS} characters.` }),
              ),
            }),
            { description: `Every step of the plan, in order, as it stands now: 1 to ${MAX_CHECKLIST_STEPS}.` },
          ),
        }),
        execute: async (args, api) => {
          const checklist = checkChecklist(args);
          const conversation = String(api.conversationId);
          const posted = await scope.postChecklist(conversation, checklist, `checklist:${conversation}:${api.callId}`);
          if ("error" in posted) throw new Error(`Not posted: ${posted.error}`);
          const said = checklist.id
            ? isFinal(checklist.steps)
              ? `Updated checklist ${posted.id}: every step is done or skipped, so the plan is over.`
              : `Updated checklist ${posted.id}. Call ${CHECKLIST_TOOL} again with id "${posted.id}" and every step as each next stage finishes.`
            : `Posted checklist ${posted.id}. Call ${CHECKLIST_TOOL} again with id "${posted.id}" and every step, updated, as each stage finishes.`;
          return { output: text(said), details: { checklistId: posted.id } };
        },
      }),
    ],
  });
}
