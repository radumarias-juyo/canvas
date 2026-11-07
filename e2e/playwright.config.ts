// The e2e suite (pnpm e2e): the real app in a browser, driven through the agents feature as people would. It starts the
// stand-in MCP servers (e2e/stand-in.ts) and the Vite dev server offline, in demo sign-in, on the scripted model
// (DEV_MODEL=script, worker/dev-model.ts) and with a local state of its own that each run starts empty, then runs the
// flows in e2e/agents.spec.ts one after another. Screenshots land in e2e/screens/. Not part of pnpm test.
import { defineConfig } from "@playwright/test";
import { fileURLToPath } from "node:url";
import { APP_PORT, MCP_PORT } from "./ports.ts";

const root = fileURLToPath(new URL("..", import.meta.url));
const STATE = "e2e/.state";

const servers = [
  { name: "crm", url: `http://127.0.0.1:${MCP_PORT}/mcp` },
  { name: "vault", url: `http://127.0.0.1:${MCP_PORT + 1}/mcp`, auth: "oauth" },
];

export default defineConfig({
  testDir: ".",
  outputDir: ".results",
  // The flows share people, agents and chats, in order.
  workers: 1,
  timeout: 120_000,
  expect: { timeout: 20_000 },
  reporter: [["list"]],
  use: {
    baseURL: `http://localhost:${APP_PORT}`,
    viewport: { width: 1280, height: 860 },
    deviceScaleFactor: 2,
    ...(process.env.E2E_CHROMIUM && { launchOptions: { executablePath: process.env.E2E_CHROMIUM } }),
  },
  webServer: [
    {
      command: `node --experimental-strip-types e2e/stand-in.ts ${MCP_PORT}`,
      cwd: root,
      url: `http://127.0.0.1:${MCP_PORT}/health`,
      stdout: "ignore",
    },
    {
      command: `rm -rf ${STATE} && pnpm exec vite --port ${APP_PORT} --strictPort`,
      cwd: root,
      // 401 until someone signs in: the Worker is up.
      url: `http://localhost:${APP_PORT}/api/me`,
      timeout: 180_000,
      stdout: process.env.E2E_LOGS ? "pipe" : "ignore",
      // Added to the runner's own environment.
      env: {
        AUTH_MODE: "demo",
        PI_OFFLINE: "1",
        PI_NO_DOCKER: "1",
        DEV_TOOLS: "true",
        DEV_MODEL: "script",
        // Agents speak up after a pause of seconds, not minutes (worker/dev-model.ts: scriptPauseMs).
        DEV_PAUSE_MS: "1500",
        PI_STATE_DIR: STATE,
        PI_MCP_SERVERS: JSON.stringify(servers),
        // A fixed key for the local state only: each run starts it afresh.
        FILES_MASTER_KEY: Buffer.from(new Uint8Array(32).fill(7)).toString("base64"),
      },
    },
  ],
});
