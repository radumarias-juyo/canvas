import type { EntryRecord } from "@earendil-works/pi-durable";
import { describe, expect, it } from "vitest";
import { CHAT_TURN_KIND } from "../shared/agents.ts";
import { CHAT_MESSAGE_KIND } from "../shared/protocol.ts";
import { piScanStep, type PiScan } from "../worker/agents/pi-scan.ts";

const OWNER = "olga";
const message = (id: number, uid: string, over: object = {}) =>
  ({ id, conversationId: 0, kind: CHAT_MESSAGE_KIND, data: { uid, name: uid, text: "hi", sentAt: id, ...over } }) as unknown as EntryRecord;
const handOff = (id: number, data: object) => ({ id, conversationId: 0, kind: CHAT_TURN_KIND, data }) as unknown as EntryRecord;
const reply = (id: number, text: string, stopReason = "stop") =>
  ({ id, conversationId: 0, kind: "pi.assistant", model: [{ role: "assistant", content: [{ type: "text", text }], stopReason }] }) as unknown as EntryRecord;

/** Read the entries in order from `scan`: what each step handed on and answered, and the scan after them. */
function read(entries: EntryRecord[], placeOf: (entry: EntryRecord) => { id: number; root: number } | null = () => null, scan: PiScan = { through: 0 }) {
  const handedOn: { text: string; chain: object }[] = [];
  const answered: number[] = [];
  for (const entry of entries) {
    const step = piScanStep(scan, entry, OWNER, placeOf);
    scan = step.scan;
    if (step.handOn) handedOn.push(step.handOn);
    answered.push(...step.answered);
  }
  return { scan, handedOn, answered };
}

describe("reading pi's log for its places in chains", () => {
  it("ends pi's place a hand-off gave it at its final answer, not at a step that calls tools, and hands on in that chain", () => {
    const { scan, handedOn, answered } = read([
      handOff(5, { turn: 3, calledBy: { name: "atlas", agentId: "a" }, hop: 1, root: 2, by: "mia", piTurn: 4 }),
      reply(6, "Looking.", "toolUse"),
    ]);
    expect(answered).toEqual([]);
    expect(scan).toEqual({ through: 6, chain: { hop: 1, root: 2 }, by: "mia", pending: [4] });
    const after = read([reply(7, "Done. @bard check it.")], undefined, scan);
    expect(after.answered).toEqual([4]);
    expect(after.handedOn).toEqual([{ text: "Done. @bard check it.", chain: { hop: 1, root: 2, by: "mia" } }]);
    expect(after.scan).toEqual({ through: 7, chain: { hop: 1, root: 2 }, by: "mia" });
  });

  it("finds pi's place in the chain of a message that named it first, so its answer hands on in that chain", () => {
    const { handedOn, answered } = read([message(8, OWNER), reply(9, "Here. @atlas your turn.")], (entry) => (entry.id === 8 ? { id: 12, root: 11 } : null));
    expect(answered).toEqual([12]);
    expect(handedOn).toEqual([{ text: "Here. @atlas your turn.", chain: { hop: 0, root: 11, by: OWNER } }]);
  });

  it("answers every place read before a final answer, a failed one too, and hands nothing on from a failure", () => {
    const { handedOn, answered } = read([
      handOff(5, { turn: 3, calledBy: { name: "atlas" }, hop: 1, root: 2, piTurn: 4 }),
      message(6, "mia"),
      handOff(7, { turn: 30, calledBy: { name: "bard" }, hop: 1, root: 20, piTurn: 40 }),
      reply(8, "", "error"),
    ]);
    expect(answered).toEqual([4, 40]);
    expect(handedOn).toEqual([]);
  });

  it("reads pi's own use as before: a message is a chain of its own, pi's own input the owner's, and nothing to end", () => {
    const { scan, handedOn, answered } = read([message(3, "mia"), reply(4, "@atlas over to you.")]);
    expect(answered).toEqual([]);
    expect(handedOn).toEqual([{ text: "@atlas over to you.", chain: { hop: 0, by: "mia" } }]);
    expect(scan).toEqual({ through: 4, by: "mia" });
    const own = read([{ id: 5, conversationId: 0, kind: "pi.user" } as unknown as EntryRecord], undefined, scan);
    expect(own.scan).toEqual({ through: 5, by: OWNER });
    const yes = read([message(6, OWNER, { drafts: true })], undefined, own.scan);
    expect(yes.scan).toEqual({ through: 6, chain: { hop: 0, unattended: true }, by: OWNER });
  });
});
