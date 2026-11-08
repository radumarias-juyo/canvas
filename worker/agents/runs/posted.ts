// A shared agent's runs as someone other than its owner sees them: only the runs that posted their report into a chat
// that person is in (the one they open the agent from), and of each only what that post showed there. The rest of a
// run (its items and their steps, what its reads returned, its other deliveries and where they went, its trace, its
// cost, the memory notes it read) stays its owner's: a run reads as its owner, private servers too.

import type { SharedAgentView } from "../../../shared/agents.ts";
import { ID_PATTERN } from "../../../shared/protocol.ts";
import { firstLine } from "../../../shared/replies.ts";
import { postedInto, type AgentRunDetail, type AgentRunList, type AgentRunView, type RunDelivery } from "../../../shared/runs.ts";

type Refusal = { status: number; error: string };

/**
 * How a request for an agent's runs is answered: as its owner's (`own`: the asker has the agent; every run in full,
 * and the owner's own checks refuse anyone else), as the runs posted in chat `from` (someone else's agent, opened from
 * that chat), or refused (a trace, which only its owner sees). Without `from`, someone else's request goes the owner's
 * way, which finds no such agent of theirs.
 */
export function runsAccess(own: boolean, from: string | null, trace: boolean): "owner" | "posted" | "refused" {
  if (own || from === null) return "owner";
  return trace ? "refused" : "posted";
}

/** What reading a shared agent's runs for someone else needs, bound to who asks and which agent (worker/runs-routes.ts). */
export interface PostedRunsDeps {
  /** The owner of chat `chatId` as the asker's sidebar knows it: null when they are not in it. */
  chatOwner(chatId: string): Promise<string | null>;
  /** The agent as the asker may open it from that chat (ChatAgent.sharedAgent: they are in it, and its owner shares it there). */
  sharedAgent(chatOwner: string, chatId: string): Promise<SharedAgentView | Refusal>;
  /** The agent's home conversation, in its owner's directory. */
  agentHome(owner: string): Promise<string | null>;
  /** The runs, or one run, of the home conversation that posted in the chat (ChatAgent.postedRuns, postedRun). */
  list(owner: string, home: string): Promise<AgentRunList | Refusal>;
  run(owner: string, home: string, dueAt: number): Promise<AgentRunDetail | Refusal>;
}

/**
 * A shared agent's runs (`dueAt`: one of them) for someone other than its owner, who opens it from chat `chatId`. Only
 * when they are in that chat, its owner shares the agent there, and the chat is its owner's own (a run posts only into
 * its owner's chats, so no other chat can hold one of its posts); then only the runs that posted into it.
 */
export async function readPostedRuns(deps: PostedRunsDeps, chatId: string, dueAt?: number): Promise<AgentRunList | AgentRunDetail | Refusal> {
  const noRun = dueAt === undefined ? { runs: [], nextRunAt: null, homeChatId: null } : { status: 404, error: "No such run in this chat." };
  if (!ID_PATTERN.test(chatId)) return { status: 404, error: "No such chat." };
  const chatOwner = await deps.chatOwner(chatId);
  if (!chatOwner) return { status: 404, error: "No such chat." };
  const shared = await deps.sharedAgent(chatOwner, chatId);
  if ("status" in shared) return shared;
  if (shared.ownerUid !== chatOwner) return noRun;
  const home = await deps.agentHome(shared.ownerUid);
  if (!home) return noRun;
  return dueAt === undefined ? deps.list(shared.ownerUid, home) : deps.run(shared.ownerUid, home, dueAt);
}

/** The delivery of a run that posted its report into `chatId`, if one did. */
export function postIn(deliveries: readonly RunDelivery[], chatId: string): RunDelivery | undefined {
  return deliveries.find((delivery) => postedInto(delivery).includes(chatId));
}

/** A run as the runs list shows it to someone in `chatId`: what the post there showed, else null (they see none of it). */
export function postedRunView(run: AgentRunView, deliveries: readonly RunDelivery[], chatId: string): AgentRunView | null {
  const post = postIn(deliveries, chatId);
  if (!post?.text) return null;
  return {
    agentId: run.agentId,
    dueAt: run.dueAt,
    why: run.why,
    // It was posted there, whatever else of it went or did not.
    status: "sent",
    startedAt: run.startedAt,
    ...(run.endedAt !== undefined && { endedAt: run.endedAt }),
    cost: 0,
    // How many items its scope listed and how each went are not in the post: none shown.
    items: { total: 0, acted: 0, notToday: 0, blocked: 0, failed: 0, waiting: 0 },
    summary: firstLine(post.text),
  };
}

/** One run in full as someone in `chatId` sees it: the post there and what the definition says; else null. */
export function postedRunDetail(run: AgentRunDetail, chatId: string): AgentRunDetail | null {
  const view = postedRunView(run, run.deliveries, chatId);
  const post = postIn(run.deliveries, chatId);
  if (!view || !post?.text) return null;
  return {
    ...view,
    when: run.when,
    itemsList: [],
    deliveries: [{ kind: "chat", to: "this chat", text: post.text, status: "sent", ...(post.sentAt !== undefined && { sentAt: post.sentAt }) }],
    // Only what its definition names (its skills and servers), which the shared view shows anyway.
    used: { skills: run.used.skills, servers: run.used.servers, models: [], notes: 0 },
  };
}
