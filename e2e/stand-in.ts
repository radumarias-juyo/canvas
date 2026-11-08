// Stand-in MCP servers for the e2e suite (node --experimental-strip-types e2e/stand-in.ts [port]), on two local ports:
//   <port>     "crm": list_deals (read-only) and update_deal (a write), over a few made-up deals; GET /state tells what
//              they are now and which writes came in
//   <port + 1> "vault": the tests' stand-in portal (test/fake-portal.ts: an MCP server behind OAuth, with discovery,
//              dynamic registration, PKCE and refresh), whose authorize page approves at once; read-only tools
//              read_notes, and read_notes_slowly, which answers the same after `ms` (up to 15 s): a call still going
//              while someone joins a chat
// Generic names and data only. The servers keep nothing between runs.

import { createServer, type ServerResponse } from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { FakePortal, readBody, serveMcp } from "../test/fake-portal.ts";
import { MCP_PORT } from "./ports.ts";

const port = Number(process.argv[2] ?? MCP_PORT);

const deals = [
  { id: "d1", name: "Northwind renewal", stage: "proposal", amount: 42000 },
  { id: "d2", name: "Globex pilot", stage: "negotiation", amount: 18000 },
  { id: "d3", name: "Initech upgrade", stage: "won", amount: 9000 },
];
const writes: { tool: string; input: unknown }[] = [];

const send = (res: ServerResponse, status: number, body: unknown) => res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));

const text = (value: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(value) }] });

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
      writes.push({ tool: "update_deal", input: { id, stage } });
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
  try {
    if (url.pathname === "/health") return send(res, 200, { ok: true });
    if (url.pathname === "/state") return send(res, 200, { deals, writes });
    if (url.pathname === "/mcp") return await serveMcp(crmServer(), req, res, await readBody(req));
    send(res, 404, { error: "not_found" });
  } catch (error) {
    if (!res.headersSent) send(res, 500, { error: String(error) });
  }
}).listen(port, "127.0.0.1", () => console.log(`stand-in crm on http://127.0.0.1:${port}/mcp`));

const notes = { notes: ["Quarterly review on Friday", "Renewals are due next month"] };
const vault = new FakePortal((server) => {
  server.registerTool("read_notes", { description: "Read the shared notes.", annotations: { readOnlyHint: true } }, async () => text(notes));
  server.registerTool(
    "read_notes_slowly",
    { description: "Read the shared notes, after a wait.", inputSchema: { ms: z.number().int().min(0).max(15_000) }, annotations: { readOnlyHint: true } },
    async ({ ms }) => {
      await new Promise((done) => setTimeout(done, ms));
      return text(notes);
    },
  );
});
vault.origin = `http://127.0.0.1:${port + 1}`;
// Whoever signs in approves at once: the app keeps the tokens per person, and the tool reads the same for all.
vault.autoApprove = "e2e";
// A request it cannot read answers 500 rather than rejecting unhandled, which would end this process for every later flow.
createServer((req, res) =>
  vault.handle(req, res).catch((error: unknown) => {
    if (!res.headersSent) send(res, 500, { error: String(error) });
  }),
).listen(port + 1, "127.0.0.1", () => console.log(`stand-in vault on ${vault.origin}/mcp`));
