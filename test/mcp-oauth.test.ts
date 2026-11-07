import { createServer, type Server } from "node:http";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { checkSignIn } from "../worker/mcp/background.ts";
import { connectStreamableHttp } from "../worker/mcp/connect.ts";
import { McpFailure, McpHub } from "../worker/mcp/hub.ts";
import { applyAuthChange, finishSignIn, McpOAuthClient, serverOfState, startSignIn, type McpAuthChange, type McpAuthRecord, type McpAuthStore } from "../worker/mcp/oauth.ts";
import type { McpServerConfig } from "../worker/mcp/servers.ts";
import { FakePortal } from "./fake-portal.ts";
import { listen } from "./fakes.ts";

class MemoryStore implements McpAuthStore {
  record: McpAuthRecord = {};
  async get() {
    return structuredClone(this.record);
  }
  async update(change: McpAuthChange) {
    this.record = structuredClone(applyAuthChange(this.record, change));
  }
}

const REDIRECT = "https://app.example/api/mcp/oauth/callback";
let portal: FakePortal;
let server: Server;
let origin: string;
let config: McpServerConfig;

beforeAll(async () => {
  server = createServer((req, res) => void portal.handle(req, res));
  origin = await listen(server);
});
afterAll(() => server.close());
beforeEach(() => {
  portal = new FakePortal();
  portal.origin = origin;
  config = { name: "Portal", url: `${portal.origin}/mcp`, cacheScope: "viewer", auth: "oauth" };
});

/** What a chat does: connect with the user's stored tokens, non-interactively. */
async function whoami(store: MemoryStore) {
  const connection = await connectStreamableHttp(config, new McpOAuthClient(store, "Portal", { redirectUrl: store.record.redirectUrl ?? REDIRECT, interactive: false }));
  try {
    const result = await connection.callTool("data_whoami", {});
    return JSON.parse((result.content[0] as { text: string }).text).user as string;
  } finally {
    await connection.close();
  }
}

async function signIn(store: MemoryStore, user: string) {
  const started = await startSignIn(config.url, "Portal", store, REDIRECT);
  if (!("url" in started)) throw new Error("expected a sign-in page");
  const { code, state } = portal.approve(started.url, user);
  await finishSignIn(config.url, "Portal", store, code, state);
}

describe("per-user MCP sign-in", () => {
  it("registers, signs in with PKCE, and calls as that user", async () => {
    const ada = new MemoryStore();
    const started = await startSignIn(config.url, "Portal", ada, REDIRECT);
    expect("url" in started && new URL(started.url).pathname).toBe("/authorize");
    const url = new URL((started as { url: string }).url);
    expect(url.searchParams.get("redirect_uri")).toBe(REDIRECT);
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(serverOfState(url.searchParams.get("state")!)).toBe("Portal");
    expect(portal.clients.get(ada.record.client!.client_id)).toEqual([REDIRECT]);

    const { code, state } = portal.approve(url.href, "ada@example.com");
    await finishSignIn(config.url, "Portal", ada, code, state);
    expect(ada.record.tokens?.access_token).toMatch(/^at-/);
    expect(ada.record.state).toBeUndefined();
    expect(ada.record.verifier).toBeUndefined();
    expect(await whoami(ada)).toBe("ada@example.com");
  });

  it("keeps each user's sign-in apart", async () => {
    const ada = new MemoryStore();
    const bob = new MemoryStore();
    await signIn(ada, "ada@example.com");
    await signIn(bob, "bob@example.com");
    expect(await whoami(ada)).toBe("ada@example.com");
    expect(await whoami(bob)).toBe("bob@example.com");
  });

  it("refuses a callback whose state it did not issue", async () => {
    const ada = new MemoryStore();
    const started = await startSignIn(config.url, "Portal", ada, REDIRECT);
    const { code } = portal.approve((started as { url: string }).url, "ada@example.com");
    await expect(finishSignIn(config.url, "Portal", ada, code, "Portal~forged")).rejects.toThrow(/did not start here/);
    expect(ada.record.tokens).toBeUndefined();
  });

  it("refreshes an expired token without a new sign-in", async () => {
    const ada = new MemoryStore();
    await signIn(ada, "ada@example.com");
    const first = ada.record.tokens!.access_token;
    portal.access.get(first)!.expires = 0;
    expect(await whoami(ada)).toBe("ada@example.com");
    expect(ada.record.tokens!.access_token).not.toBe(first);
  });

  it("says auth_required when the sign-in cannot be renewed, without touching a sign-in in progress", async () => {
    const ada = new MemoryStore();
    await signIn(ada, "ada@example.com");
    portal.access.get(ada.record.tokens!.access_token)!.expires = 0;
    portal.refreshAllowed = false;
    ada.record.state = "Portal~open-popup";
    ada.record.verifier = "verifier-of-open-popup";

    const failure = await whoami(ada).catch((error) => error);
    expect(failure).toBeInstanceOf(McpFailure);
    expect((failure as McpFailure).error.code).toBe("auth_required");
    expect(ada.record.state).toBe("Portal~open-popup");
    expect(ada.record.verifier).toBe("verifier-of-open-popup");
  });

  it("asks for a new sign-in but keeps the old tokens and registration until it finishes", async () => {
    const ada = new MemoryStore();
    await signIn(ada, "ada@example.com");
    const clientId = ada.record.client!.client_id;
    const tokens = ada.record.tokens;
    const started = await startSignIn(config.url, "Portal", ada, REDIRECT);
    expect(started).toHaveProperty("url");
    expect(ada.record.tokens).toEqual(tokens);
    expect(ada.record.client!.client_id).toBe(clientId);
    expect(portal.clients.size).toBe(1);
    const { code, state } = portal.approve((started as { url: string }).url, "ada@example.com");
    await finishSignIn(config.url, "Portal", ada, code, state);
    expect(ada.record.tokens!.access_token).not.toBe(tokens!.access_token);
  });

  it("names the request that failed when the code exchange is refused", async () => {
    const ada = new MemoryStore();
    const started = await startSignIn(config.url, "Portal", ada, REDIRECT);
    const { code, state } = portal.approve((started as { url: string }).url, "ada@example.com");
    portal.tokenBlocked = true;
    await expect(finishSignIn(config.url, "Portal", ada, code, state)).rejects.toThrow(/error code: 1014.*\[POST http:\/\/127\.0\.0\.1:\d+\/token answered 403 \(Cloudflare Ray ID abc123-ARN\)\]/);
  });

  it("keeps tokens another chat refreshed when this chat's refresh is rejected", async () => {
    const ada = new MemoryStore();
    await signIn(ada, "ada@example.com");
    const stale = ada.record.tokens!;
    // Chat A reads the tokens; chat B refreshes them; then A's refresh with the old refresh token is rejected.
    const chatA = new McpOAuthClient(ada, "Portal", { redirectUrl: REDIRECT, interactive: false });
    await chatA.tokens();
    await ada.update({ set: { tokens: { ...stale, access_token: "at-refreshed-by-b", refresh_token: "rt-b" } } });
    await chatA.invalidateCredentials("tokens");
    expect(ada.record.tokens?.access_token).toBe("at-refreshed-by-b");
    // With no newer tokens, the rejected ones are cleared.
    const chatB = new McpOAuthClient(ada, "Portal", { redirectUrl: REDIRECT, interactive: false });
    await chatB.tokens();
    await chatB.invalidateCredentials("tokens");
    expect(ada.record.tokens).toBeUndefined();
  });

  it("sends a call made across a new sign-in again on a fresh connection, as the new sign-in", async () => {
    const ada = new MemoryStore();
    await signIn(ada, "ada@example.com");
    const hub = new McpHub([config], (server) =>
      connectStreamableHttp(server, new McpOAuthClient(ada, "Portal", { redirectUrl: REDIRECT, interactive: false })),
    );
    const whoamiNow = async () => JSON.parse((await hub.call("Portal", "data_whoami", {})).content[0].text as string).user as string;
    expect(await whoamiNow()).toBe("ada@example.com");
    await signIn(ada, "ada+new@example.com");
    expect(await whoamiNow()).toBe("ada+new@example.com");
  });
});

