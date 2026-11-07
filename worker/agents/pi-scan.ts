// Reading pi's log for the chains its answers are in (ChatAgent's #piScan), as a plain function the tests run: which
// chain pi's next answer is in, the agents a final answer hands on to, and pi's places in chains (PI_TURN) it answered.

import type { EntryRecord } from "@earendil-works/pi-durable";
import type { PiChain } from "./controller.ts";
import { assistantText, piLogEntry } from "./turns.ts";

/**
 * How far pi's log was read (`through`), the chain its next answer is in, the person who started that chain (`by`), and
 * pi's places in chains whose inputs it read and has not answered yet (`pending`).
 */
export type PiScan = { through: number; chain?: PiChain; by?: string; pending?: number[] };

/** What one entry of pi's log did: the scan after it, an answer to hand on to the agents it names, the places answered. */
export interface PiScanStep {
  scan: PiScan;
  handOn?: { text: string; chain: PiChain };
  answered: number[];
}

/**
 * Read one entry of pi's log. Its inputs are placed in order, so the latest one read says whose turn its next answer is:
 * a turn another agent handed it (chat.turn, with its chain and pi's place in it), a person's message (a chain of its
 * own, or the one it named pi first in: `placeOf` finds pi's place there), or pi's own input (the owner's, `owner`). Its
 * final answer (not a step that calls tools) answers every input placed before it.
 */
export function piScanStep(scan: PiScan, entry: EntryRecord, owner: string, placeOf: (entry: EntryRecord) => { id: number; root: number } | null): PiScanStep {
  const through = entry.id as number;
  const pending = scan.pending ?? [];
  const next = (change: Omit<PiScan, "through" | "pending">, places = pending): PiScan => ({
    through,
    ...(change.chain && { chain: change.chain }),
    ...(change.by !== undefined && { by: change.by }),
    ...(places.length && { pending: places }),
  });
  const seen = piLogEntry(entry);
  if (!seen) return { scan: next(scan), answered: [] };
  if ("reply" in seen) {
    const done = seen.reply.stopReason !== "toolUse";
    const handOn = seen.reply.stopReason === "stop" ? { text: assistantText(seen.reply), chain: { ...(scan.chain ?? { hop: 0 }), ...(scan.by !== undefined && { by: scan.by }) } } : undefined;
    return { scan: next(scan, done ? [] : pending), ...(handOn && { handOn }), answered: done ? pending : [] };
  }
  const uid = seen.input === "message" && typeof seen.uid === "string" ? seen.uid : undefined;
  if (seen.input === "handOff") {
    const { data } = seen;
    const chain = typeof data?.hop === "number" && typeof data.root === "number" ? { hop: data.hop, root: data.root } : undefined;
    const by = typeof data?.by === "string" ? data.by : undefined;
    return { scan: next({ chain, by }, typeof data?.piTurn === "number" ? [...pending, data.piTurn] : pending), answered: [] };
  }
  const place = seen.input === "message" ? placeOf(entry) : null;
  // A message that named pi first, with agents after it: pi's answer is that chain's.
  if (place) return { scan: next({ chain: { hop: 0, root: place.root }, by: uid }, [...pending, place.id]), answered: [] };
  // A Yes's run: the agents its answer names never hand pi a turn (unattended), which would have its full tools again.
  if (seen.input === "message" && seen.drafts) return { scan: next({ chain: { hop: 0, unattended: true }, by: uid }), answered: [] };
  // A person's message is theirs; pi's own input (a pi.user line) is the owner's.
  return { scan: next({ by: seen.input === "message" ? uid : owner }), answered: [] };
}
