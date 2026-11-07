import { describe, expect, it } from "vitest";
import type { SignInNotice } from "../shared/sign-ins.ts";
import { assertReadOnly, grantMs, KEEP_ALIVE_MS, readOnlyTools, WARN_AHEAD_MS, warnAt, type SignInCheck } from "../worker/mcp/background.ts";
import { McpFailure } from "../worker/mcp/hub.ts";
import { openAuthRecord, sealAuthRecord } from "../worker/mcp/sealed.ts";
import { McpSignIns } from "../worker/mcp/sign-ins.ts";
import { deriveUserAesKey } from "../worker/storage/keys.ts";
import { MASTER_KEY, memorySql } from "./fakes.ts";

const DAY = 24 * 60 * 60 * 1000;
const T0 = 1_800_000_000_000;
const SERVERS = [
  { name: "Portal", url: "https://portal.example/mcp", auth: "oauth" },
  { name: "Public", url: "https://public.example/mcp" },
];
const TOKENS = { access_token: "at-1", token_type: "Bearer", refresh_token: "rt-1" };
const CLIENT = { client_id: "c1", redirect_uris: ["https://app.example/api/mcp/oauth/callback"] };

const key = () => deriveUserAesKey(MASTER_KEY, "MCP_TOKENS_KEY", "pi-artifacts/mcp-tokens/v1", "ada");

/** A user's sign-ins over an in-memory database, with a clock, a scripted check, and everything they tell recorded. */
function setup(options: { sql?: ReturnType<typeof memorySql>; check?: SignInCheck; grantDays?: string } = {}) {
  const sql = options.sql ?? memorySql();
  let now = T0;
  const told: SignInNotice[] = [];
  const pushed: string[] = [];
  const chats: string[] = [];
  const alarms: (number | null)[] = [];
  const checks: string[] = [];
  let result: SignInCheck = options.check ?? "ok";
  const signIns = new McpSignIns({
    sql,
    env: { MCP_SERVERS: SERVERS, MCP_GRANT_DAYS: options.grantDays ?? "30" },
    key,
    changed: () => {},
    notify: async (notice, push) => {
      told.push(notice);
      pushed.push(`${push.title} | ${push.body}`);
    },
    signedIn: async (chatId, server) => void chats.push(`${chatId}:${server}`),
    setAlarm: (at) => void alarms.push(at),
    check: async (server, store) => {
      checks.push(server.name);
      // An ok check refreshes, as the real one does: new tokens.
      if (result === "ok") await store.update({ set: { tokens: { ...TOKENS, access_token: `at-${checks.length + 1}` } } });
      return result;
    },
    now: () => now,
  });
  return {
    sql,
    signIns,
    told,
    pushed,
    chats,
    alarms,
    checks,
    at: (to: number) => void (now = to),
    answer: (next: SignInCheck) => void (result = next),
    row: (server = "Portal") => sql.exec("SELECT * FROM mcp_auth WHERE server = ?", server).toArray()[0] as Record<string, unknown> | undefined,
  };
}

/** Sign in the way the callback does: tokens saved by the OAuth client, then the hook. */
async function signIn(s: ReturnType<typeof setup>, at: number) {
  s.at(at);
  await s.signIns.update("Portal", { set: { client: CLIENT, tokens: TOKENS } });
  await s.signIns.onSignedIn("Portal");
}