describe("checking a sign-in before a scheduled run", () => {
  it("is ok when signed in, and the refresh renews the tokens", async () => {
    const ada = new MemoryStore();
    await signIn(ada, "ada@example.com");
    const before = ada.record.tokens!;
    expect(await checkSignIn(config, ada)).toBe("ok");
    expect(ada.record.tokens!.refresh_token).not.toBe(before.refresh_token);
    // The renewed tokens work, and the old refresh token is spent.
    expect(await whoami(ada)).toBe("ada@example.com");
    expect(portal.refresh.has(before.refresh_token!)).toBe(false);
  });

  it("needs a sign-in when the refresh is refused, and opens none", async () => {
    const ada = new MemoryStore();
    await signIn(ada, "ada@example.com");
    portal.refreshAllowed = false;
    expect(await checkSignIn(config, ada)).toBe("needs_sign_in");
    expect(ada.record.tokens).toBeUndefined();
    expect(ada.record.state).toBeUndefined();
    expect(ada.record.verifier).toBeUndefined();
  });

  it("needs a sign-in when there was none, without registering a client", async () => {
    const ada = new MemoryStore();
    expect(await checkSignIn(config, ada)).toBe("needs_sign_in");
    expect(portal.clients.size).toBe(0);
  });

  it("checks a sign-in without a refresh token by connecting", async () => {
    const ada = new MemoryStore();
    await signIn(ada, "ada@example.com");
    delete ada.record.tokens!.refresh_token;
    expect(await checkSignIn(config, ada)).toBe("ok");
    portal.access.get(ada.record.tokens!.access_token)!.expires = 0;
    expect(await checkSignIn(config, ada)).toBe("needs_sign_in");
  });

  it("is unavailable, not a sign-in, when the server does not answer", async () => {
    const ada = new MemoryStore();
    await signIn(ada, "ada@example.com");
    expect(await checkSignIn({ ...config, url: "http://127.0.0.1:1/mcp" }, ada)).toBe("unavailable");
    expect(ada.record.tokens).toBeDefined();
  });
});

describe("applyAuthChange", () => {
  const record: McpAuthRecord = { redirectUrl: "r", state: "s", verifier: "v", tokens: { access_token: "a", token_type: "Bearer" } };
  it("applies one change at a time", () => {
    expect(applyAuthChange(record, { set: { state: "s2" } })).toEqual({ ...record, state: "s2" });
    expect(applyAuthChange(record, { clear: ["verifier", "state"] })).toEqual({ redirectUrl: "r", tokens: record.tokens });
    expect(applyAuthChange(record, { clear: "all" })).toEqual({});
    expect(applyAuthChange(record, { clearTokensIf: { access_token: "other", token_type: "Bearer" } }).tokens).toEqual(record.tokens);
    expect(applyAuthChange(record, { clearTokensIf: { access_token: "a", token_type: "Bearer" } }).tokens).toBeUndefined();
  });

  it("keeps a client registration only for a sign-in to the same redirect URL", () => {
    const client = { client_id: "c" };
    expect(applyAuthChange({ ...record, client }, { restart: "r" })).toEqual({ client, tokens: record.tokens, redirectUrl: "r" });
    expect(applyAuthChange({ ...record, client }, { restart: "elsewhere" })).toEqual({ redirectUrl: "elsewhere" });
  });
});
