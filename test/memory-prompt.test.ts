import { describe, expect, it } from "vitest";
import { fauxAssistantMessage, fauxProvider, fauxToolCall, Type, type AssistantMessage, type Message } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createRegistry, defineExtension, defineTool, Harness, MemoryStorage, section } from "@earendil-works/pi-durable";
import { MEMORY_RECALL_TOOL } from "../shared/memory.ts";
import { text } from "../worker/agent/output.ts";
import { freshPrompt } from "../worker/memory/fresh.ts";

/**
 * pi over a faux model with one `memory` section whose text the test sets and a memory_recall that finds the owner's
 * note, the messages each request carried, and the replies to give (`replies`, else "ok").
 */
async function piWithMemory(replies: AssistantMessage[] = [], summary = "Summary: nothing to note.") {
  const faux = fauxProvider({ models: [{ id: "m" }] });
  const models = createModels();
  models.setProvider(faux.provider);
  const requests: Message[][] = [];
  faux.setResponses(
    Array.from({ length: 8 }, () => (context: { messages: Message[]; systemPrompt?: string }) => {
      // A compaction's request asks for a summary, in its own instructions.
      if (JSON.stringify(context).includes("context summarization assistant")) return fauxAssistantMessage(summary);
      requests.push(structuredClone(context.messages));
      return replies.shift() ?? fauxAssistantMessage("ok");
    }),
  );
  const notes = { text: "" };
  const registry = createRegistry();
  const recall = defineTool({
    name: MEMORY_RECALL_TOOL,
    description: "Look through the memory notes.",
    parameters: Type.Object({}),
    execute: async () => ({ output: text("- [a2] (just me) My bonus is private too.") }),
  });
  registry.install(defineExtension({ name: "memory", sections: [section("memory", () => notes.text)], tools: [recall] }));
  const pi = await Harness.open(new MemoryStorage(), { models, registry }, BACKGROUND_CONTEXT);
  const root = await pi.root(BACKGROUND_CONTEXT);
  await root.configure({ model: { provider: faux.provider.id, modelId: "m" } }, BACKGROUND_CONTEXT);
  const ask = async (text: string) => (await root.submit({ type: "input", content: text }, BACKGROUND_CONTEXT)).wait(BACKGROUND_CONTEXT);
  return { pi, root, notes, ask, requests };
}

describe("a prompt that held the owner's own notes", () => {
  it("is not in the next request once the conversation starts its prompt afresh", async () => {
    const { pi, root, notes, ask, requests } = await piWithMemory();
    try {
      notes.text = "- [a1] (just me) My salary is private.";
      await ask("hello");
      expect(JSON.stringify(requests[0])).toContain("salary");
      // Shared: the section no longer holds the note, but the first prompt entry stays in the transcript.
      notes.text = "No notes yet.";
      await freshPrompt(root);
      await ask("and now?");
      const next = JSON.stringify(requests[1]);
      expect(next).not.toContain("salary");
      expect(next).toContain("No notes yet.");
      expect(next).toContain("hello");
    } finally {
      await pi.close(BACKGROUND_CONTEXT);
    }
  });

  it("leaves out what memory_recall found, keeping the call answered", async () => {
    const { pi, root, notes, ask, requests } = await piWithMemory([
      fauxAssistantMessage(fauxToolCall(MEMORY_RECALL_TOOL, {}, { id: "c1" }), { stopReason: "toolUse" }),
    ]);
    try {
      notes.text = "No notes yet.";
      await ask("what do you know?");
      expect(JSON.stringify(requests.at(-1))).toContain("bonus");
      await freshPrompt(root);
      await ask("and now?");
      const next = JSON.stringify(requests.at(-1));
      expect(next).not.toContain("bonus");
      expect(next).toContain("left out");
      expect(next).toContain("c1");
    } finally {
      await pi.close(BACKGROUND_CONTEXT);
    }
  });

  it("leaves out a summary of the conversation, which may have kept the notes", async () => {
    const { pi, root, notes, ask, requests } = await piWithMemory([], "Summary: the owner's bonus is private.");
    try {
      notes.text = "No notes yet.";
      await ask(`first ${"words ".repeat(30_000)}`);
      await ask(`second ${"words ".repeat(30_000)}`);
      await pi.waitForTask(await root.compact(undefined, BACKGROUND_CONTEXT), BACKGROUND_CONTEXT);
      await ask("third");
      expect(JSON.stringify(requests.at(-1))).toContain("bonus");
      await freshPrompt(root);
      await ask("and now?");
      expect(JSON.stringify(requests.at(-1))).not.toContain("bonus");
    } finally {
      await pi.close(BACKGROUND_CONTEXT);
    }
  });

  it("would still be there without it (what the fresh start is for)", async () => {
    const { pi, notes, ask, requests } = await piWithMemory();
    try {
      notes.text = "- [a1] (just me) My salary is private.";
      await ask("hello");
      notes.text = "No notes yet.";
      await ask("and now?");
      expect(JSON.stringify(requests[1])).toContain("salary");
    } finally {
      await pi.close(BACKGROUND_CONTEXT);
    }
  });
});
