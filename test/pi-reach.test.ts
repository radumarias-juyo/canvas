import { describe, expect, it } from "vitest";
import { fauxAssistantMessage, fauxProvider, fauxToolCall, Type, type AssistantMessage, type Message } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createRegistry, defineExtension, defineTool, Harness, MemoryStorage, ROOT_CONVERSATION_ID, type AgentEvent, type EntryRecord, type JsonObject } from "@earendil-works/pi-durable";
import { CHAT_TURN_KIND } from "../shared/agents.ts";
import { heldIn, type PiHeld } from "../shared/protocol.ts";
import { noteResult } from "../worker/agents/limits/actions.ts";
import {
  heldReply,
  MAX_PI_HELD,
  othersCall,
  ownersInput,
  piPrivateEntry,
  piShares,
  privateResult,
  reachExtension,
  shownPiEvent,
  showsResults,
  withHeld,
  withoutHeld,
  withoutPrivate,
  type OthersCall,
  type Reach,
} from "../worker/agent/reach.ts";
import { text } from "../worker/agent/output.ts";
import { dreamLines } from "../worker/memory/dream-input.ts";
import { heldReplies, PRIVATE_FILES, replySources } from "../src/chat/entries.ts";
import { branchContext, branchCopies } from "../worker/branch.ts";
import { askLine } from "../worker/agents/turns.ts";
import { CHAT_COPY_KIND } from "../shared/chat-kinds.ts";

// The chat's servers: "db" every member shares; "calendar" signs in each user (the owner's alone).
const signsIn = (server: string) => server === "calendar";
const mcp = new Map([
  ["db__query", { server: "db" }],
  ["calendar__events", { server: "calendar" }],
]);
const CHAT = "c1";
const reach = (over: Partial<OthersCall> = {}): OthersCall => ({
  mcp,
  shares: piShares(signsIn),
  chatFile: (path) => path === "uploads/brief.md" || path.startsWith(`out/${CHAT}/`),
  chatId: CHAT,
  chatFiles: async () => ["uploads/brief.md", `out/${CHAT}/sum.csv`],
  draftServers: async (id) => (id === "d-cal" ? ["calendar"] : id === "d-db" ? ["db"] : undefined),
  ...over,
});

const toolResult = (toolName: string, content: string, details?: JsonObject, toolCallId = "c1"): Message => ({
  role: "toolResult",
  toolCallId,
  toolName,
  content: [{ type: "text", text: content }],
  details,
  isError: false,
  timestamp: 1,
});
const call = (id: string, name: string, args: object = {}): AssistantMessage =>
  fauxAssistantMessage(fauxToolCall(name, args as JsonObject, { id }), { stopReason: "toolUse" });

describe("pi's servers for anyone in a shared chat", () => {
  it("are those that do not sign in each user, or the owner's list", () => {
    expect(piShares(signsIn)("db")).toBe(true);
    expect(piShares(signsIn)("calendar")).toBe(false);
    expect(piShares(signsIn, ["calendar"])("db")).toBe(false);
  });
});

describe("whose input pi's run answers", () => {
  const RADU = "radu";
  const turns = new Map([
    [1, { byOwner: true, calledBy: { name: "Radu", uid: RADU } }],
    [2, { byOwner: false, calledBy: { name: "Mia", uid: "mia" } }],
  ]);
  const turn = (id: number) => turns.get(id) ?? null;
  const message = (uid: string, drafts = false) => ({ kind: "chat.message", data: { uid, name: uid, text: "hi", ...(drafts && { drafts: true }) } });
  const handOff = (id: number) => ({ kind: CHAT_TURN_KIND, data: { turn: id, calledBy: { name: "planner", agentId: "a1" } } });

  it("is the owner's for their own message, their Yes, and a hand-off from a turn on their own message", () => {
    expect(ownersInput(message(RADU), RADU, turn)).toBe(true);
    expect(ownersInput(message(RADU, true), RADU, turn)).toBe(true);
    expect(ownersInput(handOff(1), RADU, turn)).toBe(true);
  });

  it("is someone else's for a member's message, a hand-off from their turn, and anything the app did not write down", () => {
    expect(ownersInput(message("mia"), RADU, turn)).toBe(false);
    expect(ownersInput(handOff(2), RADU, turn)).toBe(false);
    expect(ownersInput(handOff(9), RADU, turn)).toBe(false);
    expect(ownersInput({ kind: "pi.user" }, RADU, turn)).toBe(false);
    expect(ownersInput(undefined, RADU, turn)).toBe(false);
  });
});

