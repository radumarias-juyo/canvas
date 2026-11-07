// A stand-in for the MCP portal: an OAuth authorization server (discovery, dynamic registration, PKCE, refresh) in
// front of an MCP server. By default its one tool says who the bearer token belongs to. The browser part of a sign-in
// is played by the caller: test/mcp-oauth.test.ts reads the authorization URL and "approves" it; the e2e suite
// (e2e/stand-in.ts) sets `autoApprove`, so /authorize approves at once. Plain Node (no test runner), so the e2e
// stand-ins run it with `node --experimental-strip-types`.

import { createHash } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

/** A request's whole body, as text. */
export function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let data = "";
    req.on("data", (chunk) => (data += chunk));
    req.on("end", () => resolve(data));
  });
}

/** One stateless MCP request on `server` (made for this request): JSON answers, no session. */
export async function serveMcp(server: McpServer, req: IncomingMessage, res: ServerResponse, body: string): Promise<void> {
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  await server.connect(transport);
  await transport.handleRequest(req, res, body ? JSON.parse(body) : undefined);
}

interface Grant {
  user: string;
  challenge: string;
  redirectUri: string;
  clientId: string;
}

/** The tools of the portal's MCP server, for the user the request's token belongs to. */
export type PortalTools = (server: McpServer, user: string) => void;

const whoamiTools: PortalTools = (server, user) => {
  server.registerTool("data_whoami", { description: "Who am I", annotations: { readOnlyHint: true } }, async () => ({
    content: [{ type: "text", text: JSON.stringify({ user }) }],
  }));
  server.registerTool("portal_list_servers", { description: "Portal tool" }, async () => ({ content: [{ type: "text", text: "[]" }] }));
};

export class FakePortal {
  readonly clients = new Map<string, string[]>();
  readonly codes = new Map<string, Grant>();
  readonly access = new Map<string, { user: string; expires: number }>();
  readonly refresh = new Map<string, string>();
  readonly tools: PortalTools;
  ttlMs = 3_600_000;
  refreshAllowed = true;
  /** Answer the token endpoint the way the edge did in production: a bare 403 "error code: 1014". */
  tokenBlocked = false;
  /** Set: /authorize approves every sign-in as this user at once and redirects back, as a person would. */
  autoApprove?: string;
  origin = "";

  constructor(tools: PortalTools = whoamiTools) {
    this.tools = tools;
  }

  issue(user: string) {
    const accessToken = `at-${crypto.randomUUID()}`;
    const refreshToken = `rt-${crypto.randomUUID()}`;
    this.access.set(accessToken, { user, expires: Date.now() + this.ttlMs });
    this.refresh.set(refreshToken, user);
    return { access_token: accessToken, token_type: "Bearer", expires_in: Math.floor(this.ttlMs / 1000), refresh_token: refreshToken };
  }

  /** The user approves the sign-in in the browser: the portal redirects back with a code. */
  approve(authorizationUrl: string, user: string): { code: string; state: string } {
    const url = new URL(authorizationUrl);
    const code = `code-${crypto.randomUUID()}`;
    this.codes.set(code, {
      user,
      challenge: url.searchParams.get("code_challenge")!,
      redirectUri: url.searchParams.get("redirect_uri")!,
      clientId: url.searchParams.get("client_id")!,
    });
    return { code, state: url.searchParams.get("state")! };
  }

  async handle(req: IncomingMessage, res: ServerResponse) {
    const url = new URL(req.url!, this.origin);
    const send = (status: number, body: unknown, headers: Record<string, string> = {}) =>
      res.writeHead(status, { "content-type": "application/json", ...headers }).end(JSON.stringify(body));

    if (url.pathname.startsWith("/.well-known/oauth-protected-resource")) {
      return send(200, { resource: `${this.origin}/mcp`, authorization_servers: [this.origin] });
    }
    if (url.pathname === "/.well-known/oauth-authorization-server") {
      return send(200, {
        issuer: this.origin,
        authorization_endpoint: `${this.origin}/authorize`,
        token_endpoint: `${this.origin}/token`,
        registration_endpoint: `${this.origin}/register`,
        response_types_supported: ["code"],
        grant_types_supported: ["authorization_code", "refresh_token"],
        code_challenge_methods_supported: ["S256"],
        token_endpoint_auth_methods_supported: ["none"],
      });
    }
    if (url.pathname === "/authorize" && this.autoApprove !== undefined) {
      const { code, state } = this.approve(url.href, this.autoApprove);
      const back = new URL(url.searchParams.get("redirect_uri") ?? "");
      back.searchParams.set("code", code);
      back.searchParams.set("state", state);
      return res.writeHead(302, { location: back.toString() }).end();
    }
    const body = await readBody(req);
    if (url.pathname === "/register") {
      const metadata = JSON.parse(body);
      const clientId = `client-${this.clients.size + 1}`;
      this.clients.set(clientId, metadata.redirect_uris);
      return send(201, { ...metadata, client_id: clientId });
    }
    if (url.pathname === "/token" && this.tokenBlocked) {
      return res.writeHead(403, { "content-type": "text/plain", "cf-ray": "abc123-ARN" }).end("error code: 1014");
    }
    if (url.pathname === "/token") {
      const form = new URLSearchParams(body);
      if (form.get("grant_type") === "authorization_code") {
        const grant = this.codes.get(form.get("code")!);
        this.codes.delete(form.get("code")!);
        const challenge = createHash("sha256").update(form.get("code_verifier") ?? "").digest("base64url");
        const ok = grant && grant.challenge === challenge && grant.redirectUri === form.get("redirect_uri") && grant.clientId === form.get("client_id");
        return ok ? send(200, this.issue(grant.user)) : send(400, { error: "invalid_grant" });
      }
      if (form.get("grant_type") === "refresh_token") {
        const user = this.refresh.get(form.get("refresh_token")!);
        if (!user || !this.refreshAllowed) return send(400, { error: "invalid_grant" });
        this.refresh.delete(form.get("refresh_token")!);
        return send(200, this.issue(user));
      }
      return send(400, { error: "unsupported_grant_type" });
    }
    if (url.pathname === "/mcp") {
      const token = req.headers.authorization?.replace(/^Bearer /, "");
      const session = token ? this.access.get(token) : undefined;
      if (!session || session.expires < Date.now()) {
        return send(401, { error: "invalid_token" }, { "www-authenticate": `Bearer resource_metadata="${this.origin}/.well-known/oauth-protected-resource/mcp"` });
      }
      const server = new McpServer({ name: "stand-in", version: "1.0.0" });
      this.tools(server, session.user);
      return await serveMcp(server, req, res, body);
    }
    send(404, { error: "not_found" });
  }
}
