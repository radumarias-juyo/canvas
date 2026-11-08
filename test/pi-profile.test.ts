import { describe, expect, it } from "vitest";
import type { AgentServerInfo } from "../shared/agents.ts";
import { checkPiSettings, MAX_PI_SERVERS } from "../shared/pi-settings.ts";
import { holdOnRead, markedPrivate, othersCall, piShares, privateResult, type OthersCall } from "../worker/agent/reach.ts";
import { agentPlace, PI_PAGE } from "../src/agents/nav.ts";
import { piForm, piFormChanged, piServerWarning, piSettingsOf, piShared, togglePiShared } from "../src/agents/pi-form.ts";

const signsIn = (server: string) => server === "calendar";
const servers: AgentServerInfo[] = [
  { name: "calendar", signsIn: true, signedIn: true },
  { name: "db", signsIn: false },
];

describe("pi's settings", () => {
  it("are checked: a list of server names, review true or false; anything else is refused", () => {
    expect(checkPiSettings({})).toEqual({});
    expect(checkPiSettings({ sharedServers: [" db", "calendar", "db"], reviewBeforePosting: true })).toEqual({
      sharedServers: ["calendar", "db"],
      reviewBeforePosting: true,
    });
    // null goes back to the default; false keeps review off.
    expect(checkPiSettings({ sharedServers: null, reviewBeforePosting: false })).toEqual({});
    expect(checkPiSettings(null)).toHaveProperty("error");
    expect(checkPiSettings({ sharedServers: "db" })).toHaveProperty("error");
    expect(checkPiSettings({ sharedServers: [""] })).toHaveProperty("error");
    expect(checkPiSettings({ reviewBeforePosting: "yes" })).toHaveProperty("error");
    expect(checkPiSettings({ sharedServers: Array.from({ length: MAX_PI_SERVERS + 1 }, (_, i) => `s${i}`) })).toHaveProperty("error");
  });

  it("widen what pi reads for others in a shared chat only to the servers the owner listed", async () => {
    const reach = (list?: string[]): OthersCall => ({
      mcp: new Map([["calendar__events", { server: "calendar" }], ["db__query", { server: "db" }]]),
      shares: piShares(signsIn, list),
      chatFile: () => false,
      chatId: "c1",
      chatFiles: async () => [],
      draftServers: async () => undefined,
    });
    expect(await othersCall({ name: "calendar__events", arguments: {} }, reach())).toHaveProperty("block");
    expect(await othersCall({ name: "calendar__events", arguments: {} }, reach(["calendar", "db"]))).toBeUndefined();
    expect(privateResult("calendar__events", { server: "calendar" }, reach(["calendar"]))).toBe(false);
    // A list that leaves out a server without sign-in narrows it too.
    expect(await othersCall({ name: "db__query", arguments: {} }, reach(["calendar"]))).toHaveProperty("block");
  });

  it("never show others what pi read before a server was shared: a result is marked private as it is read", () => {
    const before: OthersCall = {
      mcp: new Map([["calendar__events", { server: "calendar" }]]),
      shares: piShares(signsIn),
      chatFile: () => false,
      chatId: "c1",
      chatFiles: async () => [],
      draftServers: async () => undefined,
    };
    const read = markedPrivate("calendar__events", { output: [], details: { items: [] } }, before);
    expect(read.details).toEqual({ items: [], private: true, server: "calendar" });
    // Widened since: the result read then stays the owner's; one read now is not.
    const after = { ...before, shares: piShares(signsIn, ["calendar"]) };
    expect(privateResult("calendar__events", read.details, after)).toBe(true);
    expect(privateResult("calendar__events", { server: "calendar" }, after)).toBe(false);
  });
});

describe("the hold pi's run takes as it reads what only the owner sees", () => {
  it("is taken alone with the owner, or in a shared chat with review before posting on; once per run", () => {
    expect(holdOnRead(undefined, { alone: true, review: false }, 5)).toEqual({ from: 5 });
    expect(holdOnRead(undefined, { alone: false, review: true }, 5)).toEqual({ from: 5, review: true });
    expect(holdOnRead(undefined, { alone: false, review: false }, 5)).toBeUndefined();
    expect(holdOnRead({ from: 1 }, { alone: false, review: true }, 5)).toBeUndefined();
  });
});

describe("pi's page", () => {
  it("has its own address among the agents' pages", () => {
    expect(agentPlace(new URL(`https://x/agents/${PI_PAGE}`))).toMatchObject({ id: PI_PAGE });
    expect(agentPlace(new URL("https://x/agents/pie"))).toBeNull();
  });

  it("starts from the default list, saves a list only when it differs, and warns for a server that signs in as the owner", () => {
    const form = piForm("Be brief.", {});
    expect([...piShared(form, servers)]).toEqual(["db"]);
    expect(piSettingsOf(form, servers)).toEqual({});
    const widened = togglePiShared(form, servers, "calendar", true);
    expect(piSettingsOf(widened, servers)).toEqual({ sharedServers: ["calendar", "db"] });
    expect(piFormChanged(form, widened, servers)).toBe(true);
    // Back to what the default says: saved as the default again.
    expect(piSettingsOf(togglePiShared(widened, servers, "calendar", false), servers)).toEqual({});
    expect(piSettingsOf({ ...form, review: true }, servers)).toEqual({ reviewBeforePosting: true });
    expect(piServerWarning(servers[0], true)).toMatch(/read this as you/);
    expect(piServerWarning(servers[0], false)).toBeUndefined();
    expect(piServerWarning(servers[1], true)).toBeUndefined();
    expect(piFormChanged(form, { ...form, instructions: " Be brief. " }, servers)).toBe(false);
  });
});
