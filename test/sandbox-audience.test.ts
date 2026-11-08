import { beforeEach, describe, expect, it, vi } from "vitest";
import { allowedTools } from "../worker/agents/turns.ts";
import { audienceSwitched, ENTRY_SCRIPTS, OTHERS_SUFFIX, prepareCommand, sandboxSession, WIPE_COMMAND, WORKSPACE } from "../worker/agent/sandbox-names.ts";

// The sandbox object itself (worker/sandbox.ts) runs here on a stand-in container: a /workspace in memory, whose
// commands are the ones the object sends (WIPE_COMMAND, prepareCommand, the run), and whose scripts are stand-ins
// named by their text. Its types are the Worker's, so it is loaded by a name tsc does not follow.
vi.mock("cloudflare:workers", () => ({
  DurableObject: class {
    ctx: unknown;
    env: unknown;
    constructor(ctx: unknown, env: unknown) {
      this.ctx = ctx;
      this.env = env;
    }
  },
}));
vi.mock("@cloudflare/sandbox", () => ({
  Files: class {
    #box: FakeContainer;
    constructor(box: FakeContainer) {
      this.#box = box;
    }
    async writeFile(path: string, body: string | ArrayBuffer) {
      this.#box.fs.set(path, typeof body === "string" ? body : new TextDecoder().decode(body));
    }
    async readDirectory(path: string) {
      return [...this.#box.fs.keys()].filter((file) => file.startsWith(`${path}/`) && !file.slice(path.length + 1).includes("/")).map((file) => ({ name: file.slice(path.length + 1), type: "file" }));
    }
    async readFile(path: string) {
      return new Response(this.#box.fs.get(path) ?? "");
    }
  },
}));

const SANDBOX = "../worker/sandbox.ts";

/** What the stand-in scripts do, by their text: leave files in /workspace and /tmp, or print every file in the container. */
const OWNER_SCRIPT = "echo 'salary: 9000' > private.txt";
const LOOK_SCRIPT = "cat main.py run.sh; find . -type f | xargs cat";

class FakeContainer {
  running = false;
  images = { sandbox: "sandbox" };
  /** Every file in the container, /workspace's and the rest (/tmp). */
  fs = new Map<string, string>();
  sent: string[][] = [];
  starts = 0;
  /** A command whose text starts with this fails (exit code 1). */
  failing?: string;
  /** Destroyed, it keeps running (a stop that did not take). */
  stuck = false;
  start() {
    this.running = true;
    this.starts += 1;
    this.fs.clear();
  }
  async destroy() {
    if (!this.stuck) this.running = false;
  }
  async setInactivityTimeout() {}
  async exec(argv: string[]) {
    this.sent.push(argv);
    const script = argv[2] ?? "";
    const done = (exitCode: number, stdout = "", stderr = "") => ({
      output: async () => ({ exitCode, stdout: new TextEncoder().encode(stdout), stderr: new TextEncoder().encode(stderr) }),
    });
    if (this.failing && script.startsWith(this.failing)) return done(1, "", "Permission denied");
    if (script === WIPE_COMMAND[2]) {
      for (const path of [...this.fs.keys()]) if (path.startsWith(`${WORKSPACE}/`)) this.fs.delete(path);
      return done(0);
    }
    if (script.startsWith("rm -rf ")) {
      const gone = script.slice("rm -rf ".length, script.indexOf(" &&")).split(" ");
      for (const path of [...this.fs.keys()]) if (gone.some((one) => path === one || path.startsWith(`${one}/`))) this.fs.delete(path);
      return done(0);
    }
    // The run: argv ends with its interpreter and entry script.
    const entry = this.fs.get(`${WORKSPACE}/${argv.at(-1)}`) ?? "";
    if (entry === OWNER_SCRIPT) {
      this.fs.set(`${WORKSPACE}/private.txt`, "salary: 9000");
      // As Python's tempfile would.
      this.fs.set("/tmp/tmpk2j9/scratch.csv", "salary,9000");
      return done(0);
    }
    if (entry === LOOK_SCRIPT) {
      const seen = [...this.fs].filter(([path]) => path !== `${WORKSPACE}/${argv.at(-1)}`).map(([path, body]) => `${path}: ${body}`);
      return done(0, seen.join("\n"));
    }
    return done(0);
  }
}

type SandboxRun = { exitCode: number; stdout: string; stderr: string };
interface SandboxObject {
  runBash(script: string, inputs: [], skills: [], session: string): Promise<SandboxRun>;
  runPython(code: string, inputs: [], skills: [], session: string): Promise<SandboxRun>;
}

let container: FakeContainer;
let sandbox: SandboxObject;

beforeEach(async () => {
  container = new FakeContainer();
  const storage = new Map<string, unknown>();
  const ctx = {
    container,
    storage: { get: async (key: string) => storage.get(key), put: async (key: string, value: unknown) => void storage.set(key, value), deleteAll: async () => storage.clear() },
  };
  const { Sandbox } = (await import(/* @vite-ignore */ SANDBOX)) as { Sandbox: new (ctx: unknown, env: unknown) => SandboxObject };
  sandbox = new Sandbox(ctx, {});
});

/** pi's conversation, as both the owner's runs and anyone else's name it. */
const ROOT = "0";
const owners = sandboxSession(null, ROOT, false);
const others = sandboxSession(null, ROOT, true);

describe("pi's sandbox: the owner's runs and anyone else's never share /workspace", () => {
  it("keys a run by whom it answers: the owner's as pi's conversation, anyone else's apart", () => {
    expect(owners).toBe(ROOT);
    expect(others).toBe(`${ROOT}${OTHERS_SUFFIX}`);
    // An agent's turn its owner did not ask for (which gets no sandbox tools) would be apart too; one they asked for is not.
    expect(sandboxSession({ agentId: "a", byOwner: true }, "fork-1", true)).toBe("fork-1");
    expect(sandboxSession({ agentId: "a", byOwner: false }, "s-1", false)).toBe(`s-1${OTHERS_SUFFIX}`);
    expect(sandboxSession({ agentId: "a" }, "s-1", false)).toBe(`s-1${OTHERS_SUFFIX}`);
  });

  it("starts the container afresh when the audience switches, either way, or when nothing tells the last one's", () => {
    expect(audienceSwitched(owners, others)).toBe(true);
    expect(audienceSwitched(others, owners)).toBe(true);
    expect(audienceSwitched(undefined, owners)).toBe(true);
    expect(audienceSwitched(owners, owners)).toBe(false);
    // An agent's turns its owner asked for, each in a fork of its own: one audience, /workspace emptied between them.
    expect(audienceSwitched("fork-1", "fork-2")).toBe(false);
  });

  it("gives a member's run after the owner's an empty container: no leftover, in /workspace or /tmp, no script of theirs", async () => {
    await sandbox.runPython(OWNER_SCRIPT, [], [], owners);
    expect(container.fs.has(`${WORKSPACE}/private.txt`)).toBe(true);
    const seen = await sandbox.runBash(LOOK_SCRIPT, [], [], others);
    expect(seen.stdout).not.toContain("salary");
    expect(seen.stdout).not.toContain(OWNER_SCRIPT);
    expect(seen.stdout).not.toContain("main.py");
    expect(container.starts).toBe(2);
  });

  it("gives the owner's run after a member's an empty container too", async () => {
    await sandbox.runPython(OWNER_SCRIPT, [], [], others);
    const seen = await sandbox.runBash(LOOK_SCRIPT, [], [], owners);
    expect(seen.stdout).toBe("");
    expect(container.starts).toBe(2);
  });

  it("keeps what the owner's runs left for their next one, in the same container", async () => {
    await sandbox.runPython(OWNER_SCRIPT, [], [], owners);
    const seen = await sandbox.runBash(LOOK_SCRIPT, [], [], owners);
    expect(seen.stdout).toContain("salary: 9000");
    // Only their own leftovers: the last run's script is gone before the next one is written.
    expect(seen.stdout).not.toContain(OWNER_SCRIPT);
    expect(container.starts).toBe(1);
  });

  it("removes both entry scripts before each run", async () => {
    await sandbox.runPython(OWNER_SCRIPT, [], [], owners);
    await sandbox.runBash(LOOK_SCRIPT, [], [], owners);
    const prepares = container.sent.filter((argv) => argv[2]?.startsWith("rm -rf "));
    expect(prepares).toHaveLength(2);
    for (const argv of prepares) for (const name of ENTRY_SCRIPTS) expect(argv[2]).toContain(`${WORKSPACE}/${name}`);
    expect(prepareCommand([`${WORKSPACE}/files`])).toEqual([
      "sh",
      "-c",
      `rm -rf ${WORKSPACE}/files ${WORKSPACE}/skills ${WORKSPACE}/out ${WORKSPACE}/main.py ${WORKSPACE}/run.sh && mkdir -p "$@"`,
      "sh",
      `${WORKSPACE}/files`,
    ]);
  });

  it("runs nothing when /workspace could not be emptied for another session, and empties it at the next try", async () => {
    await sandbox.runPython(OWNER_SCRIPT, [], [], "fork-1");
    container.failing = WIPE_COMMAND[2];
    await expect(sandbox.runBash(LOOK_SCRIPT, [], [], "fork-2")).rejects.toThrow(/Could not empty the sandbox/);
    // The next script never ran.
    expect(container.sent.filter((argv) => argv.at(-1) === "run.sh")).toHaveLength(0);
    container.failing = undefined;
    const seen = await sandbox.runBash(LOOK_SCRIPT, [], [], "fork-2");
    expect(seen.stdout).not.toContain(`${WORKSPACE}/private.txt`);
  });

  it("runs nothing for the other audience when the container does not stop", async () => {
    await sandbox.runPython(OWNER_SCRIPT, [], [], owners);
    container.stuck = true;
    await expect(sandbox.runBash(LOOK_SCRIPT, [], [], others)).rejects.toThrow(/Could not start the sandbox afresh/);
    expect(container.sent.filter((argv) => argv.at(-1) === "run.sh")).toHaveLength(0);
  });
});

describe("an agent's sandbox: only a turn its owner asked for runs code", () => {
  const signsIn = () => false;
  const mcp = new Map();
  const tools = ["run_python", "run_bash", "files_read", "files_list", "files_write", "artifact_read"];

  it("gives no sandbox tools to a turn its owner did not ask for, whatever its files allow", () => {
    for (const files of [{ own: true, shared: true }, { own: true, shared: false }, { own: false, shared: false }]) {
      const allowed = allowedTools(tools, mcp, { files }, false, signsIn);
      expect(allowed).not.toContain("run_python");
      expect(allowed).not.toContain("run_bash");
      // Nor alone with its owner, nor unprompted.
      expect(allowedTools(tools, mcp, { files }, false, signsIn, { alone: true })).not.toContain("run_python");
      expect(allowedTools(tools, mcp, { files }, false, signsIn, { unprompted: true })).not.toContain("run_bash");
    }
  });
});
