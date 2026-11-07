import { useMemo, useRef, useState } from "react";
import type { ChatAgentReplyData } from "../../shared/agents.ts";
import { offerOf } from "../../shared/offers.ts";
import { everyone, type PublishedDetails } from "../../shared/protocol.ts";
import { errorMessage } from "../../shared/util.ts";
import { api } from "../api.ts";
import { agentPath } from "../agents/nav.ts";
import { whyLabel } from "../agents/runs.ts";
import { AppLink } from "../layout.tsx";
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
function calledByLabel(calledBy: ChatAgentReplyData["calledBy"], run: ChatAgentReplyData["run"]): string {
  if (run) return whyLabel(run.test ? "test" : run.why).toLowerCase();
  if (calledBy.schedule) return "on its schedule";
  if (calledBy.unprompted === "speak-up") return "unprompted";
  if (calledBy.unprompted === "follow-up") return `following up for ${calledBy.name}`;
  return calledBy.routed ? `for ${callerName(calledBy)} · picked, as nobody was named` : `for ${callerName(calledBy)}`;
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
  entry,
  onOfferYes,
}: {
  data: ChatAgentReplyData;
  /** The chat it is in: the run's page leads back to it, and a reply nobody asked for offers to mute its agent there. */
  chatId: string;
  reactions: MessageReactions | null;
  onReply?: () => void;
  onOpen: (artifact: PublishedDetails) => void;
  /** Its entry in the transcript, which the answer to its offered next step is remembered by. */
  entry?: number;
  /** On the chat's latest offer, for its owner: what Yes does (OfferRow). */
  onOfferYes?: (offer: string) => boolean;
}) {
  const content = useRef<HTMLDivElement>(null);
  const people = useSharedChat();
  // Whose agent it is: it works with their sign-ins and budget.
  const owner = people && everyone(people).find((person) => person.uid === data.ownerUid)?.name;
  // The next step it offers, shown under the reply without its line in the text.
  const offered = useMemo(() => offerOf(data.text), [data.text]);
  const said = offered ? offered.body : data.text;
  const runPath = data.run && agentPath({ id: data.agentId, tab: "runs", run: data.run.dueAt, chat: chatId });
  return (
    <div className="agent-reply" ref={content}>
      <AgentByline name={data.name} badge={data} note={["agent", owner && `${owner}'s`, calledByLabel(data.calledBy, data.run)].filter(Boolean).join(" · ")} />
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
      {runPath && (
        // A run's post: where it came from, opening on how the run got there. A reply to it continues the run.
        <AppLink path={runPath} className="run-marker">
          {data.run?.test ? "Test run: nothing was sent or changed" : "From a run"} · See how it got there
        </AppLink>
      )}
      {data.calledBy.unprompted && <MuteRow chatId={chatId} agentId={data.agentId} name={data.name} />}
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

/**
 * Under a reply nobody asked for: Mute, for anyone in the chat, so the agent posts nothing unprompted here again. Its
 * owner, or the chat's, can unmute it from its menu in the people bar or the chat's agent settings.
 */
function MuteRow({ chatId, agentId, name }: { chatId: string; agentId: string; name: string }) {
  const [state, setState] = useState<"idle" | "muting" | "muted">("idle");
  const [error, setError] = useState<string>();
  const mute = async () => {
    setState("muting");
    setError(undefined);
    try {
      await api.muteChatAgent(chatId, agentId, true);
      setState("muted");
    } catch (e) {
      setError(errorMessage(e));
      setState("idle");
    }
  };
  return (
    <div className="mute-row">
      <span className="pill unprompted">Nobody asked</span>
      {state === "muted" ? (
        <span>@{name} won't speak up unasked here again.</span>
      ) : (
        <button type="button" className="link-button" onClick={mute} disabled={state === "muting"}>
          {state === "muting" ? "Muting…" : `Mute @${name} here`}
        </button>
      )}
      {error && <span className="chat-error">{error}</span>}
    </div>
  );
}
