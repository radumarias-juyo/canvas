import { useRef } from "react";
import type { ChatAgentReplyData } from "../../shared/agents.ts";
import { everyone, type PublishedDetails } from "../../shared/protocol.ts";
import { agentPath } from "../agents/nav.ts";
import { whyLabel } from "../agents/runs.ts";
import { AppLink } from "../layout.tsx";
import { callerName } from "./agentLines.ts";
import { ArtifactCard } from "./ArtifactCard.tsx";
import { Markdown } from "./Markdown.tsx";
import { MessageActions } from "./MessageActions.tsx";
import { Fold, ItemChips } from "./Fold.tsx";
import { AgentByline, useSharedChat } from "./people.tsx";
import { ReactionChips, type MessageReactions } from "./Reactions.tsx";
import { SentTime } from "./SentTime.tsx";

/** Who gave an agent the turn it answers, as its byline says it. */
function calledByLabel(calledBy: ChatAgentReplyData["calledBy"], run: ChatAgentReplyData["run"]): string {
  if (run) return whyLabel(run.test ? "test" : run.why).toLowerCase();
  return calledBy.schedule ? "on its schedule" : `for ${callerName(calledBy)}`;
}

/**
 * Where a reply built on private servers came from, as the app recorded its calls: "from Ana's calendar · posted by
 * Ana". `ownerName` is the agent's owner's, as the chat's people say it; none in a chat of the viewer's alone.
 */
export function sourceLine(data: Pick<ChatAgentReplyData, "sources" | "postedBy">, ownerName: string | undefined): string | null {
  if (!data.sources?.length) return null;
  const posted = data.postedBy ? ` · posted by ${ownerName ?? "you"}` : "";
  return `from ${ownerName ? `${ownerName}'s` : "your"} ${data.sources.join(", ")}${posted}`;
}

/**
 * One reply of an agent besides pi (a `chat.agent` entry): its badge and name, whose it is and who asked, its text
 * (folded behind "Show more" when long), the records it is built on as chips, the artifacts it published and why it
 * ended early. Its steps show live while it works (AgentTurnLive), then stay in its own session.
 */
export function AgentReply({
  data,
  chatId,
  reactions,
  onReply,
  onOpen,
}: {
  data: ChatAgentReplyData;
  /** The chat it is in: the run's page leads back to it. */
  chatId: string;
  reactions: MessageReactions | null;
  onReply?: () => void;
  onOpen: (artifact: PublishedDetails) => void;
}) {
  const content = useRef<HTMLDivElement>(null);
  const people = useSharedChat();
  // Whose agent it is: it works with their sign-ins and budget.
  const owner = people && everyone(people).find((person) => person.uid === data.ownerUid)?.name;
  // In a shared chat whose people no longer list the owner (they left), never "your": the viewer is not the owner.
  const source = sourceLine(data, people ? (owner ?? "its owner") : undefined);
  const runPath = data.run && agentPath({ id: data.agentId, tab: "runs", run: data.run.dueAt, chat: chatId });
  return (
    <div className="agent-reply" ref={content}>
      <AgentByline name={data.name} badge={data} note={["agent", owner && `${owner}'s`, calledByLabel(data.calledBy, data.run)].filter(Boolean).join(" · ")} />
      {data.text && (
        <Fold foldKey={`agent:${data.agentId}:${data.turn}`}>
          <div className="bubble markdown">
            <Markdown text={data.text} />
          </div>
        </Fold>
      )}
      {data.items && <ItemChips items={data.items} />}
      {source && (
        <div className="source-chip" title="It read servers its owner does not share with the chat; only this reply was posted">
          {source}
        </div>
      )}
      {data.published?.map((artifact) => (
        <ArtifactCard key={`${artifact.artifactId}:${artifact.version}`} artifact={artifact} onOpen={onOpen} />
      ))}
      {data.failed && <div className="chat-error">{data.failed}</div>}
      {runPath && (
        // A run's post: where it came from, opening on how the run got there. A reply to it continues the run.
        <AppLink path={runPath} className="run-marker">
          {data.run?.test ? "Test run: nothing was sent or changed" : "From a run"} · See how it got there
        </AppLink>
      )}
      {data.text && (
        <>
          <ReactionChips reactions={reactions} />
          <div className="message-foot">
            <MessageActions content={content} text={data.text} reactions={reactions} onReply={onReply} />
            <SentTime at={data.endedAt} />
          </div>
        </>
      )}
    </div>
  );
}
