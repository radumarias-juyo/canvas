import type { EntryRecord } from "@earendil-works/pi-durable";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { CHAT_BUDGET_KIND, type ChatEventData } from "../shared/chat-kinds.ts";
import { ChatEventNotice } from "../src/chat/ChatKinds.tsx";
import { shown } from "../src/chat/entries.ts";

describe("the budget notice", () => {
  it("is an entry kind of its own, which the app shows", () => {
    const entry = { id: 1, conversationId: 1, kind: CHAT_BUDGET_KIND, data: { scope: "chat", text: "Used up." } } as unknown as EntryRecord;
    expect(shown(entry)).toBe(true);
  });

  it("leaves a chat event this app does not know drawing nothing, rather than reading it as a branch", () => {
    const unknown = { event: "something-new", text: "from a newer server" } as unknown as ChatEventData;
    expect(renderToStaticMarkup(<ChatEventNotice data={unknown} uid="olga" />)).toBe("");
    // An entry of the old shape (a budget chat.event) draws nothing either.
    const old = { event: "budget", scope: "chat", text: "Used up." } as unknown as ChatEventData;
    expect(renderToStaticMarkup(<ChatEventNotice data={old} uid="olga" />)).toBe("");
  });
});
