import { useSyncExternalStore } from "react";
import type { DreamsView } from "../../shared/dream.ts";
import { waitsForConfirm, type MemoryNoteView, type ServerCoverage } from "../../shared/memory.ts";
import { errorMessage } from "../../shared/util.ts";
import { api } from "../api.ts";

/** The user's memory notes and what their servers cover, as the app last read them: null until the first read answers. */
interface MemoryState {
  notes: MemoryNoteView[] | null;
  coverage: ServerCoverage[];
  /** pi's and the agents' nightly dreams; null until read. */
  dreams: DreamsView | null;
  error: string | null;
}

export type { DreamsView };

/** The browser's time zone, which the nightly dreams keep to (sent once when the account says another). */
const ZONE = Intl.DateTimeFormat().resolvedOptions().timeZone;
let zoneSent = false;

/**
 * The user's memory notes, shared by the sidebar's count, the Memory view and each agent's Knows tab: read once, and
 * again when the user's directory says they changed (the sidebar's socket) or a change here answers.
 */
const memoryStore = (() => {
  let state: MemoryState = { notes: null, coverage: [], dreams: null, error: null };
  let reading: Promise<void> | undefined;
  let again = false;
  const listeners = new Set<() => void>();
  const set = (next: MemoryState) => {
    state = next;
    for (const listener of listeners) listener();
  };
  // One read at a time; asked again meanwhile, it reads once more after, so the list is never older than the ask.
  const load = (): Promise<void> => {
    if (reading) {
      again = true;
      return reading;
    }
    reading = api.memory().then(
      ({ notes, coverage, dreams }) => {
        set({ notes, coverage, dreams: dreams ?? null, error: null });
        // The night is 03:00 where the owner is: tell the account their zone, once, when it holds another.
        if (dreams && ZONE && dreams.settings.timeZone !== ZONE && !zoneSent) {
          zoneSent = true;
          void api.setDreamSettings({ timeZone: ZONE }).catch(() => {});
        }
      },
      (error: unknown) => set({ ...state, error: errorMessage(error) }),
    );
    return reading.finally(() => {
      reading = undefined;
      if (again) {
        again = false;
        void load();
      }
    });
  };
  return {
    subscribe(listener: () => void) {
      listeners.add(listener);
      if (state.notes === null && !reading) void load();
      return () => listeners.delete(listener);
    },
    get: () => state,
    load,
  };
})();

export const reloadMemory = memoryStore.load;

export function useMemory(): MemoryState {
  return useSyncExternalStore(memoryStore.subscribe, memoryStore.get);
}

/** Notes learned in a conversation that wait for the owner's confirm. */
export function toConfirm(notes: readonly MemoryNoteView[] | null): number {
  return (notes ?? []).filter(waitsForConfirm).length;
}
