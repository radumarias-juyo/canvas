import type { FeedInput } from "../shared/feed.ts";
import type { MemoryKind, MemoryScope, ServerCoverage } from "../shared/memory.ts";
import { errorMessage } from "../shared/util.ts";
import type { ChatAgent } from "./chat-agent.ts";
import { devOn, type DevEnv } from "./dev-model.ts";
import { answerJson, json, readJson } from "./http.ts";
import type { UserDirectory } from "./users.ts";

const PREFIX = "/api/dev/";

/** What the dev routes reach besides the user's directory, as the Worker gives it (tests give fakes). */
export interface DevReach {
  /** One of the user's chats' objects, by id. */
  chat(chatId: string): Pick<DurableObjectStub<ChatAgent>, "devFunnel" | "devPublish">;
  /** The runs routes, with their dev path on (a real run now). */
  runs(): Promise<Response | null>;
}

/**
 * Local development's routes, to try the app without a model or scheduled runs. Every one is behind one guard: only
 * with devOn (DEV_TOOLS=true and the demo sign-in, AUTH_MODE=demo); anywhere else each is a 404, whatever else is set.
 * All as the signed-in user (`uid`, and `directory` their UserDirectory), on their own chats and agents only:
 *   POST /api/dev/chats/:id/publish   publish a page without the model (ChatAgent.devPublish)
 *   GET  /api/dev/chats/:id/funnel    the speak-up funnel's latest stages there (ChatAgent.devFunnel)
 *   POST /api/dev/agents/propose      save an agent as the model proposes one (off, for review)
 *   POST /api/dev/agents/:id/run      a real run now (worker/runs-routes.ts)
 *   POST /api/dev/memory              notes as agents learn them, and what servers cover ({learn?, coverage?})
 *   POST /api/dev/dream               a dream with the model's answer scripted ({subject: "pi" | agentId, answer})
 *   POST /api/dev/feed                an item in the caller's own feed
 * Null for any path outside /api/dev/.
 */
export async function devRoute(
  request: Request,
  env: DevEnv,
  uid: string,
  directory: DurableObjectStub<UserDirectory>,
  reach: DevReach,
): Promise<Response | null> {
  const path = new URL(request.url).pathname;
  if (!path.startsWith(PREFIX)) return null;
  if (!devOn(env)) return json({ error: "Not found" }, 404);
  const method = request.method;

  const inChat = path.match(/^\/api\/dev\/chats\/([a-z0-9]+)\/(publish|funnel)$/);
  if (inChat) {
    const [, chatId, what] = inChat;
    if (method !== (what === "publish" ? "POST" : "GET")) return json({ error: "Not found" }, 404);
    if (!(await directory.hasChat(chatId))) return json({ error: "No such chat" }, 404);
    const chat = reach.chat(chatId);
    if (what === "funnel") return answerJson(await chat.devFunnel(uid));
    try {
      return json(await chat.devPublish(await request.json()));
    } catch (error) {
      return json({ error: errorMessage(error) }, 400);
    }
  }

  if (path === "/api/dev/agents/propose" && method === "POST") {
    const saved = await directory.saveAgent(await readJson(request), "agent", false);
    return json(saved, "error" in saved ? 400 : 201);
  }
  if (path === "/api/dev/memory" && method === "POST") return devMemory(request, directory);
  if (path === "/api/dev/dream" && method === "POST") {
    const body = await readJson<{ subject?: unknown; answer?: unknown }>(request);
    if (typeof body?.subject !== "string" || typeof body.answer !== "string") return json({ error: "Expected {subject, answer}." }, 400);
    return json(await directory.dreamNow(body.subject, body.answer));
  }
  if (path === "/api/dev/feed" && method === "POST") {
    const item = await readJson<FeedInput>(request);
    if (!item || typeof item.ref !== "string" || typeof item.title !== "string" || !item.open) {
      return json({ error: "Expected a feed item (shared/feed.ts)." }, 400);
    }
    return json({ kept: await directory.addFeed({ ...item, ref: `dev:${item.ref}`, at: item.at || Date.now() }) });
  }
  // A real run now: the runs routes' own, with its dev path on.
  return (await reach.runs()) ?? json({ error: "Not found" }, 404);
}

/** See /api/dev/memory: {learn?: [{chatId, text, scope, kind, agentId?, learnedBy?, byOwner?}], coverage?: [ServerCoverage]}. */
async function devMemory(request: Request, directory: DurableObjectStub<UserDirectory>): Promise<Response> {
  const body = await readJson<{ learn?: Record<string, unknown>[]; coverage?: ServerCoverage[] }>(request);
  if (!body) return json({ error: "Expected JSON." }, 400);
  if (Array.isArray(body.coverage)) await directory.noteCoverage(body.coverage);
  const learned = [];
  for (const note of body.learn ?? []) {
    const chatId = String(note.chatId);
    const kind = await directory.chatKind(chatId);
    const agentId = typeof note.agentId === "string" ? note.agentId : undefined;
    learned.push(
      await directory.learnNote(
        { chatId, kinds: [kind], alone: kind === "private", byOwner: note.byOwner !== false, learnedBy: String(note.learnedBy ?? "pi"), ...(agentId && { agentId }) },
        { text: note.text, scope: note.scope as MemoryScope, kind: note.kind as MemoryKind },
      ),
    );
  }
  return json(learned);
}