describe("what of pi's results only the owner sees", () => {
  const r = reach();
  it("goes by the server the call recorded, else by the tool's name", () => {
    expect(privateResult("calendar__events", { server: "calendar" }, r)).toBe(true);
    expect(privateResult("db__query", { server: "db" }, r)).toBe(false);
    expect(privateResult("calendar__events", undefined, r)).toBe(true);
    // An MCP tool no listing knows any more: nobody can tell where it came from.
    expect(privateResult("gone__tool", undefined, r)).toBe(true);
    // The app's own tools that read no file of the owner's.
    expect(privateResult("artifact_read", undefined, r)).toBe(false);
  });

  it("reads the owner's files that are not the chat's, by what the result says it read, else by what the call named", () => {
    expect(privateResult("files_read", { read: ["uploads/brief.md"] }, r)).toBe(false);
    expect(privateResult("files_read", { read: ["uploads/salary.xlsx"] }, r)).toBe(true);
    expect(privateResult("run_python", { saved: [], read: ["uploads/brief.md", "uploads/salary.xlsx"] }, r)).toBe(true);
    expect(privateResult("run_python", { saved: [], read: [] }, r)).toBe(false);
    // From before results said what they read: by the call's arguments, and none known is private.
    expect(privateResult("files_read", undefined, r, { path: "uploads/brief.md" })).toBe(false);
    expect(privateResult("files_read", undefined, r)).toBe(true);
    // A saved result of a server not shared is the owner's too.
    expect(privateResult("files_read", { read: ["tool-results/calendar__events-0123456789abcdef.txt"] }, r)).toBe(true);
    expect(privateResult("files_read", { read: ["tool-results/db__query-0123456789abcdef.txt"] }, r)).toBe(false);
  });
});

describe("a call of pi's on someone else's message", () => {
  it("is refused for a server pi does not share in the chat, or one nobody can tell, and goes for one it shares", async () => {
    expect(await othersCall({ name: "calendar__events", arguments: {} }, reach())).toEqual({ block: expect.stringContaining("calendar is not shared") });
    expect(await othersCall({ name: "gone__tool", arguments: {} }, reach())).toEqual({ block: expect.stringContaining("no tool of a server") });
    expect(await othersCall({ name: "db__query", arguments: { q: 1 } }, reach())).toBeUndefined();
  });

  it("reads only the chat's files, by the chat's own path for a name, never another file of the owner's", async () => {
    expect(await othersCall({ name: "files_read", arguments: { path: "salary.xlsx" } }, reach())).toEqual({ block: expect.stringContaining("not among this chat's files") });
    expect(await othersCall({ name: "files_read", arguments: { path: "brief.md" } }, reach())).toEqual({ arguments: { path: "uploads/brief.md" } });
    expect(await othersCall({ name: "run_python", arguments: { code: "1", files: ["sum.csv", "uploads"] } }, reach())).toEqual({
      block: expect.stringContaining("uploads"),
    });
    expect(await othersCall({ name: "run_python", arguments: { code: "1", files: ["sum.csv"] } }, reach())).toEqual({ arguments: { code: "1", files: [`out/${CHAT}/sum.csv`] } });
    expect(await othersCall({ name: "run_python", arguments: { code: "1" } }, reach())).toBeUndefined();
  });

  it("lists none of the owner's files or servers, and saves only in the chat's folder", async () => {
    expect(await othersCall({ name: "files_list", arguments: {} }, reach())).toEqual({ block: expect.stringContaining("Not listed") });
    expect(await othersCall({ name: "mcp_discover", arguments: {} }, reach())).toEqual({ block: expect.stringContaining("Not listed") });
    expect(await othersCall({ name: "files_write", arguments: { path: "notes.md", content: "x" } }, reach())).toEqual({ block: expect.stringContaining(`out/${CHAT}/`) });
    expect(await othersCall({ name: "files_write", arguments: { path: `out/${CHAT}/notes.md`, content: "x" } }, reach())).toBeUndefined();
  });

  it("builds no page that calls a server not shared, in what it writes or the draft it checks and publishes", async () => {
    const write = (server: string) => ({ name: "artifact_write", arguments: { html: "<p>", mcp: [{ server, tools: ["events"] }] } });
    expect(await othersCall(write("calendar"), reach())).toEqual({ block: expect.stringContaining("the page calls calendar") });
    expect(await othersCall(write("db"), reach())).toBeUndefined();
    expect(await othersCall({ name: "artifact_publish", arguments: { draft_id: "d-cal", title: "x" } }, reach())).toEqual({ block: expect.stringContaining("calendar") });
    expect(await othersCall({ name: "artifact_check", arguments: { draft_id: "d-db" } }, reach())).toBeUndefined();
  });
});

