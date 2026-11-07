import type { MemoryNote } from "../shared/memory.ts";
import { json, readJson } from "./http.ts";
import type { UserDirectory } from "./users.ts";

/**
 * The memory notes of a verified user (`directory` is their UserDirectory), as the Memory view and an agent's Knows tab
 * show and change them (shared/memory.ts):
 *   GET    /api/memory              {notes: [MemoryNoteView], coverage: [ServerCoverage]}, forgotten notes too
 *   POST   /api/memory              {text, scope, agentId?, chatId?, pinned?}: a note the user writes, confirmed
 *   PATCH  /api/memory/:id          {text?, pinned?, confirmed?: true, scope?, agentId?, chatId?}: change one
 *   POST   /api/memory/:id/forget   no agent reads it from now on
 *   POST   /api/memory/:id/restore  bring a forgotten one back
 *   DELETE /api/memory/:id          delete one for good
 *   GET    /api/memory/dreams       pi's and the agents' nightly dreams: settings, the latest ones (DreamsView)
 *   PUT    /api/memory/dreams/settings     {piLearns?, timeZone?}
 *   POST   /api/memory/dreams/:subject/now  "Dream now" for pi ("pi") or an agent, rate-limited (429 with retryAt)
 * Every body is JSON (readJson), so another site cannot write a note into a signed-in user's memory.
 * Returns null for any other path.
 */
export async function memoryRoute(request: Request, directory: DurableObjectStub<UserDirectory>): Promise<Response | null> {
  const path = new URL(request.url).pathname;
  if (path !== "/api/memory" && !path.startsWith("/api/memory/")) return null;
  const method = request.method;
  const answer = (result: MemoryNote | { error: string } | null) => (result && "error" in result ? json(result, 400) : json(result ?? {}));
  if (path === "/api/memory" && method === "GET") {
    return json(await directory.memoryView());
  }
  // The nightly dreams (shared/dream.ts): what they did, their settings, and the owner's "Dream now".
  if (path === "/api/memory/dreams" && method === "GET") return json(await directory.dreams());
  if (path === "/api/memory/dreams/settings" && method === "PUT") {
    const body = await readJson(request);
    if (!body) return json({ error: "Expected the settings as JSON (content-type: application/json)." }, 400);
    const set = await directory.setDreamSettings(body);
    return json(set, "error" in set ? 400 : 200);
  }
  const now = path.match(/^\/api\/memory\/dreams\/(pi|[a-f0-9]{16})\/now$/);
  if (now && method === "POST") {
    // A body is required (JSON), as for every write here: another site cannot start a dream.
    if (!(await readJson(request))) return json({ error: "Expected {} as JSON (content-type: application/json)." }, 400);
    const done = await directory.dreamNow(now[1]);
    return json(done, "error" in done ? ("retryAt" in done ? 429 : 404) : 200);
  }
  if (path === "/api/memory" && method === "POST") {
    const body = await readJson(request);
    if (!body) return json({ error: "Expected a note as JSON (content-type: application/json)." }, 400);
    return answer(await directory.addNote(body));
  }
  const one = path.match(/^\/api\/memory\/([a-f0-9]{12})(\/forget|\/restore)?$/);
  if (!one) return null;
  const [, id, action] = one;
  if (action === "/forget" && method === "POST") return answer(await directory.forgetNote(id));
  if (action === "/restore" && method === "POST") return answer(await directory.restoreNote(id));
  if (action) return null;
  if (method === "PATCH") {
    const body = await readJson(request);
    if (!body) return json({ error: "Expected a change as JSON (content-type: application/json)." }, 400);
    return answer(await directory.changeNote(id, body));
  }
  if (method === "DELETE") return answer(await directory.deleteNote(id));
  return null;
}