describe("sealed sign-in records", () => {
  it("round trips, and opens only for the server it was sealed for", async () => {
    const record = { client: CLIENT, tokens: TOKENS };
    const sealed = await sealAuthRecord(await key(), "Portal", record);
    expect(sealed).toMatch(/^v1\./);
    expect(sealed).not.toContain("rt-1");
    expect(await openAuthRecord(await key(), "Portal", sealed)).toEqual({ record, plain: false });
    await expect(openAuthRecord(await key(), "Other", sealed)).rejects.toThrow();
    const otherUser = await deriveUserAesKey(MASTER_KEY, "MCP_TOKENS_KEY", "pi-artifacts/mcp-tokens/v1", "bob");
    await expect(openAuthRecord(otherUser, "Portal", sealed)).rejects.toThrow();
  });

  it("a key from FILES_MASTER_KEY under its own label differs from the token key", async () => {
    const a = await sealAuthRecord(await key(), "Portal", {});
    const fromFiles = await deriveUserAesKey(MASTER_KEY, "FILES_MASTER_KEY", "pi-artifacts/mcp-tokens-from-files/v1", "ada");
    await expect(openAuthRecord(fromFiles, "Portal", a)).rejects.toThrow();
  });

  it("seals a plaintext row from before on first read, and counts its grant from then", async () => {
    const sql = memorySql();
    sql.exec("CREATE TABLE mcp_auth (server TEXT PRIMARY KEY, data TEXT NOT NULL)");
    sql.exec("INSERT INTO mcp_auth (server, data) VALUES (?, ?)", "Portal", JSON.stringify({ client: CLIENT, tokens: TOKENS }));
    const s = setup({ sql });
    expect(s.row()).toMatchObject({ signed_in: 1, signed_in_at: T0 });
    expect(await s.signIns.record("Portal")).toEqual({ client: CLIENT, tokens: TOKENS });
    expect(String(s.row()!.data)).toMatch(/^v1\./);
    expect(await s.signIns.record("Portal")).toEqual({ client: CLIENT, tokens: TOKENS });
  });

  it("forgets a record sealed under another key, so the user signs in again", async () => {
    const sql = memorySql();
    const s = setup({ sql });
    const otherKey = await deriveUserAesKey(MASTER_KEY, "FILES_MASTER_KEY", "pi-artifacts/mcp-tokens-from-files/v1", "ada");
    const sealed = await sealAuthRecord(otherKey, "Portal", { client: CLIENT, tokens: TOKENS });
    sql.exec("INSERT INTO mcp_auth (server, data, signed_in, signed_in_at) VALUES (?, ?, 1, ?)", "Portal", sealed, T0);
    expect(await s.signIns.record("Portal")).toEqual({});
    expect(s.row()).toBeUndefined();
  });

  it("forgets sign-ins to servers no longer configured", () => {
    const sql = memorySql();
    sql.exec("CREATE TABLE mcp_auth (server TEXT PRIMARY KEY, data TEXT NOT NULL)");
    sql.exec("INSERT INTO mcp_auth (server, data) VALUES (?, ?)", "Gone", "{}");
    expect(setup({ sql }).row("Gone")).toBeUndefined();
  });
});

