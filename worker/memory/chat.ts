import type { ChatKind } from "../../shared/chat-kinds.ts";
import { memorySection, readsOwnNotes, type MemoryNote, type MemoryReader, type MemoryWriter } from "../../shared/memory.ts";
import { AGENT_NAME } from "../../shared/mentions.ts";
import { errorMessage } from "../../shared/util.ts";
import type { Learned, LearnedNote } from "./memory.ts";
import type { MemoryHost } from "./tools.ts";

/** The notes a conversation's prompt holds; `off`: the owner's directory reads and saves none in this chat. */
export type NotesRead = { notes: MemoryNote[]; more: number; off?: true };

/** What a chat reaches of a user's notes (UserDirectory's methods, which RPC makes promises). */
export interface NotesDirectory {
  readNotes(reader: MemoryReader): NotesRead | Promise<NotesRead>;
  useNotes(ids: readonly string[]): void | Promise<void>;
  recallNotes(reader: MemoryReader, query: string, shown: readonly string[]): MemoryNote[] | Promise<MemoryNote[]>;
  learnNote(writer: MemoryWriter, note: LearnedNote): Learned | Promise<Learned>;
  forgetNoteFor(writer: MemoryWriter, id: string): MemoryNote | { error: string } | Promise<MemoryNote | { error: string }>;
}

/**
 * An agent of the chat's roster, by the session a call comes from, with whether its turn now is its owner's. `run`: the
 * session is one of its runs' (an item's, a reply's, a page rebuild's), whose report may go to chats others are in.
 */
export interface MemoryAgent {
  agentId: string;
  ownerUid: string;
  name: string;
  byOwner: boolean;
  run?: true;
}

/** What ChatMemory needs of the chat object it runs in. */
export interface ChatMemoryDeps {
  ownerUid: string;
  chatId: string;
  kind(): ChatKind;
  /** Nobody but the owner is in the chat. */
  alone(): boolean;
  /** The roster's agent whose conversation `conversation` is; null for pi's. */
  agentFor(conversation: string): MemoryAgent | null;
  /** pi's turn now answers the owner's own message, not a hand-off from an agent (which nobody may have asked for). */
  piByOwner(): Promise<boolean>;
  /**
   * Have the next model request of a conversation (pi's for none, else a session) start its prompt afresh, leaving out
   * every earlier one: an earlier prompt held the owner's own notes, which its readers may no longer see.
   */
  freshPrompt(conversation: string | undefined): Promise<void>;
  directory(uid: string): NotesDirectory;
  /** Where the chat keeps which notes each conversation's prompt already held, so a note's use counts once in each. */
  kv: { get<T>(key: string): T | undefined; put(key: string, value: unknown): void };
}

/** pi's conversation, as the memos and the counts of uses key it. */
const PI = "pi";
const SHOWN_KEY = "memory.shown:";
/** The conversations (PI, or a session) whose prompt held the owner's own notes since it last started afresh. */
const OWN_KEY = "memory.own";
/** How many note ids a conversation keeps as shown; past it, the oldest go (a use may then count again). */
const MAX_SHOWN = 1_000;

/** A conversation's section as its turn started: its text, and the notes it holds. */
type Section = { text: string; ids: string[] };

/**
 * The memory notes of one chat: who reads and who saves them for each conversation in it (pi's, and each agent's
 * session), and the prompt section each one reads, set when its turn starts and kept for the turn, so the prompt
 * changes only between turns.
 *
 * pi works for whoever calls it: only a turn that answers the owner's own message, in a chat nobody else is in, saves
 * as the owner; in any other, what it saves waits for the owner's confirm and it forgets nothing. An agent's turn knows
 * who asked (`byOwner`); a turn its owner did not ask for is never offered memory_note or memory_forget
 * (allowedTools), and both refuse it too. A run's sessions never read the owner's own notes, as its report may be
 * posted where others read it.
 *
 * A prompt stays in its conversation's transcript: once the owner's own notes were in one and the chat is shared (or
 * changes its kind), the conversation's next request starts its prompt afresh (`freshPrompt`), so no model reads them.
 */
export class ChatMemory {
  readonly #deps: ChatMemoryDeps;
  /** Each conversation's section, as its turn started, with who could read the chat then (`#audience`). */
  readonly #sections = new Map<string, { audience: string; section: Promise<Section> }>();

  constructor(deps: ChatMemoryDeps) {
    this.#deps = deps;
  }

