import type { ChatKind } from "../../shared/chat-kinds.ts";
import {
  checkNoteChange,
  checkNoteInput,
  checkNoteText,
  isExportedNote,
  MAX_RECALLED,
  offRecord,
  placeNote,
  promptNotes,
  reads,
  type MemoryKind,
  type MemoryNote,
  type MemoryNoteView,
  type MemoryReader,
  type MemoryScope,
  type MemoryWriter,
} from "../../shared/memory.ts";
import { searchWords } from "../../shared/util.ts";
import type { Sql } from "../members.ts";
import { MemoryStore } from "./store.ts";

/** What memory needs to know of the rest of its owner's directory. */
export interface MemoryDeps {
  /** The kind of one of the owner's own chats, as its chat object last told; null for a chat that is not theirs. */
  chatKind(chatId: string): ChatKind | null;
  chatTitle(chatId: string): string | null;
  /** The name of one of the owner's agents; null for none. */
  agentName(agentId: string): string | null;
  /** The notes changed: the open sidebars read them again. */
  changed(): void;
}

/** A note the model asks to save. */
export interface LearnedNote {
  text: unknown;
  scope: MemoryScope;
  kind: MemoryKind;
}

/** What saving a learned note did: the note, where it went, and whether it waits for a confirm. */
export type Learned = { note: MemoryNote; existed?: true; narrowed?: true } | { error: string };

/**
 * One user's memory notes, as their UserDirectory keeps them: the store, with the checks that need the rest of the
 * directory. Every reader and writer comes from a chat object of the owner's, which says the chat's kind and whether
 * anyone but the owner is in it; the kind the owner's sidebar holds is added, and the strictest wins, so a chat just
 * made off the record lets nothing in or out even where one of the two lags.
 */
export class UserMemory {
  readonly store: MemoryStore;
  readonly #deps: MemoryDeps;

  constructor(sql: Sql, deps: MemoryDeps, now?: () => number) {
    this.store = new MemoryStore(sql, now);
    this.#deps = deps;
  }

