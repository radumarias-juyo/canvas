import { exports } from "cloudflare:workers";
import { AGENT_ID_PATTERN } from "../shared/agents.ts";
import type { AgentRunDetail, AgentRunList } from "../shared/runs.ts";
import { readPostedRuns, runsAccess } from "./agents/runs/posted.ts";
import { chatAgentName } from "./chat-agent.ts";
import { answerJson, json, readJson } from "./http.ts";
import type { UserDirectory } from "./users.ts";

/**
 * The runs of a verified user's agents (`uid`, and `directory` their UserDirectory), which live in each agent's home
 * conversation (worker/agents/runs/):
 *   GET  /api/agents/:id/runs                    its runs, newest first, when it runs next, its home chat
 *   GET  /api/agents/:id/runs/:dueAt             one run in full
 *   GET  /api/agents/:id/runs/:dueAt/trace?item= the entries of one item's session, oldest first
 *   GET  /api/agents/:id/runs[/:dueAt]?chat=     someone else's agent shared in that chat: the runs that posted there (postedRuns)
 *   POST /api/agents/:id/test                    Test it: a run now in which nothing is sent or changed; {dueAt}
 *   POST /api/agents/:id/compile                 its instructions compiled to a workflow, saved: the definition
 *   POST /api/dev/agents/:id/run                 a real run now (DEV_TOOLS=true only, as the dev publish route)
 * POST bodies are JSON (readJson), so another site cannot start a run for a signed-in user. Null for any other path.
 */
export async function runsRoute(request: Request, uid: string, directory: DurableObjectStub<UserDirectory>, devTools: boolean): Promise<Response | null> {
  const path = new URL(request.url).pathname;
  const method = request.method;
  const match = path.match(/^\/api(\/dev)?\/agents\/([a-f0-9]+)\/(runs|test|compile|run)(?:\/(\d{1,16}))?(\/trace)?$/);
  if (!match || !AGENT_ID_PATTERN.test(match[2])) return null;
  const [, dev, agentId, what, dueAt, trace] = match;
  if (Boolean(dev) !== (what === "run")) return null;
  const answer = answerJson;
  const chat = (home: string) => exports.ChatAgent.getByName(chatAgentName(uid, home));

  if (method === "GET" && what === "runs") {
    const home = await directory.agentHome(agentId);
    const own = home !== null || (await directory.getAgent(agentId)) !== null;
    // Someone else's agent, opened from a chat it is shared in: only the runs that posted there.
    const from = new URL(request.url).searchParams.get("chat");
    const access = runsAccess(own, from, Boolean(trace));
    if (access === "refused") return json({ error: "Only the agent's owner sees how a run got there." }, 403);
    if (access === "posted") return answer(await postedRuns(uid, directory, agentId, from!, dueAt));
    if (dueAt === undefined) {
      if (!home) return own ? json({ runs: [], nextRunAt: null, homeChatId: null }) : json({ error: "No such agent." }, 404);
      return answer(await chat(home).runsFor(uid, agentId));
    }
    if (!home) return json({ error: "No such run." }, 404);
    if (trace) return answer(await chat(home).runTrace(uid, agentId, Number(dueAt), new URL(request.url).searchParams.get("item") ?? ""));
    return answer(await chat(home).runDetail(uid, agentId, Number(dueAt)));
  }

  // POST .../runs is no route: a real run now is the dev route's only.
  if (method !== "POST" || what === "runs" || dueAt !== undefined || trace) return null;
  if (!(await readJson(request))) return json({ error: "Expected a JSON body (content-type: application/json), such as {}." }, 400);
  if (what === "run" && !devTools) return null;
  // Its first run makes an agent's home conversation, as turning it on does: a draft's Test it runs there too.
  const home = await directory.ensureAgentHome(agentId);
  if (!home) return json({ error: "No such agent." }, 404);
  if (what === "compile") return answer(await chat(home).compileAgent(uid, agentId));
  const started = await chat(home).startRun(uid, agentId, what === "test");
  return answer("status" in started ? started : { ...started, homeChatId: home }, 202);
}

/**
 * A shared agent's runs for someone other than its owner (`uid`), who opens it from chat `chatId`: they must be in that
 * chat and its owner must share the agent there (ChatAgent.sharedAgent, the check that opening it makes). Then its home
 * conversation, in its owner's namespace, gives only the runs that posted their report into that chat, and of each only
 * that post (ChatAgent.postedRuns, postedRun). Read-only: Test it, compile and traces stay its owner's.
 */
async function postedRuns(
  uid: string,
  directory: DurableObjectStub<UserDirectory>,
  agentId: string,
  chatId: string,
  dueAt: string | undefined,
): Promise<AgentRunList | AgentRunDetail | { status: number; error: string }> {
  return readPostedRuns(
    {
      chatOwner: (id) => directory.chatOwner(id),
      sharedAgent: (owner, id) => exports.ChatAgent.getByName(chatAgentName(owner, id)).sharedAgent(uid, agentId),
      agentHome: (owner) => exports.UserDirectory.getByName(owner).agentHome(agentId),
      list: (owner, home) => exports.ChatAgent.getByName(chatAgentName(owner, home)).postedRuns(agentId, chatId),
      run: (owner, home, at) => exports.ChatAgent.getByName(chatAgentName(owner, home)).postedRun(agentId, at, chatId),
    },
    chatId,
    dueAt === undefined ? undefined : Number(dueAt),
  );
}
