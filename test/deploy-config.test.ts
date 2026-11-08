import { afterEach, describe, expect, it, vi } from "vitest";
import { deployTarget, type DeployTarget } from "../deploy/preview.ts";

// cloudflare.config.ts as cf reads it, evaluated here with a chosen environment. Its entrypoint import is the Worker
// itself, which needs the Workers runtime: a stand-in takes its place.
vi.mock("../worker/index.ts", () => ({ entrypoint: true }));

/** Loaded by a name tsc does not follow: cf checks the config, and its Worker needs the Workers types. */
const CONFIG = "../cloudflare.config.ts";

/** Everything cloudflare.config.ts reads from the environment. */
const READS = [
  "PI_NO_DOCKER",
  "PI_MCP_SERVERS",
  "PI_OFFLINE",
  "AUTH_MODE",
  "DEV_TOOLS",
  "DEV_MODEL",
  "DEV_PAUSE_MS",
  "PI_PREVIEW",
  "PI_PREVIEW_DOMAIN",
  "PI_PREVIEW_ACCESS_AUD",
  "PI_PREVIEW_ACCESS_TEAM_DOMAIN",
  "PI_PREVIEW_AI_GATEWAY",
  "PI_PREVIEW_RATE_LIMIT_OFFSET",
];

type Plain = string | number | boolean | null | Plain[] | { [key: string]: Plain };

/** The config as data: the entrypoint (the Worker module) as a marker, and no toJSON of the bindings in the way. */
function plain(value: unknown, key = ""): Plain {
  if (key === "entrypoint") return "<entrypoint>";
  if (Array.isArray(value)) return value.map((item) => plain(item));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, item]) => [k, plain(item, k)]));
  if (value === undefined) return null;
  return value as Plain;
}

/** The config with only `env` set of what it reads (and no MCP servers, which each deployment keeps outside the repository). */
async function config(env: Record<string, string> = {}) {
  for (const name of READS) vi.stubEnv(name, undefined);
  vi.stubEnv("PI_MCP_SERVERS", "[]");
  for (const [name, value] of Object.entries(env)) vi.stubEnv(name, value);
  vi.resetModules();
  const { default: loaded } = (await import(/* @vite-ignore */ CONFIG)) as { default: unknown };
  return plain(loaded) as { worker: { [key: string]: Plain; env: Record<string, { [key: string]: Plain }> }; containers: Plain[] };
}

afterEach(() => vi.unstubAllEnvs());

describe("cloudflare.config.ts", () => {
  it("is production's config, unchanged, when no preview is asked for", async () => {
    // The fixture is production's config (MCP servers aside). A change to it is a change to production: update it on purpose,
    // with `pnpm vitest run test/deploy-config.test.ts -u`, and say so in the pull request.
    await expect(`${JSON.stringify(await config(), null, 2)}\n`).toMatchFileSnapshot("./fixtures/production-config.json");
  });

  it("is still production's with the preview's other settings but no name", async () => {
    expect(await config({ PI_PREVIEW: " ", PI_PREVIEW_ACCESS_AUD: "aud-preview", PI_PREVIEW_DOMAIN: "preview.example.com" })).toEqual(await config());
  });
});