  /** `reader` with the kind the owner's sidebar holds for its chat added. */
  #checked<T extends MemoryReader>(reader: T): T {
    return { ...reader, kinds: [...reader.kinds, this.#deps.chatKind(reader.chatId)] };
  }

  /** Every note, forgotten ones too, newest first, with its chat's title and its agent's name. */
  list(): MemoryNoteView[] {
    return this.store.list().map((note) => {
      const chatTitle = note.chatId ? this.#deps.chatTitle(note.chatId) : null;
      const agentName = note.agentId ? this.#deps.agentName(note.agentId) : null;
      return { ...note, ...(chatTitle !== null && { chatTitle }), ...(agentName !== null && { agentName }) };
    });
  }

  /** A note the owner writes from the Memory view: confirmed, as they wrote it. */
  add(input: unknown): MemoryNote | { error: string } {
    const note = checkNoteInput(input);
    if ("error" in note) return note;
    const target = this.#target(note);
    if (target) return target;
    const added = this.store.add({ ...note, source: "person", kind: "preference", confirmed: true });
    if ("error" in added) return added;
    this.#deps.changed();
    return added.note;
  }

  /** Why a note may not go to the agent or chat it names; null when it may. */
  #target(note: { scope: MemoryScope; agentId?: string; chatId?: string }): { error: string } | null {
    if (note.scope === "agent" && (!note.agentId || this.#deps.agentName(note.agentId) === null)) return { error: "No such agent of yours." };
    if (note.scope === "chat") {
      const kind = note.chatId ? this.#deps.chatKind(note.chatId) : null;
      if (kind === null) return { error: "No such chat of yours." };
      if (offRecord([kind])) return { error: "That chat is off the record: it keeps no notes." };
    }
    return null;
  }

  /** A note the model saves in a conversation (see placeNote for where it goes, and whether it waits for a confirm). */
  learn(writer: MemoryWriter, input: LearnedNote): Learned {
    const text = checkNoteText(input.text);
    if (typeof text !== "string") return text;
    const place = placeNote(this.#checked(writer), input.scope, input.kind);
    if ("error" in place) return place;
    const added = this.store.add({ ...place, text, source: "learned", kind: input.kind, learnedBy: writer.learnedBy });
    if ("error" in added) return added;
    this.#deps.changed();
    return { ...added, ...(place.narrowed && { narrowed: true as const }) };
  }

  /** The notes a prompt holds for `reader` (promptNotes), and how many more it reads. Counts no use: see `use`. */
  read(reader: MemoryReader): { notes: MemoryNote[]; more: number } {
    const readable = this.store.readable(this.#checked(reader));
    const notes = promptNotes(readable);
    return { notes, more: readable.length - notes.length };
  }

  /** Count a read of each note: each time it enters a conversation's prompt, or a recall returns it. */
  use(ids: readonly string[]): void {
    if (!ids.length) return;
    this.store.use(ids);
    this.#deps.changed();
  }

  /** The notes `reader` reads that hold every word of `query` (all of them for none), pinned and most used first. */
  recall(reader: MemoryReader, query = ""): MemoryNote[] {
    const words = searchWords(query);
    const found = this.store
      .readable(this.#checked(reader))
      .filter((note) => words.every((word) => note.text.toLowerCase().includes(word)))
      .sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.uses - a.uses || b.createdAt - a.createdAt)
      .slice(0, MAX_RECALLED);
    this.use(found.map((note) => note.id));
    return found;
  }

  /**
   * The model forgets a note in a conversation: only one this conversation reads, and only in a turn its owner asked
   * for. It can be brought back from the Memory view.
   */
  forgetFor(writer: MemoryWriter, id: string): MemoryNote | { error: string } {
    if (!writer.byOwner) return { error: "Only the owner can have a note forgotten here; they can forget it under Memory." };
    const note = this.store.get(id);
    if (!note || !reads(this.#checked(writer), note)) return { error: `No note [${id}] is read here.` };
    this.store.forget(id);
    this.#deps.changed();
    return this.store.get(id)!;
  }

  /** The owner changes a note from the Memory view: its text, pin, a confirm, or where it goes. */
  change(id: string, value: unknown): MemoryNote | { error: string } {
    const change = checkNoteChange(value);
    if ("error" in change) return change;
    if (change.scope) {
      const target = this.#target({ scope: change.scope, agentId: change.agentId, chatId: change.chatId });
      if (target) return target;
    }
    const changed = this.store.change(id, change);
    if (!("error" in changed)) this.#deps.changed();
    return changed;
  }

  forget(id: string): MemoryNote | { error: string } {
    if (!this.store.get(id)) return { error: "No such note." };
    if (this.store.forget(id)) this.#deps.changed();
    return this.store.get(id)!;
  }

  restore(id: string): MemoryNote | { error: string } {
    const restored = this.store.restore(id);
    if (!("error" in restored)) this.#deps.changed();
    return restored;
  }

  delete(id: string): { error: string } | null {
    if (!this.store.delete(id)) return { error: "No such note." };
    this.#deps.changed();
    return null;
  }

  forgetChat(chatId: string): void {
    this.store.forgetChat(chatId);
    this.#deps.changed();
  }

  forgetAgent(agentId: string): void {
    this.store.forgetAgent(agentId);
    this.#deps.changed();
  }

  /** The notes an export carries: all but those of a chat that is off the record now, which nothing takes out of it. */
  exported(): MemoryNote[] {
    return this.store.list().filter((note) => note.scope !== "chat" || !note.chatId || !offRecord([this.#deps.chatKind(note.chatId)]));
  }

  /**
   * A note from an export: its agent by the id it has here (`agents`, from the export's ids), its chat only when it is
   * one of the owner's that is not off the record. A note of an agent or chat that did not come along is left out.
   */
  import(value: unknown, agents: Readonly<Record<string, string>> = {}): { id: string; skipped?: true } | { error: string } {
    if (!isExportedNote(value)) return { error: "Not a memory note." };
    const agentId = value.agentId && (agents[value.agentId] ?? value.agentId);
    const note: MemoryNote = { ...value, ...(agentId && { agentId }) };
    if (note.agentId && this.#deps.agentName(note.agentId) === null) {
      if (note.scope === "agent") return { error: "its agent was not imported" };
      delete note.agentId;
    }
    if (note.chatId) {
      const kind = this.#deps.chatKind(note.chatId);
      if (note.scope === "chat" && (kind === null || offRecord([kind])))
        return { error: kind === null ? "its chat was not imported" : "its chat is off the record" };
      if (kind === null) delete note.chatId;
    }
    const result = this.store.import(note);
    if ("id" in result && !result.skipped) this.#deps.changed();
    return result;
  }
}
