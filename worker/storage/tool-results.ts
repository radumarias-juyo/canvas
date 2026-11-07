import { sha256Hex } from "../../shared/util.ts";
import { deletePrefix } from "./r2.ts";

/** What a saved result's path starts with, as the spill note names it and files_read and the sandbox take it. */
export const TOOL_RESULTS = "tool-results/";
/** How many results one chat keeps: saving one more drops the oldest. */
export const MAX_TOOL_RESULTS = 50;
/** How long a result is kept: older ones go as the next one is saved. */
export const TOOL_RESULT_MS = 2 * 86_400_000;

/** A saved result's name: the tool's (to read by) and the start of its content's hash (one file for a result read again). */
const NAME = /^[A-Za-z0-9_-]{1,60}-[0-9a-f]{16}\.txt$/;

/**
 * The MCP results too long for a turn of one chat (worker/agent/mcp.ts spills them), kept whole for the agent to read
 * on: in the owner's folder but outside their files (`users/<uid>/tool-results/<chatId>/`), so they never show in a
 * listing, the prompt's file index or the @ list, and never push the owner's files out of one. Encrypted with the
 * owner's key. At most MAX_TOOL_RESULTS a chat, none older than TOOL_RESULT_MS; deleted with the chat.
 */
export class ToolResults {
  readonly #bucket: R2Bucket;
  readonly #prefix: string;
  readonly #key: ArrayBuffer;
  readonly #now: () => number;

  /** Use `Storage.toolResults(uid, chatId)`; the uid must come from a verified identity. */
  constructor(bucket: R2Bucket, uid: string, chatId: string, key: ArrayBuffer, now: () => number = Date.now) {
    this.#bucket = bucket;
    this.#prefix = `users/${uid}/tool-results/${chatId}/`;
    this.#key = key;
    this.#now = now;
  }

  /** Keep `text`, `tool`'s result, and make room: its path (TOOL_RESULTS and its name), for the spill note. */
  async put(tool: string, text: string): Promise<string> {
    const name = `${tool.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 60) || "tool"}-${(await sha256Hex(text)).slice(0, 16)}.txt`;
    await this.#bucket.put(this.#prefix + name, text, { ssecKey: this.#key, httpMetadata: { contentType: "text/plain; charset=utf-8" } });
    await this.#prune(name);
    return TOOL_RESULTS + name;
  }

  /** The text saved at `path` (as put returned it); null for a path that names none, or one gone. */
  async get(path: string): Promise<string | null> {
    const name = path.startsWith(TOOL_RESULTS) ? path.slice(TOOL_RESULTS.length) : path;
    if (!NAME.test(name)) return null;
    const object = await this.#bucket.get(this.#prefix + name, { ssecKey: this.#key });
    return object ? object.text() : null;
  }

  /** Drop every result of the chat. */
  async deleteAll(): Promise<void> {
    await deletePrefix(this.#bucket, this.#prefix);
  }

  /** Drop those past TOOL_RESULT_MS and, newest first, past MAX_TOOL_RESULTS; never `kept`, just saved. */
  async #prune(kept: string): Promise<void> {
    const objects: { key: string; uploaded: Date }[] = [];
    let cursor: string | undefined;
    do {
      const page = await this.#bucket.list({ prefix: this.#prefix, cursor, limit: 500 });
      objects.push(...page.objects);
      cursor = page.truncated ? page.cursor : undefined;
    } while (cursor);
    if (objects.length <= MAX_TOOL_RESULTS && objects.every((o) => this.#now() - +o.uploaded <= TOOL_RESULT_MS)) return;
    objects.sort((a, b) => +b.uploaded - +a.uploaded);
    const old = objects.filter((o, i) => o.key !== this.#prefix + kept && (i >= MAX_TOOL_RESULTS || this.#now() - +o.uploaded > TOOL_RESULT_MS));
    for (let i = 0; i < old.length; i += 1000) await this.#bucket.delete(old.slice(i, i + 1000).map((o) => o.key));
  }
}
