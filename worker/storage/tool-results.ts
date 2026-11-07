import { sha256Hex } from "../../shared/util.ts";
import { deleteKeys, deletePrefix, listPrefix } from "./r2.ts";

/** What a saved result's path starts with, as the spill note names it and files_read and the sandbox take it. */
export const TOOL_RESULTS = "tool-results/";
/** How many results one chat keeps: saving one more drops the oldest. */
export const MAX_TOOL_RESULTS = 50;
/** How long a result is kept: older ones go as the next one is saved. */
export const TOOL_RESULT_MS = 2 * 86_400_000;

/** A saved result's name: the tool's (to read by) and the start of its content's hash (one file for a result read again). */
const NAME = /^[A-Za-z0-9_-]{1,60}-[0-9a-f]{16}\.txt$/;

/** Whether `path` names a saved result (TOOL_RESULTS and a name put gives): any other path is one of the user's files. */
export function isToolResult(path: string): boolean {
  return path.startsWith(TOOL_RESULTS) && NAME.test(path.slice(TOOL_RESULTS.length));
}

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

  /** The result saved at `path` (as put returned it); null for a path that names none, or one gone (past TOOL_RESULT_MS too). */
  async get(path: string): Promise<R2ObjectBody | null> {
    if (!isToolResult(path)) return null;
    const key = this.#prefix + path.slice(TOOL_RESULTS.length);
    const object = await this.#bucket.get(key, { ssecKey: this.#key });
    if (!object || this.#now() - +object.uploaded <= TOOL_RESULT_MS) return object;
    await this.#bucket.delete(key);
    return null;
  }

  /** Drop every result of the chat. */
  async deleteAll(): Promise<void> {
    await deletePrefix(this.#bucket, this.#prefix);
  }

  /** Drop those past TOOL_RESULT_MS and, newest first, past MAX_TOOL_RESULTS; never `kept`, just saved. */
  async #prune(kept: string): Promise<void> {
    const objects = (await listPrefix(this.#bucket, this.#prefix)).sort((a, b) => +b.uploaded - +a.uploaded);
    const old = objects.filter((o, i) => o.key !== this.#prefix + kept && (i >= MAX_TOOL_RESULTS || this.#now() - +o.uploaded > TOOL_RESULT_MS));
    await deleteKeys(
      this.#bucket,
      old.map((o) => o.key),
    );
  }
}
