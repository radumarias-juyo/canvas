// Stand-in MCP servers for the e2e suite (node --experimental-strip-types e2e/stand-in.ts [port]), on two local ports:
//   <port>     "crm": list_deals (read-only) and update_deal (a write), over a few made-up deals; GET /state tells what
//              they are now and which writes came in, POST /reset puts them back
//   <port + 1> "vault": an MCP server behind OAuth (discovery, dynamic registration, PKCE, refresh), as a portal is,
//              whose authorize page approves at once; one read-only tool, read_notes
// Generic names and data only. The servers keep nothing between runs.

import { createHash, randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";

const port = Number(process.argv[2] ?? process.env.E2E_MCP_PORT ?? 5198);

interface Deal {
  id: string;
  name: string;
  stage: string;
  amount: number;
}

const DEALS: Deal[] = [
  { id: "d1", name: "Northwind renewal", stage: "proposal", amount: 42000 },
  { id: "d2", name: "Globex pilot", stage: "negotiation", amount: 18000 },
  { id: "d3", name: "Initech upgrade", stage: "won", amount: 9000 },
];
let deals = structuredClone(DEALS);
let writes: { tool: string; input: unknown; at: number }[] = [];

const readBody = (req: IncomingMessage) =>
  new Promise<string>((resolve) => {
    let data = "";
    req.on("data", (chunk) => (data += chunk));
    req.on("end", () => resolve(data));
  });

const send = (res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) =>
  res.writeHead(status, { "content-type": "application/json", ...headers }).end(JSON.stringify(body));

const text = (value: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(value) }] });

/** One stateless MCP request: a fresh server per request, as the tests' stand-ins do. */
async function mcp(server: McpServer, req: IncomingMessage, res: ServerResponse, body: string) {
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  await server.connect(transport);
  await transport.handleRequest(req, res, body ? JSON.parse(body) : undefined);
}

function crmServer(): McpServer {
  const server = new McpServer({ name: "crm", version: "1.0.0" }, { instructions: "A small CRM with made-up deals, for local tests." });
  server.registerTool(
    "list_deals",
    {
      description: "List the deals, optionally only those at one stage.",
      inputSchema: { stage: z.string().optional().describe("proposal, negotiation, won or lost") },
      annotations: { readOnlyHint: true },
    },
    async ({ stage }) => text({ deals: deals.filter((deal) => !stage || deal.stage === stage) }),
  );
  server.registerTool(
    "update_deal",
    {
      description: "Move a deal to another stage.",
      inputSchema: { id: z.string(), stage: z.string() },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    async ({ id, stage }) => {
      writes.push({ tool: "update_deal", input: { id, stage }, at: Date.now() });
      const deal = deals.find((one) => one.id === id);
      if (!deal) return { ...text({ error: `No deal ${id}.` }), isError: true };
      deal.stage = stage;
      return text({ updated: deal });
    },
  );
  return server;
}

createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://127.0.0.1:${port}`);
  const body = await readBody(req);
  try {
    if (url.pathname === "/health") return send(res, 200, { ok: true });
    if (url.pathname === "/state") return send(res, 200, { deals, writes });
    if (url.pathname === "/reset" && req.method === "POST") {
      deals = structuredClone(DEALS);
      writes = [];
      return send(res, 200, { ok: true });
    }
    if (url.pathname === "/mcp") return await mcp(crmServer(), req, res, body);
    send(res, 404, { error: "not_found" });
  } catch (error) {
    if (!res.headersSent) send(res, 500, { error: String(error) });
  }
}).listen(port, "127.0.0.1", () => console.log(`stand-in crm on http://127.0.0.1:${port}/mcp`));

// ---- vault: an MCP server behind OAuth ----

const vaultPort = port + 1;
const vaultOrigin = `http://127.0.0.1:${vaultPort}`;
const codes = new Map<string, { challenge: string; redirectUri: string; clientId: string }>();
const access = new Map<string, number>();
const refresh = new Set<string>();

function issue() {
  const accessToken = `at-${randomUUID()}`;
  const refreshToken = `rt-${randomUUID()}`;
  access.set(accessToken, Date.now() + 3_600_000);
  refresh.add(refreshToken);
  return { access_token: accessToken, token_type: "Bearer", expires_in: 3600, refresh_token: refreshToken };
}

function vaultServer(): McpServer {
  const server = new McpServer({ name: "vault", version: "1.0.0" });
  server.registerTool("read_notes", { description: "Read the shared notes.", annotations: { readOnlyHint: true } }, async () =>
    text({ notes: ["Quarterly review on Friday", "Renewals are due next month"] }),
  );
  return server;
}

createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", vaultOrigin);
  if (url.pathname.startsWith("/.well-known/oauth-protected-resource")) {
    return send(res, 200, { resource: `${vaultOrigin}/mcp`, authorization_servers: [vaultOrigin] });
  }
  if (url.pathname === "/.well-known/oauth-authorization-server") {
    return send(res, 200, {
      issuer: vaultOrigin,
      authorization_endpoint: `${vaultOrigin}/authorize`,
      token_endpoint: `${vaultOrigin}/token`,
      registration_endpoint: `${vaultOrigin}/register`,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none"],
    });
  }
  // The person approves at once: back to the app with a code.
  if (url.pathname === "/authorize") {
    const code = `code-${randomUUID()}`;
    const redirectUri = url.searchParams.get("redirect_uri") ?? "";
    codes.set(code, { challenge: url.searchParams.get("code_challenge") ?? "", redirectUri, clientId: url.searchParams.get("client_id") ?? "" });
    const back = new URL(redirectUri);
    back.searchParams.set("code", code);
    back.searchParams.set("state", url.searchParams.get("state") ?? "");
    return res.writeHead(302, { location: back.toString() }).end();
  }
  const body = await readBody(req);
  if (url.pathname === "/register") return send(res, 201, { ...JSON.parse(body), client_id: `client-${randomUUID()}` });
  if (url.pathname === "/token") {
    const form = new URLSearchParams(body);
    if (form.get("grant_type") === "authorization_code") {
      const grant = codes.get(form.get("code") ?? "");
      codes.delete(form.get("code") ?? "");
      const challenge = createHash("sha256")
        .update(form.get("code_verifier") ?? "")
        .digest("base64url");
      const ok = grant && grant.challenge === challenge && grant.redirectUri === form.get("redirect_uri") && grant.clientId === form.get("client_id");
      return ok ? send(res, 200, issue()) : send(res, 400, { error: "invalid_grant" });
    }
    if (form.get("grant_type") === "refresh_token" && refresh.delete(form.get("refresh_token") ?? "")) return send(res, 200, issue());
    return send(res, 400, { error: "invalid_grant" });
  }
  if (url.pathname === "/mcp") {
    const token = req.headers.authorization?.replace(/^Bearer /, "") ?? "";
    if ((access.get(token) ?? 0) < Date.now()) {
      const metadata = `${vaultOrigin}/.well-known/oauth-protected-resource/mcp`;
      return send(res, 401, { error: "invalid_token" }, { "www-authenticate": `Bearer resource_metadata="${metadata}"` });
    }
    return await mcp(vaultServer(), req, res, body);
  }
  send(res, 404, { error: "not_found" });
}).listen(vaultPort, "127.0.0.1", () => console.log(`stand-in vault on ${vaultOrigin}/mcp`));
