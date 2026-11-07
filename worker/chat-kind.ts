import {
  isChatKind,
  kindChoices,
  KIND_TEXT,
  legacyKind,
  losesAccess,
  type BranchedFrom,
  type ChatKind,
  type ChatMemberVia,
  type ChatPage,
} from "../shared/chat-kinds.ts";

/** The part of a Durable Object's KV storage the chat's kind needs; the tests put a Map behind it. */
export interface Kv {
  get<T>(key: string): T | undefined;
  put<T>(key: string, value: T): void;
  delete(key: string): boolean;
}

const KIND_KEY = "kind";
const PAGE_KEY = "page";
const BRANCHED_FROM_KEY = "branchedFrom";
const BRANCHES_KEY = "branches";

/** The chat storage keys an export carries (with the chat's other settings, worker/chat-dump.ts). */
export const KIND_KV = [KIND_KEY, PAGE_KEY, BRANCHED_FROM_KEY, BRANCHES_KEY];

/** Branches one chat remembers, newest kept. */
export const MAX_BRANCHES = 100;

/** A chat branched off from this one: where, and when. */
export interface Branch {
  chatId: string;
  entry: number;
  at: number;
}

/**
 * One chat's kind (shared/chat-kinds.ts), the page it discusses and where it branched off from, in the chat object's
 * own storage. A chat from before kinds has none stored: it is a group if it has members, else private, until it is
 * changed.
 */
export class ChatKindState {
  readonly #kv: Kv;
  readonly #hasMembers: () => boolean;

  constructor(kv: Kv, hasMembers: () => boolean) {
    this.#kv = kv;
    this.#hasMembers = hasMembers;
  }

  kind(): ChatKind {
    return this.stored() ?? legacyKind(this.#hasMembers());
  }

  /** The kind stored, if one is. */
  stored(): ChatKind | undefined {
    const stored = this.#kv.get<string>(KIND_KEY);
    return isChatKind(stored) ? stored : undefined;
  }

  setKind(kind: ChatKind): void {
    this.#kv.put(KIND_KEY, kind);
  }

  page(): ChatPage | undefined {
    return this.#kv.get<ChatPage>(PAGE_KEY);
  }

  setPage(page: ChatPage): void {
    this.#kv.put(PAGE_KEY, page);
  }

  branchedFrom(): BranchedFrom | undefined {
    return this.#kv.get<BranchedFrom>(BRANCHED_FROM_KEY);
  }

  setBranchedFrom(from: BranchedFrom): void {
    this.#kv.put(BRANCHED_FROM_KEY, from);
  }

  branches(): Branch[] {
    return this.#kv.get<Branch[]>(BRANCHES_KEY) ?? [];
  }

  addBranch(branch: Branch): void {
    this.#kv.put(BRANCHES_KEY, [...this.branches(), branch].slice(-MAX_BRANCHES));
  }
}

/** The owner's change of a chat's kind, checked: the members it removes, or why it cannot be made. */
export type KindPlan = { removed: ChatMemberVia[] } | { error: string; status: 400 | 409; loses?: ChatMemberVia[] };

/**
 * Plan changing a chat of `from` to `to`, for the owner who confirmed that `confirmed` (uids) lose access. Narrowing
 * lists who loses access first and then removes exactly them: if the list changed since it was shown (someone joined,
 * or left), nothing changes and the new list comes back, to confirm again.
 */
export function planKindChange(from: ChatKind, to: unknown, members: readonly ChatMemberVia[], confirmed: readonly string[], hasPage: boolean): KindPlan {
  if (!isChatKind(to) || !kindChoices(hasPage).includes(to)) {
    return { error: to === "page" ? "Only a chat made from a page with Discuss can be on a page." : "Not a kind of chat.", status: 400 };
  }
  const loses = losesAccess(to, members);
  if (from === to) return { removed: [] };
  const asked = new Set(confirmed);
  if (loses.length !== asked.size || loses.some((member) => !asked.has(member.uid))) {
    return { error: `Who loses access changed: check the list again before making the chat ${KIND_TEXT[to].label.toLowerCase()}.`, status: 409, loses };
  }
  return { removed: loses };
}
