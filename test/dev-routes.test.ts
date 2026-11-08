import { describe, expect, it } from "vitest";
import { devOn, scriptGapMs, scriptOn, scriptPauseMs } from "../worker/dev-model.ts";

// The routes take DurableObject stubs, whose Workers types this test project does not load: imported by a path the
// type checker does not follow, and called with fakes of the methods they use.
const routesModule = new URL("../worker/dev-routes.ts", import.meta.url).href;
type Fake = Record<string, (...args: unknown[]) => Promise<unknown>>;
const { devRoute } = (await import(routesModule)) as {
  devRoute: (request: Request, env: Record<string, string>, uid: string, directory: Fake, reach: { chat: (id: string) => Fake; runs: () => Promise<Response | null> }) => Promise<Response | null>;
};

const PATHS: [string, string, unknown?][] = [
  ["POST", "/api/dev/chats/c1/publish", { html: "<p>x</p>" }],
  ["GET", "/api/dev/chats/c1/funnel"],
  ["POST", "/api/dev/agents/propose", { name: "x" }],
  ["POST", "/api/dev/agents/0123456789abcdef/run", {}],
  ["POST", "/api/dev/memory", { learn: [] }],
  ["POST", "/api/dev/dream", { subject: "pi", answer: "{}" }],
  ["POST", "/api/dev/feed", { ref: "r", title: "t", open: { to: "memory" } }],
  ["GET", "/api/dev/anything"],
];

/** The routes over a directory and chats that record what they were asked. */
function world() {
  const calls: string[] = [];
  const record = (name: string, answer: unknown = {}) => async () => (calls.push(name), answer);
  const directory: Fake = {
    hasChat: record("hasChat", true),
    saveAgent: record("saveAgent", { id: "a" }),
    noteCoverage: record("noteCoverage"),
    dreamNow: record("dreamNow", { status: "dreamt" }),
    addFeed: record("addFeed", true),
  };
  let asked = "";
  const reach = {
    chat: () => ({ devFunnel: record("devFunnel", []), devPublish: record("devPublish", { version: 1 }) }),
    // As the runs routes: a real run now for its path, nothing for any other.
    runs: async () => (calls.push("runs"), /\/run$/.test(asked) ? new Response("{}", { status: 202 }) : null),
  };
  const send = (env: Record<string, string>, [method, path, body]: (typeof PATHS)[number]) => {
    asked = path;
    const json = body === undefined ? {} : { body: JSON.stringify(body), headers: { "content-type": "application/json" } };
    return devRoute(new Request(`https://app.example${path}`, { method, ...json }), env, "ada", directory, reach);
  };
  return { calls, send };
}

describe("local development's routes", () => {
  it.each([
    [{ DEV_TOOLS: "true", AUTH_MODE: "access" }],
    [{ DEV_TOOLS: "true" }],
    [{ AUTH_MODE: "demo" }],
    [{ DEV_TOOLS: "false", AUTH_MODE: "demo" }],
  ])("are all a 404 that reaches nothing, with %o", async (env) => {
    const { calls, send } = world();
    for (const route of PATHS) {
      const answer = await send(env, route);
      expect(answer?.status, route[1]).toBe(404);
    }
    expect(calls).toEqual([]);
  });

  it("answer in local development (DEV_TOOLS with the demo sign-in)", async () => {
    const { calls, send } = world();
    const env = { DEV_TOOLS: "true", AUTH_MODE: "demo" };
    const statuses = [];
    for (const route of PATHS) statuses.push((await send(env, route))?.status);
    expect(statuses).toEqual([200, 200, 201, 202, 200, 200, 200, 404]);
    expect(calls).toEqual(["hasChat", "devPublish", "hasChat", "devFunnel", "saveAgent", "runs", "dreamNow", "addFeed", "runs"]);
  });

  it("leave every other path to the rest of the Worker", async () => {
    const { send } = world();
    expect(await send({ DEV_TOOLS: "true", AUTH_MODE: "demo" }, ["GET", "/api/agents"])).toBeNull();
    expect(await send({}, ["GET", "/api/devices"])).toBeNull();
  });
});

describe("the development switches", () => {
  it("are on only with DEV_TOOLS and the demo sign-in, and the scripted model's with them", () => {
    expect(devOn({ DEV_TOOLS: "true", AUTH_MODE: "demo" })).toBe(true);
    expect(devOn({ DEV_TOOLS: "true", AUTH_MODE: "access" })).toBe(false);
    expect(devOn({ DEV_TOOLS: "true" })).toBe(false);
    const deployed = { DEV_TOOLS: "true", AUTH_MODE: "access", DEV_MODEL: "script", DEV_PAUSE_MS: "1", DEV_GAP_MS: "1" };
    expect([scriptOn(deployed), scriptPauseMs(deployed), scriptGapMs(deployed)]).toEqual([false, undefined, undefined]);
    const local = { ...deployed, AUTH_MODE: "demo" };
    expect([scriptOn(local), scriptPauseMs(local), scriptGapMs(local)]).toEqual([true, 1, 1]);
  });
});
