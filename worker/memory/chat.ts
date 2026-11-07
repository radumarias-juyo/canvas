import type { ChatKind } from "../../shared/chat-kinds.ts";
import { memorySection, type MemoryNote, type MemoryReader, type MemoryWriter } from "../../shared/memory.ts";
import { AGENT_NAME } from "../../shared/mentions.ts";
import { errorMessage } from "../../shared/util.ts";
import type { Learned, LearnedNote } from "./memory.ts";
import type { MemoryHost } from "./tools.ts";

/** What a chat reaches of a user's notes (UserDirectory's methods, which RPC makes promises). */
export interface NotesDirectory {
  readNotes(reader: MemoryReader): { notes: MemoryNote[]; more: number } | Promise<{ notes: MemoryNote[]; more: number }>;
  useNotes(ids: readonly string[]): void | Promise<void>;
  recallNotes(reader: MemoryReader, query: string): MemoryNote[] | Promise<MemoryNote[]>;
  learnNote(writer: MemoryWriter, note: LearnedNote): Learned | Promise<Learned>;
  forgetNoteFor(writer: MemoryWriter, id: string): MemoryNote | { error: string } | Promise<MemoryNote | { error: string }>;
}

/** An agent of the chat's roster, by the session a call comes from, with whether its turn now is its owner's. */
export interface MemoryAgent {
  agentId: string;
  ownerUid: string;
  name: string;
  byOwner: boolean;
}

/** What ChatMemory needs of the chat object it runs in. */
export interface ChatMemoryDeps {
  ownerUid: string;
  chatId: string;
  kind(): ChatKind;
  /** Nobody but the owner is in the chat. */
  alone(): boolean;
  /** The roster's agent whose session `conversation` is; null for pi's. */
  agentFor(conversation: string): MemoryAgent | null;
  directory(uid: string): NotesDirectory;
  /** Where the chat keeps which notes each conversation's prompt already held, so a note's use counts once in each. */
  kv: { get<T>(key: string): T | undefined; put(key: string, value: unknown): void };
}

/** pi's conversation, as the memos and the counts of uses key it. */
const PI = "pi";
const SHOWN_KEY = "memory.shown:";
/** How many note ids a conversation keeps as shown; past it, the oldest go (a use may then count again). */
const MAX_SHOWN = 1_000;

/**
 * The memory notes of one chat: who reads and who saves them for each conversation in it (pi's, and each agent's
 * session), and the prompt section each one reads, set when its turn starts and kept for the turn, so the prompt
 * changes only between turns, and then mostly at its end.
 *
 * pi works for whoever calls it, and in a chat others are in it cannot tell whose words it follows: there it reads only
 * the chat's notes, and what it saves waits for the owner's confirm. An agent's turn knows who asked (`byOwner`); a
 * turn its owner did not ask for is never offered memory_note or memory_forget (allowedTools), and both refuse it too.
 */
export class ChatMemory {
  readonly #deps: ChatMemoryDeps;
  /** Each conversation's section, as its turn started. */
  readonly #sections = new Map<string, Promise<string>>();

  constructor(deps: ChatMemoryDeps) {
    this.#deps = deps;
  }

  #who(conversation: string): { key: string; agent: MemoryAgent | null } {
    const agent = this.#deps.agentFor(conversation);
    return { key: agent ? conversation : PI, agent };
  }

  #reader(agent: MemoryAgent | null): MemoryReader {
    return { chatId: this.#deps.chatId, kinds: [this.#deps.kind()], alone: this.#deps.alone(), ...(agent && { agentId: agent.agentId }) };
  }

  #writer(agent: MemoryAgent | null): MemoryWriter {
    const reader = this.#reader(agent);
    return { ...reader, byOwner: agent ? agent.byOwner : reader.alone, learnedBy: agent ? agent.name : AGENT_NAME };
  }

  /** Whose notes a conversation reads: its agent's owner's, and pi's owner's (the chat's). */
  #directory(agent: MemoryAgent | null): NotesDirectory {
    return this.#deps.directory(agent?.ownerUid ?? this.#deps.ownerUid);
  }

  /**
   * Read a conversation's notes again as its turn starts: pi's (no `conversation`), or an agent's session's. Counts a
   * use of each note its prompt holds for the first time. Never rejects: on a failure the section says it.
   */
  refresh(conversation?: string): Promise<string> {
    const { key, agent } = conversation === undefined ? { key: PI, agent: null } : this.#who(conversation);
    const section = this.#read(key, agent);
    this.#sections.set(key, section);
    return section;
  }

  async #read(key: string, agent: MemoryAgent | null): Promise<string> {
    const reader = this.#reader(agent);
    const directory = this.#directory(agent);
    try {
      const { notes, more } = await directory.readNotes(reader);
      const shown = new Set(this.#deps.kv.get<string[]>(SHOWN_KEY + key) ?? []);
      const fresh = notes.map((note) => note.id).filter((id) => !shown.has(id));
      if (fresh.length) {
        this.#deps.kv.put(SHOWN_KEY + key, [...shown, ...fresh].slice(-MAX_SHOWN));
        // Only a count: a failure leaves the section as it is.
        await Promise.resolve(directory.useNotes(fresh)).catch((error: unknown) => console.error("memory uses:", errorMessage(error)));
      }
      return memorySection(reader, notes, more);
    } catch (error) {
      console.error("memory:", errorMessage(error));
      return "Memory notes could not be read for this turn.";
    }
  }

  /** What the memory tools and section run on (worker/memory/tools.ts). */
  host(): MemoryHost {
    return {
      section: (conversation) => {
        const { key } = this.#who(conversation);
        return this.#sections.get(key) ?? this.refresh(conversation);
      },
      note: async (conversation, note) => {
        const { agent } = this.#who(conversation);
        return this.#directory(agent).learnNote(this.#writer(agent), note);
      },
      recall: async (conversation, query) => {
        const { agent } = this.#who(conversation);
        return this.#directory(agent).recallNotes(this.#reader(agent), query);
      },
      forget: async (conversation, id) => {
        const { agent } = this.#who(conversation);
        return this.#directory(agent).forgetNoteFor(this.#writer(agent), id);
      },
    };
  }
}