describe("sign-ins with nobody present", () => {
  it("lists each server that signs in each user, with its grant", async () => {
    const s = setup();
    expect(s.signIns.list()).toEqual([{ server: "Portal", signedIn: false, usedByRuns: false, link: "/api/mcp/sign-in/Portal" }]);
    await signIn(s, T0);
    s.signIns.setRunServers("chat1", ["Portal", "Public", "Unknown"]);
    expect(s.signIns.list()).toEqual([
      { server: "Portal", signedIn: true, signedInAt: T0, endsAt: T0 + 30 * DAY, usedByRuns: true, link: "/api/mcp/sign-in/Portal" },
    ]);
  });

  it("checks only servers that sign in each user", async () => {
    const s = setup({ check: "needs_sign_in" });
    expect(await s.signIns.check(["Public", "Portal", "Nowhere"])).toEqual({ Public: "ok", Portal: "needs_sign_in", Nowhere: "unavailable" });
    expect(s.checks).toEqual(["Portal"]);
  });

  it("tells once that a sign-in is needed, and the waiting chats when the user signs in", async () => {
    const s = setup();
    await s.signIns.needed("Portal", { chatId: "chat1", what: "Daily brief" });
    await s.signIns.needed("Portal", { chatId: "chat2", what: "Weekly report" });
    expect(s.told).toHaveLength(1);
    expect(s.told[0]).toMatchObject({ type: "sign-in", server: "Portal", kind: "needed", link: "/api/mcp/sign-in/Portal", what: "Daily brief" });
    // The push says only that something is waiting: not what.
    expect(s.pushed[0]).not.toContain("Daily brief");
    expect(s.signIns.list()[0]!.notice).toBe("needed");
    await signIn(s, T0 + DAY);
    expect(s.chats.sort()).toEqual(["chat1:Portal", "chat2:Portal"]);
    expect(s.signIns.list()[0]!.notice).toBeUndefined();
    // Told once: a later sign-in tells nobody.
    await signIn(s, T0 + 2 * DAY);
    expect(s.chats).toHaveLength(2);
  });

  it("warns once per grant, a few days before it ends, only for servers runs use", async () => {
    const s = setup();
    await signIn(s, T0);
    const grant = 30 * DAY;
    expect(warnAt(T0, grant)).toBe(T0 + grant - WARN_AHEAD_MS);
    s.at(warnAt(T0, grant));
    await s.signIns.alarm();
    expect(s.told).toHaveLength(0);

    s.signIns.setRunServers("chat1", ["Portal"]);
    s.at(warnAt(T0, grant) - 1);
    await s.signIns.alarm();
    expect(s.told).toHaveLength(0);
    s.at(warnAt(T0, grant));
    await s.signIns.alarm();
    expect(s.told).toEqual([expect.objectContaining({ kind: "ending", server: "Portal", endsAt: T0 + grant })]);
    await s.signIns.alarm();
    expect(s.told).toHaveLength(1);

    // A new sign-in starts a new grant, and with it a new warning.
    await signIn(s, T0 + 28 * DAY);
    s.at(warnAt(T0 + 28 * DAY, grant));
    await s.signIns.alarm();
    expect(s.told).toHaveLength(2);
  });

  it("follows MCP_GRANT_DAYS", () => {
    expect(grantMs({ MCP_GRANT_DAYS: "7" })).toBe(7 * DAY);
    expect(grantMs({ MCP_GRANT_DAYS: "nonsense" })).toBe(30 * DAY);
    expect(grantMs({})).toBe(30 * DAY);
  });

  it("keeps a sign-in runs use alive daily, and asks for a new one when the refresh is refused", async () => {
    const s = setup();
    await signIn(s, T0);
    s.signIns.setRunServers("chat1", ["Portal"]);
    expect(s.alarms.at(-1)).toBe(T0 + KEEP_ALIVE_MS);
    s.at(T0 + KEEP_ALIVE_MS - 1);
    await s.signIns.alarm();
    expect(s.checks).toEqual([]);
    s.at(T0 + KEEP_ALIVE_MS);
    await s.signIns.alarm();
    expect(s.checks).toEqual(["Portal"]);
    // The refresh saved new tokens: the next keep-alive is a day from now.
    expect(s.row()!.keep_at).toBe(T0 + 2 * KEEP_ALIVE_MS);

    s.answer("unavailable");
    s.at(T0 + 2 * KEEP_ALIVE_MS);
    await s.signIns.alarm();
    expect(s.told).toHaveLength(0);
    expect(Number(s.row()!.keep_at)).toBeLessThan(T0 + 3 * KEEP_ALIVE_MS);

    s.answer("needs_sign_in");
    s.at(T0 + 3 * KEEP_ALIVE_MS);
    await s.signIns.alarm();
    expect(s.told).toEqual([expect.objectContaining({ kind: "needed", server: "Portal" })]);
  });

  it("clears the alarm when no run uses a signed-in server", async () => {
    const s = setup();
    await signIn(s, T0);
    s.signIns.setRunServers("chat1", ["Portal"]);
    s.signIns.setRunServers("chat1", []);
    expect(s.alarms.at(-1)).toBeNull();
  });

  it("ends the grant when the tokens go, and Disconnect forgets the record", async () => {
    const s = setup();
    await signIn(s, T0);
    await s.signIns.update("Portal", { clear: ["tokens"] });
    expect(s.signIns.list()[0]).toMatchObject({ signedIn: false });
    expect(s.row()).toMatchObject({ signed_in: 0, signed_in_at: null });
    await signIn(s, T0 + DAY);
    expect(await s.signIns.disconnect("Portal")).toBe(true);
    expect(s.row()).toBeUndefined();
    expect(await s.signIns.record("Portal")).toEqual({});
  });

  it("changes one record at a time", async () => {
    const s = setup();
    await Promise.all(Array.from({ length: 10 }, (_, i) => s.signIns.update("Portal", { set: { [`state`]: `s${i}` } })));
    expect((await s.signIns.record("Portal")).state).toBe("s9");
  });
});

describe("read-only tools for runs", () => {
  const hub = {
    tools: async () => [
      { name: "list_items", description: "", annotations: { readOnlyHint: true } },
      { name: "send_mail", description: "" },
    ],
  };
  it("offers only tools marked read-only, and refuses any other call", async () => {
    expect((await readOnlyTools(hub, "Portal")).map((tool) => tool.name)).toEqual(["list_items"]);
    await expect(assertReadOnly(hub, "Portal", "list_items")).resolves.toBeUndefined();
    const refused = await assertReadOnly(hub, "Portal", "send_mail").catch((error) => error);
    expect(refused).toBeInstanceOf(McpFailure);
    expect((refused as McpFailure).error.code).toBe("not_granted");
  });
});