  #who(conversation: string): { key: string; agent: MemoryAgent | null } {
    const agent = this.#deps.agentFor(conversation);
    return { key: agent ? conversation : PI, agent };
  }

  /** The chat's kind and whether anyone else is in it: a section read under another is not used. */
  #audience(): string {
    return `${this.#deps.kind()}:${this.#deps.alone()}`;
  }

  #reader(agent: MemoryAgent | null): MemoryReader {
    return {
      chatId: this.#deps.chatId,
      kinds: [this.#deps.kind()],
      alone: this.#deps.alone() && !agent?.run,
      ...(agent && { agentId: agent.agentId }),
    };
  }

  async #writer(agent: MemoryAgent | null): Promise<MemoryWriter> {
    const reader = this.#reader(agent);
    const byOwner = agent ? agent.byOwner : reader.alone && (await this.#deps.piByOwner().catch(() => false));
    return { ...reader, byOwner, learnedBy: agent ? agent.name : AGENT_NAME };
  }

  /** Whose notes a conversation reads: its agent's owner's, and pi's owner's (the chat's). */
  #directory(agent: MemoryAgent | null): NotesDirectory {
    return this.#deps.directory(agent?.ownerUid ?? this.#deps.ownerUid);
  }

  #own(): string[] {
    return this.#deps.kv.get<string[]>(OWN_KEY) ?? [];
  }

  #setOwn(key: string, held: boolean): void {
    const own = this.#own().filter((each) => each !== key);
    this.#deps.kv.put(OWN_KEY, held ? [...own, key] : own);
  }

  /** Start afresh the prompt of conversation `key` when it held the owner's own notes, which `reader` does not read. */
  async #forgetOwn(key: string, reader: MemoryReader): Promise<void> {
    if (readsOwnNotes(reader) || !this.#own().includes(key)) return;
    await this.#deps.freshPrompt(key === PI ? undefined : key);
    this.#setOwn(key, false);
  }

  /**
   * Read a conversation's notes again as its turn starts: pi's (no `conversation`), or an agent's session's. Counts a
   * use of each note its prompt holds for the first time; starts its prompt afresh when an earlier one held the
   * owner's own notes and it reads them no longer. Never rejects: on a failure the section says it.
   */
  refresh(conversation?: string): Promise<string> {
    return this.#refresh(conversation, true).then((section) => section.text);
  }

  #refresh(conversation: string | undefined, fresh: boolean): Promise<Section> {
    const { key, agent } = conversation === undefined ? { key: PI, agent: null } : this.#who(conversation);
    const section = this.#read(key, agent, fresh);
    this.#sections.set(key, { audience: this.#audience(), section });
    return section;
  }

  /**
   * The chat was shared, or changed its kind: every conversation whose prompt held the owner's own notes starts it
   * afresh at its next request, a turn already going included. Never rejects: a failure is logged, and the
   * conversation's next turn tries again.
   */
  async audienceChanged(): Promise<void> {
    const reader = this.#reader(null);
    if (readsOwnNotes(reader)) return;
    for (const key of this.#own()) {
      this.#sections.delete(key);
      await this.#forgetOwn(key, reader).catch((error: unknown) => console.error("memory prompt:", errorMessage(error)));
    }
  }

  async #read(key: string, agent: MemoryAgent | null, fresh: boolean): Promise<Section> {
    const reader = this.#reader(agent);
    const directory = this.#directory(agent);
    try {
      // Not while a request is being prepared (a section read again then): the next turn's refresh does it.
      if (fresh) await this.#forgetOwn(key, reader);
      const { notes, more, off } = await directory.readNotes(reader);
      // Off the record as the owner's directory knows it (its sidebar's kind, or a chat not theirs): say so, as the
      // tools refuse there.
      if (off) return { text: memorySection({ kinds: ["off_record"] }, []), ids: [] };
      if (notes.some((note) => note.scope === "user") && !this.#own().includes(key)) this.#setOwn(key, true);
      const shown = new Set(this.#deps.kv.get<string[]>(SHOWN_KEY + key) ?? []);
      const ids = notes.map((note) => note.id);
      const unseen = ids.filter((id) => !shown.has(id));
      if (unseen.length) {
        this.#deps.kv.put(SHOWN_KEY + key, [...shown, ...unseen].slice(-MAX_SHOWN));
        // Only a count, not waited for: a failure leaves the section as it is.
        void Promise.resolve(directory.useNotes(unseen)).catch((error: unknown) => console.error("memory uses:", errorMessage(error)));
      }
      return { text: memorySection(reader, notes, more), ids };
    } catch (error) {
      console.error("memory:", errorMessage(error));
      return { text: "Memory notes could not be read for this turn.", ids: [] };
    }
  }

  /** A conversation's section as it is kept, or read again when the chat's audience changed since. */
  #section(conversation: string): Promise<Section> {
    const { key } = this.#who(conversation);
    const kept = this.#sections.get(key);
    return kept && kept.audience === this.#audience() ? kept.section : this.#refresh(conversation, false);
  }

  /** What the memory tools and section run on (worker/memory/tools.ts). */
  host(): MemoryHost {
    return {
      // Read again when the chat was shared or changed its kind since: never a section read for fewer readers.
      section: async (conversation) => (await this.#section(conversation)).text,
      note: async (conversation, note) => {
        const { agent } = this.#who(conversation);
        return this.#directory(agent).learnNote(await this.#writer(agent), note);
      },
      // The notes the prompt does not hold first: those it holds the model has already.
      recall: async (conversation, query) => {
        const { agent } = this.#who(conversation);
        const { ids } = await this.#section(conversation);
        return this.#directory(agent).recallNotes(this.#reader(agent), query, ids);
      },
      forget: async (conversation, id) => {
        const { agent } = this.#who(conversation);
        return this.#directory(agent).forgetNoteFor(await this.#writer(agent), id);
      },
    };
  }
}