describe("pi's context on someone else's message", () => {
  const r = reach();
  it("leaves out what pi read for the owner alone, and the call's arguments, keeping what the chat shares", () => {
    const messages: Message[] = [
      { role: "user", content: "Radu: my calendar?", timestamp: 1 },
      call("c1", "calendar__events", { day: "Friday" }),
      toolResult("calendar__events", "Board dinner with the bank", { server: "calendar" }, "c1"),
      call("c2", "db__query"),
      toolResult("db__query", "Signups 41", { server: "db" }, "c2"),
      { role: "user", content: "Mia: what's on Friday?", timestamp: 3 },
    ];
    const kept = withoutPrivate(messages, r);
    const said = JSON.stringify(kept);
    expect(said).not.toMatch(/Board dinner|Friday"/);
    expect(said).toContain("Signups 41");
    expect(said).toContain("Left out");
    // The call stays answered, so the conversation is still well formed.
    expect(kept[2]).toMatchObject({ role: "toolResult", toolCallId: "c1" });
    expect(withoutPrivate([messages[0], messages[3], messages[4]], r)).toEqual([messages[0], messages[3], messages[4]]);
  });

  it("leaves out pi's held replies and a summary made since it first read the owner's own", () => {
    const summary = { role: "user" as const, content: "The conversation history before this point was compacted into the following summary: dinner", timestamp: 50 };
    const held = { ...fauxAssistantMessage("Your dinner is with the bank."), timestamp: 20 };
    const kept = JSON.stringify(withoutPrivate([summary, held], { ...r, held: [{ from: 10, through: 30 }] }, 40));
    expect(kept).not.toMatch(/bank|dinner/);
    // A summary from before pi read anything private stays.
    expect(JSON.stringify(withoutPrivate([summary], r, 60))).toContain("dinner");
  });
});

describe("what others' screens show of pi's steps", () => {
  const r = reach();
  const entry = (id: number, model: Message): EntryRecord => ({ id, conversationId: 0, kind: model.role === "toolResult" ? "pi.tool-result" : "pi.assistant", model: [model] }) as unknown as EntryRecord;
  const privateEntry = entry(3, toolResult("calendar__events", "Board dinner", { server: "calendar", items: [{ server: "calendar", id: "e1", title: "Board dinner" }] }));
  const sharedEntry = entry(4, toolResult("db__query", "Signups 41", { server: "db" }));

  it("puts a result only the owner may see in place of one that says so, for anyone but the owner, who sees it marked", () => {
    const appended = { type: "entry_appended", entry: privateEntry } as AgentEvent;
    const member = JSON.stringify(shownPiEvent(appended, r, false));
    expect(member).not.toContain("Board dinner");
    expect(member).toContain('"private":true');
    const owner = shownPiEvent(appended, r, true) as Extract<AgentEvent, { type: "entry_appended" }>;
    expect(JSON.stringify(owner)).toContain("Board dinner");
    expect(owner.entry.model?.[0]).toMatchObject({ details: { private: true, server: "calendar", items: [expect.anything()] } });
    expect(shownPiEvent({ type: "entry_appended", entry: sharedEntry } as AgentEvent, r, false)).toEqual({ type: "entry_appended", entry: sharedEntry });
  });

  it("leaves a private call's running output and its result out of a snapshot and of the call's own events", () => {
    const snapshot = {
      type: "snapshot",
      entries: [privateEntry, sharedEntry],
      tools: [{ callId: "c9", name: "calendar__events", output: "Board dinner", details: { x: 1 } }],
      nestedTools: [],
      compactions: [],
      inbox: [],
      agent: {},
      usage: {},
    } as unknown as AgentEvent;
    expect(JSON.stringify(shownPiEvent(snapshot, r, false))).not.toContain("Board dinner");
    const update = { type: "tool_execution_update", callId: "c9", toolName: "calendar__events", output: { set: "Board dinner" } } as unknown as AgentEvent;
    expect(JSON.stringify(shownPiEvent(update, r, false))).not.toContain("Board dinner");
    const start = { type: "message_start", message: toolResult("calendar__events", "Board dinner") } as AgentEvent;
    expect(JSON.stringify(shownPiEvent(start, r, false))).not.toContain("Board dinner");
    expect(JSON.stringify(shownPiEvent(update, r, true))).toContain("Board dinner");
  });

  it("shows anyone else that a held reply is the owner's, and none of it as it streams", () => {
    const held: PiHeld[] = [{ from: 10 }];
    const reply = entry(5, { ...fauxAssistantMessage("Your dinner is with the bank."), timestamp: 20 });
    const shown = JSON.stringify(shownPiEvent({ type: "message_end", entry: reply } as AgentEvent, { ...r, held }, false));
    expect(shown).not.toContain("bank");
    expect(shown).toContain("shown only to the chat's owner");
    const streamed = { type: "message_update", usage: {}, changes: [{ type: "text_delta", contentIndex: 0, delta: "bank" }] } as unknown as AgentEvent;
    expect(JSON.stringify(shownPiEvent(streamed, { ...r, held }, false))).not.toContain("bank");
    expect(JSON.stringify(shownPiEvent(streamed, { ...r, held }, true))).toContain("bank");
    // A batch of streamed tokens alone is read with the chat's reach too, so the hold applies to it.
    expect(showsResults(streamed)).toBe(true);
    expect(showsResults({ type: "run_start", inputs: [] } as AgentEvent)).toBe(false);
    // Once the run ended, a later reply is not held.
    expect(heldIn([{ from: 10, through: 30 }], 40)).toBe(false);
  });
});

describe("pi's held replies", () => {
  it("are not read into an agent's catch-up or chat_history, whose sessions members' questions reach", async () => {
    const reply = (id: number, timestamp: number, said: string) =>
      ({ id, conversationId: 0, kind: "pi.assistant", model: [{ ...fauxAssistantMessage(said), timestamp }] }) as unknown as EntryRecord;
    const person = { id: 1, conversationId: 0, kind: "chat.message", data: { uid: "mia", name: "Mia", text: "hi" } } as unknown as EntryRecord;
    async function* pages() {
      yield [reply(3, 20, "Dinner with the bank."), person, reply(4, 40, "Signups 41.")];
    }
    const read: EntryRecord[] = [];
    for await (const page of withoutHeld(pages(), () => [{ from: 10, through: 30 }])) read.push(...page);
    expect(read.map((entry) => entry.id)).toEqual([1, 4]);
    expect(heldReply(reply(3, 20, "x"), [{ from: 10 }])).toBe(true);
    expect(heldReply(person, [{ from: 0 }])).toBe(false);
  });

  it("are kept apart up to a cap, past which the two oldest are held as one", () => {
    let held: PiHeld[] = [];
    for (let i = 0; i < MAX_PI_HELD + 1; i++) held = withHeld(held, { from: i * 10, through: i * 10 + 5 });
    expect(held).toHaveLength(MAX_PI_HELD);
    expect(held[0]).toEqual({ from: 0, through: 15 });
    expect(heldIn(held, 12)).toBe(true);
  });
});

describe("an approved call's note in pi's own session", () => {
  it("says what came of it only from a server pi shares: members' questions read that session", () => {
    const view = { server: "calendar", result: "Board dinner" };
    expect(noteResult(view, { session: "0", apart: true }, "0", piShares(signsIn))).not.toContain("Board dinner");
    expect(noteResult({ ...view, server: "db" }, { session: "0" }, "0", piShares(signsIn))).toBe("Board dinner");
  });
});

describe("pi's reply chips in a shared chat", () => {
  const message = (id: number, kind: string, model: object[], data: object = {}) => ({ id, conversationId: 0, kind, data, model }) as unknown as EntryRecord;
  const assistant = (id: number, said: string, timestamp = 0) =>
    message(id, "pi.assistant", [{ role: "assistant", content: [{ type: "text", text: said }], stopReason: "stop", timestamp }]);
  const result = (id: number, details: object) => message(id, "pi.tool-result", [{ role: "toolResult", toolCallId: `c${id}`, toolName: "x", content: [], details, isError: false, timestamp: 0 }]);
  const person = (id: number) => message(id, "chat.message", [{ role: "user", content: "hi", timestamp: 0 }], { uid: "mia", name: "Mia", text: "hi" });

  it("name the servers and files only the owner sees, under the reply built on them", () => {
    const entries = [person(1), result(2, { private: true, server: "calendar" }), result(3, { private: true }), result(4, { server: "db" }), assistant(5, "Friday."), person(6), assistant(7, "Hi.")];
    expect([...replySources(entries)]).toEqual([[5, ["calendar", PRIVATE_FILES]]]);
  });

  it("put Show to the chat under the last reply of each held run that ended", () => {
    const entries = [person(1), assistant(2, "Looking.", 15), assistant(3, "Dinner.", 20), person(4), assistant(5, "Later.", 40)];
    expect([...heldReplies(entries, [{ from: 10, through: 30 }, { from: 35 }])]).toEqual([[3, { from: 10, through: 30 }]]);
  });
});

/**
 * pi over a faux model with the reach extension: a tool of a server only the owner signs in to and one everyone shares,
 * and a host whose run answers someone else while `others.on`. The messages each request carried, and the calls made.
 */
async function piWithReach(replies: AssistantMessage[]) {
  const faux = fauxProvider({ models: [{ id: "m" }] });
  const models = createModels();
  models.setProvider(faux.provider);
  const requests: Message[][] = [];
  faux.setResponses(
    Array.from({ length: 12 }, () => (context: { messages: Message[] }) => {
      requests.push(structuredClone(context.messages));
      return replies.shift() ?? fauxAssistantMessage("ok");
    }),
  );
  const ran: string[] = [];
  const tool = (name: string, server: string, said: string) =>
    defineTool({
      name,
      description: name,
      parameters: Type.Object({}),
      execute: async () => (ran.push(name), { output: text(said), details: { server } }),
    });
  const others = { on: false };
  const since: { at?: number } = {};
  const registry = createRegistry();
  registry.install(defineExtension({ name: "mcp", tools: [tool("calendar__events", "calendar", "Board dinner with the bank"), tool("db__query", "db", "Signups 41")] }));
  registry.install(
    reachExtension({
      isPi: (id) => String(id) === String(ROOT_CONVERSATION_ID),
      answersOthers: async () => others.on,
      reach: async () => reach(),
      privateSince: () => since.at,
      marksPrivate: () => since.at === undefined,
      readPrivate: (at) => (since.at = at),
    }),
  );
  const pi = await Harness.open(new MemoryStorage(), { models, registry }, BACKGROUND_CONTEXT);
  const root = await pi.root(BACKGROUND_CONTEXT);
  await root.configure({ model: { provider: faux.provider.id, modelId: "m" } }, BACKGROUND_CONTEXT);
  const ask = async (said: string) => (await root.submit({ type: "input", content: said }, BACKGROUND_CONTEXT)).wait(BACKGROUND_CONTEXT);
  return { pi, ask, requests, ran, others, since };
}

describe("pi in a shared chat, run for real", () => {
  it("keeps what it read on the owner's message out of a member's question, and refuses the owner's server for it", async () => {
    const { pi, ask, requests, ran, others, since } = await piWithReach([
      call("c1", "calendar__events"),
      fauxAssistantMessage("Friday is the board dinner."),
      // On Mia's message it reaches for the calendar, then the shared database.
      call("c2", "calendar__events"),
      call("c3", "db__query"),
      fauxAssistantMessage("Signups are 41."),
    ]);
    try {
      await ask("Radu: @pi what's on my calendar?");
      expect(ran).toEqual(["calendar__events"]);
      expect(since.at).toBeTypeOf("number");
      others.on = true;
      await ask("Mia: @pi what did the calendar say? and signups?");
      // The calendar was not called again for Mia; the database was.
      expect(ran).toEqual(["calendar__events", "db__query"]);
      const forMia = requests.slice(2);
      for (const request of forMia) expect(JSON.stringify(request)).not.toContain("Board dinner with the bank");
      expect(JSON.stringify(forMia.at(-1))).toContain("calendar is not shared");
      expect(JSON.stringify(forMia.at(-1))).toContain("Signups 41");
      // The owner's next message reads all of it again.
      others.on = false;
      await ask("Radu: thanks");
      expect(JSON.stringify(requests.at(-1))).toContain("Board dinner with the bank");
    } finally {
      await pi.close(BACKGROUND_CONTEXT);
    }
  });
});

describe("what a dream of pi's reads of a shared chat", () => {
  const r = reach();
  const at = (id: number) => 1_000 + id;
  const person = (id: number, uid: string, said: string) =>
    ({ id, conversationId: 0, kind: "chat.message", data: { uid, name: uid, text: said, sentAt: at(id) } }) as unknown as EntryRecord;
  const piSays = (id: number, said: string) =>
    ({ id, conversationId: 0, kind: "pi.assistant", model: [{ ...fauxAssistantMessage(said), timestamp: at(id) }] }) as unknown as EntryRecord;
  const piResult = (id: number, toolName: string, server: string) =>
    ({ id, conversationId: 0, kind: "pi.tool-result", model: [toolResult(toolName, "Board dinner", { server }, `c${id}`)] }) as unknown as EntryRecord;
  async function* newestFirst(entries: EntryRecord[]) {
    yield [...entries].reverse();
  }
  const query = { subject: "pi", owner: "radu", private: false, from: 0, to: 10_000, privateResult: (entry: EntryRecord) => piPrivateEntry(entry, r) };

  it("reads a reply built on what only the owner sees as theirs (fork), and one on shared servers as the chat's", async () => {
    const log = [
      person(1, "radu", "my calendar?"),
      piResult(2, "calendar__events", "calendar"),
      piSays(3, "Friday."),
      person(4, "mia", "signups?"),
      piResult(5, "db__query", "db"),
      piSays(6, "41."),
    ];
    const { items } = await dreamLines(newestFirst(log), query);
    expect(items.find((item) => item.seq === 3)?.origin).toBe("fork");
    expect(items.find((item) => item.seq === 6)?.origin).toBe("shared");
  });

  it("never reads pi's held replies", async () => {
    const log = [person(1, "radu", "hi"), piSays(2, "Dinner with the bank."), person(3, "mia", "hello"), piSays(4, "Hi Mia.")];
    const { items } = await dreamLines(withoutHeld(newestFirst(log), () => [{ from: at(2), through: at(2) }]), query);
    expect(JSON.stringify(items)).not.toContain("bank");
    expect(items.some((item) => item.seq === 4)).toBe(true);
  });
});

describe("a branch of a chat with one of pi's replies held for the owner", () => {
  const OWNER = { uid: "radu", name: "Radu" };
  const at = (id: number) => 2_000 + id;
  const person = (id: number, uid: string, said: string) =>
    ({ id, conversationId: 0, kind: "chat.message", data: { uid, name: uid, text: said, sentAt: at(id) } }) as unknown as EntryRecord;
  const piSays = (id: number, said: string) =>
    ({ id, conversationId: 0, kind: "pi.assistant", model: [{ ...fauxAssistantMessage(said), timestamp: at(id) }] }) as unknown as EntryRecord;
  const log = [person(1, "radu", "my calendar?"), piSays(2, "Board dinner with the bank on Friday."), person(3, "mia", "hello"), piSays(4, "Hi Mia.")];
  const held: PiHeld[] = [{ from: at(2), through: at(2) }];

  it("gives a member's branch no copy of it, and its agents' context none", async () => {
    const copies = branchCopies(log, OWNER, held, false);
    expect(JSON.stringify(copies)).not.toContain("bank");
    expect(copies.some((copy) => JSON.stringify(copy.data).includes("Hi Mia."))).toBe(true);
    const context = await branchContext(log, OWNER.uid, "Plans", undefined, held);
    expect(context).not.toContain("bank");
    expect(context).toContain("Hi Mia.");
  });

  it("keeps it in the owner's own branch, marked held: anyone let in later sees a note, and no agent reads it", async () => {
    const copies = branchCopies(log, OWNER, held, true);
    const copy = copies.find((one) => JSON.stringify(one.data).includes("bank"));
    expect(copy?.data).toMatchObject({ from: "pi", held: true });
    // Not in the branch's agents' context either: they answer whoever the branch lets in.
    expect(await branchContext(log, OWNER.uid, "Plans", undefined, held)).not.toContain("bank");
    const entry = { id: 9, conversationId: 0, kind: CHAT_COPY_KIND, data: copy!.data } as unknown as EntryRecord;
    expect(askLine(entry, "a1", OWNER.uid)).toBeUndefined();
    const member = JSON.stringify(shownPiEvent({ type: "entry_appended", entry } as AgentEvent, reach(), false));
    expect(member).not.toContain("bank");
    expect(member).toContain("shown only to the chat's owner");
    expect(JSON.stringify(shownPiEvent({ type: "entry_appended", entry } as AgentEvent, reach(), true))).toContain("bank");
    // A branch of that branch: a member's has none of it; the owner's keeps it held.
    expect(JSON.stringify(branchCopies([entry], OWNER, [], false))).not.toContain("bank");
    expect(branchCopies([entry], OWNER, [], true)[0].data).toMatchObject({ held: true });
  });
});
