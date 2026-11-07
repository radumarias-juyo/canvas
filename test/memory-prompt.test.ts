import { describe, expect, it } from "vitest";
import { fauxAssistantMessage, fauxProvider, type Message } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createRegistry, defineExtension, Harness, MemoryStorage, section } from "@earendil-works/pi-durable";
import { freshPrompt } from "../worker/memory/fresh.ts";

/** pi over a faux model with one `memory` section whose text the test sets, and the messages each request carried. */
async function piWithMemory() {
  const faux = fauxProvider({ models: [{ id: "m" }] });
  const models = createModels();
  models.setProvider(faux.provider);
  const requests: Message[][] = [];
  faux.setResponses(
    Array.from({ length: 4 }, () => (context: { messages: Message[] }) => {
      requests.push(structuredClone(context.messages));
      return fauxAssistantMessage("ok");
    }),
  );
  const notes = { text: "" };
  const registry = createRegistry();
  registry.install(defineExtension({ name: "memory", sections: [section("memory", () => notes.text)] }));
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