describe("a preview deploy", () => {
  const PREVIEW = { PI_PREVIEW: "app-preview", PI_PREVIEW_ACCESS_AUD: "aud-preview" };

  it("is a separate Worker on workers.dev, with its own resources and rate limits, and nothing else changed", async () => {
    const prod = await config();
    const preview = await config(PREVIEW);
    expect(preview.worker).toMatchObject({ name: "app-preview", domains: [], workersDev: true, previewUrls: false });
    expect(preview.worker.env).toMatchObject({
      FILES: { type: "r2", name: "app-preview" },
      REPOS: { type: "artifacts", namespace: "app-preview" },
      AI_GATEWAY_ID: { value: "app-preview" },
      METRICS: { name: "app_preview_metrics" },
      ACCESS_AUD: { value: "aud-preview" },
      ACCESS_TEAM_DOMAIN: prod.worker.env.ACCESS_TEAM_DOMAIN,
      PAGE_CALLS: { namespace: "4301", simple: { limit: 120, period: 60 } },
      PAGE_AI: { namespace: "4302" },
      DICTATION: { namespace: "4303" },
      AGENT_TURNS: { namespace: "4304" },
    });
    expect(preview.containers).toEqual([expect.objectContaining({ name: "app-preview-sandbox" })]);
    expect(preview.worker.exports).toMatchObject({ Sandbox: { container: { name: "app-preview-sandbox" } } });
    // Every other binding, var and secret is production's: the same models, limits and secrets to set.
    const changed = Object.keys(prod.worker.env).filter((key) => JSON.stringify(prod.worker.env[key]) !== JSON.stringify(preview.worker.env[key]));
    expect(changed.sort()).toEqual(["ACCESS_AUD", "AGENT_TURNS", "AI_GATEWAY_ID", "DICTATION", "FILES", "METRICS", "PAGE_AI", "PAGE_CALLS", "REPOS"]);
    expect(Object.keys(preview.worker.env)).toEqual(Object.keys(prod.worker.env));
    const { name: _name, domains: _domains, workersDev: _dev, env: _env, exports: _exports, ...rest } = preview.worker;
    const { name: _n, domains: _d, workersDev: _w, env: _e, exports: _x, ...prodRest } = prod.worker;
    expect(rest).toEqual(prodRest);
  });

  it("serves on its own domain when given one, with workers.dev off", async () => {
    const preview = await config({ ...PREVIEW, PI_PREVIEW_DOMAIN: "Preview.Example.com" });
    expect(preview.worker).toMatchObject({ domains: ["preview.example.com"], workersDev: false, previewUrls: false });
  });

  it("takes another Access team, AI Gateway and rate-limit offset when told", async () => {
    const preview = await config({
      ...PREVIEW,
      PI_PREVIEW_ACCESS_TEAM_DOMAIN: "team.example.com",
      PI_PREVIEW_AI_GATEWAY: "shared-gateway",
      PI_PREVIEW_RATE_LIMIT_OFFSET: "1000",
    });
    expect(preview.worker.env).toMatchObject({
      ACCESS_TEAM_DOMAIN: { value: "team.example.com" },
      AI_GATEWAY_ID: { value: "shared-gateway" },
      PAGE_CALLS: { namespace: "5201" },
      AGENT_TURNS: { namespace: "5204" },
    });
  });

  it("keeps the development switches off", async () => {
    const preview = await config(PREVIEW);
    expect(preview.worker.env).toMatchObject({
      AUTH_MODE: { value: "access" },
      DEV_TOOLS: { value: "false" },
      DEV_MODEL: { value: "" },
      DEV_PAUSE_MS: { value: "" },
    });
  });

  it.each([
    [{ PI_PREVIEW_ACCESS_AUD: "" }, /PI_PREVIEW_ACCESS_AUD is missing/],
    [{ PI_PREVIEW: "App_Preview" }, /lowercase letters/],
    [{ PI_PREVIEW: "x" }, /lowercase letters/],
    [{ PI_PREVIEW_DOMAIN: "https://preview.example.com" }, /not a hostname/],
    [{ PI_PREVIEW_RATE_LIMIT_OFFSET: "0" }, /whole number/],
    [{ PI_PREVIEW_RATE_LIMIT_OFFSET: "1.5" }, /whole number/],
    [{ PI_PREVIEW_RATE_LIMIT_OFFSET: "2" }, /namespace 4203 for PAGE_CALLS is production's/],
    [{ DEV_TOOLS: "true" }, /DEV_TOOLS is for local development/],
    [{ DEV_MODEL: "script" }, /DEV_MODEL is for local development/],
    [{ DEV_PAUSE_MS: "10" }, /DEV_PAUSE_MS is for local development/],
    [{ AUTH_MODE: "demo" }, /AUTH_MODE is for local development/],
    [{ PI_OFFLINE: "1" }, /PI_OFFLINE is for local development/],
  ])("is refused with %o", async (env, why) => {
    await expect(config({ ...PREVIEW, ...env })).rejects.toThrow(why);
  });

  it("is refused production's name, domain or Access application", async () => {
    const { worker } = await config();
    const [domain] = worker.domains as string[];
    await expect(config({ ...PREVIEW, PI_PREVIEW: String(worker.name) })).rejects.toThrow(/the name is production's/);
    await expect(config({ ...PREVIEW, PI_PREVIEW_DOMAIN: domain.toUpperCase() })).rejects.toThrow(/PI_PREVIEW_DOMAIN is production's/);
    await expect(config({ ...PREVIEW, PI_PREVIEW_ACCESS_AUD: String(worker.env.ACCESS_AUD.value) })).rejects.toThrow(/production's Access application/);
  });
});

describe("deployTarget", () => {
  const production: DeployTarget = {
    preview: false,
    name: "app",
    domains: ["app.example.com"],
    workersDev: false,
    accessTeamDomain: "team.example.com",
    accessAud: "aud-production",
    bucket: "app",
    repos: "app",
    gateway: "app",
    metrics: "app_metrics",
    container: "app-sandbox",
    rateLimits: { PAGE_CALLS: "1", PAGE_AI: "2", DICTATION: "3", AGENT_TURNS: "4" },
  };

  it("is production itself without a preview name, whatever else is set", () => {
    expect(deployTarget(production, {})).toBe(production);
    expect(deployTarget(production, { DEV_TOOLS: "true", AUTH_MODE: "demo", PI_PREVIEW_ACCESS_AUD: "aud" })).toBe(production);
  });

  it("refuses a preview whose resources would be production's", () => {
    expect(() => deployTarget({ ...production, metrics: "app_preview_metrics" }, { PI_PREVIEW: "app-preview", PI_PREVIEW_ACCESS_AUD: "aud" })).toThrow(
      /its metrics would be production's/,
    );
    expect(() => deployTarget({ ...production, bucket: "app-preview" }, { PI_PREVIEW: "app-preview", PI_PREVIEW_ACCESS_AUD: "aud" })).toThrow(
      /its bucket would be production's/,
    );
  });
});
