import { useMemo, useRef } from "react";
import type { ChatAgentReplyData } from "../../shared/agents.ts";
import { offerOf } from "../../shared/offers.ts";
import { everyone, type PublishedDetails } from "../../shared/protocol.ts";
import { callerName } from "./agentLines.ts";
import { ArtifactCard } from "./ArtifactCard.tsx";
import { Markdown } from "./Markdown.tsx";
import { MessageActions } from "./MessageActions.tsx";
import { Fold, ItemChips } from "./Fold.tsx";
import { OfferRow } from "./Offer.tsx";
import { AgentByline, useSharedChat } from "./people.tsx";
import { ReactionChips, type MessageReactions } from "./Reactions.tsx";
import { SentTime } from "./SentTime.tsx";

/** Who gave an agent the turn it answers, as its byline says it. */
function calledByLabel(calledBy: ChatAgentReplyData["calledBy"]): string {
  return calledBy.schedule ? "on its schedule" : `for ${callerName(calledBy)}`;
}

/**
 * One reply of an agent besides pi (a `chat.agent` entry): its badge and name, whose it is and who asked, its text
 * (folded behind "Show more" when long), the records it is built on as chips, the artifacts it published and why it
 * ended early. Its steps show live while it works (AgentTurnLive), then stay in its own session.
 */
export function AgentReply({
  data,
  reactions,
  onReply,
  onOpen,
  entry,
  onOfferYes,
}: {
  data: ChatAgentReplyData;
  reactions: MessageReactions | null;
  onReply?: () => void;
  onOpen: (artifact: PublishedDetails) => void;
  /** Its entry in the transcript, which the answer to its offered next step is remembered by. */
  entry?: number;
  /** On the chat's latest offer, for its owner: what Yes does (OfferRow). */
  onOfferYes?: () => boolean;
}) {
  const content = useRef<HTMLDivElement>(null);
  const people = useSharedChat();
  // Whose agent it is: it works with their sign-ins and budget.
  const owner = people && everyone(people).find((person) => person.uid === data.ownerUid)?.name;
  // The next step it offers, shown under the reply without its line in the text.
  const offered = useMemo(() => offerOf(data.text), [data.text]);
  const said = offered ? offered.body : data.text;
  return (
    <div className="agent-reply" ref={content}>
      <AgentByline name={data.name} badge={data} note={["agent", owner && `${owner}'s`, calledByLabel(data.calledBy)].filter(Boolean).join(" · ")} />
      {said && (
        <Fold foldKey={`agent:${data.agentId}:${data.turn}`}>
          <div className="bubble markdown">
            <Markdown text={said} />
          </div>
        </Fold>
      )}
      {data.items && <ItemChips items={data.items} />}
      {data.published?.map((artifact) => (
        <ArtifactCard key={`${artifact.artifactId}:${artifact.version}`} artifact={artifact} onOpen={onOpen} />
      ))}
      {offered && <OfferRow offer={offered.offer} entry={entry} onYes={onOfferYes} />}
      {data.failed && <div className="chat-error">{data.failed}</div>}
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
