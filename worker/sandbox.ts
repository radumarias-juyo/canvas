import { Files } from "@cloudflare/sandbox";
import { DurableObject } from "cloudflare:workers";
import { clipStart, mapLimit } from "../shared/util.ts";
import { workspaceFresh } from "./agent/sandbox-names.ts";

const WORKSPACE = "/workspace";
const INACTIVITY_TIMEOUT_MS = 10 * 60_000;
const RUN_TIMEOUT_SECONDS = 60;
/**
 * The most of a run's output the model reads: its end, where results and errors are. All of it stays in the
 * conversation, which every later call sends again; a script that has more to show writes it to ./out.
 */
export const MAX_RUN_STDOUT = 10_000;
export const MAX_RUN_STDERR = 4_000;
/** How many files are written into the container at once. */
const PARALLEL_WRITES = 16;
/** The storage key of the session that ran last here (workspaceFresh). */
const LAST_SESSION = "session";

export interface SandboxFile {
  /** Relative to ./files/ for an input, which may be in folders ("q3/sales.csv"); a file name for an output. */
  name: string;
  bytes: ArrayBuffer;
}

export interface SandboxRun {
  exitCode: number;
  stdout: string;
  stderr: string;
  /** Files the script wrote to /workspace/out. */
  outputs: SandboxFile[];
}

/**
 * One Linux container for code a chat's sessions run: pi's in the chat's sandbox, each agent's in one of its own there
 * (worker/agent/sandbox-names.ts). No internet: data comes in as files the session picks from R2, in their folders
 * under ./files (and skills' folders under ./skills), and results go back the same way. Each run starts with fresh
 * ./files, ./skills and ./out; anything else under /workspace stays while the container is up (10 minutes after the
 * last run), for the same session's next run only: a run of another session (`session`) starts with an empty
 * /workspace. Runs go one at a time.
 */
export class Sandbox extends DurableObject<Env> {
  /** The runs in order: one at a time, so a session never runs over another's /workspace. */
  #queue: Promise<unknown> = Promise.resolve();

  /** `skills` are skill folders' files, named <skill>/<path>: they go under ./skills/. */
  async runPython(code: string, inputs: SandboxFile[], skills: SandboxFile[], session = ""): Promise<SandboxRun> {
    return this.#queued(() => this.#run({ name: "main.py", contents: code }, ["python3", "main.py"], inputs, skills, session));
  }

  /** A bash script, run as written: it stops at the first failing command only if it says `set -e`. */
  async runBash(script: string, inputs: SandboxFile[], skills: SandboxFile[], session = ""): Promise<SandboxRun> {
    return this.#queued(() => this.#run({ name: "run.sh", contents: script }, ["bash", "run.sh"], inputs, skills, session));
  }

  #queued<T>(work: () => Promise<T>): Promise<T> {
    const next = this.#queue.then(work);
    this.#queue = next.catch(() => {});
    return next;
  }

  /** Stop the container, if it is up, and forget everything: its chat was deleted. */
  async destroy(): Promise<void> {
    if (this.ctx.container?.running) await this.ctx.container.destroy();
    await this.ctx.storage.deleteAll();
  }

  async #run(
    entry: { name: string; contents: string },
    argv: string[],
    inputs: SandboxFile[],
    skills: SandboxFile[],
    session: string,
  ): Promise<SandboxRun> {
    const { container, started } = await this.#ensureRunning();
    const files = new Files(container);
    // Another session ran here last: nothing it left under /workspace is this one's to read.
    if (workspaceFresh(await this.ctx.storage.get<string>(LAST_SESSION), session, started)) {
      await this.#exec(container, ["sh", "-c", `find ${WORKSPACE} -mindepth 1 -delete`]);
    }
    await this.ctx.storage.put(LAST_SESSION, session);

    // Inputs and skills keep their folders: made with ./files, ./skills and ./out, passed as arguments so their names
    // need no quoting.
    const placed = [...inputs.map((file) => ({ path: `${WORKSPACE}/files/${file.name}`, bytes: file.bytes })), ...skills.map((file) => ({ path: `${WORKSPACE}/skills/${file.name}`, bytes: file.bytes }))];
    const folders = new Set(placed.map((file) => file.path.slice(0, file.path.lastIndexOf("/"))));
    const dirs = [`${WORKSPACE}/files`, `${WORKSPACE}/skills`, `${WORKSPACE}/out`, ...folders];
    await this.#exec(container, ["sh", "-c", `rm -rf ${WORKSPACE}/files ${WORKSPACE}/skills ${WORKSPACE}/out && mkdir -p "$@"`, "sh", ...dirs]);
    await mapLimit([...placed, { path: `${WORKSPACE}/${entry.name}`, bytes: entry.contents }], PARALLEL_WRITES, (file) => files.writeFile(file.path, file.bytes));

    // A skill's scripts may be run by their path, as its instructions say: the zip kept no modes, so they are made
    // executable, in the same exec as the run.
    const prepare = skills.length ? `chmod -R u+x ${WORKSPACE}/skills && ` : "";
    const run = await this.#exec(container, ["sh", "-c", `${prepare}exec timeout ${RUN_TIMEOUT_SECONDS} "$@"`, "sh", ...argv]);

    const written = (await files.readDirectory(`${WORKSPACE}/out`)).filter((entry) => entry.type === "file");
    const outputs = await Promise.all(
      written.map(async (entry) => ({ name: entry.name, bytes: await (await files.readFile(`${WORKSPACE}/out/${entry.name}`)).arrayBuffer() })),
    );
    return { ...run, outputs };
  }

  async #exec(container: Container, argv: string[]): Promise<Omit<SandboxRun, "outputs">> {
    const process = await container.exec(argv, { cwd: WORKSPACE });
    const output = await process.output();
    const decoder = new TextDecoder();
    return {
      exitCode: output.exitCode,
      stdout: clipStart(decoder.decode(output.stdout), MAX_RUN_STDOUT),
      stderr: clipStart(decoder.decode(output.stderr), MAX_RUN_STDERR),
    };
  }

  /** The container, started when it was not running (`started`: its /workspace is empty). */
  async #ensureRunning(): Promise<{ container: Container; started: boolean }> {
    const container = this.ctx.container;
    if (!container) throw new Error("This Worker has no container binding for the sandbox.");
    if (container.running) return { container, started: false };
    container.start({ image: container.images.sandbox, instance: "lite", enableInternet: false });
    await container.setInactivityTimeout(INACTIVITY_TIMEOUT_MS);
    return { container, started: true };
  }
}
