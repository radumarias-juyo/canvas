import { Fragment, useEffect, useMemo, useRef, useState, type KeyboardEvent, type RefObject } from "react";
import { baseName } from "../../shared/attachments.ts";
import {
  activeQuery,
  AGENT_NAME,
  AGENT_TOKEN,
  splitAgent,
  keptMentions,
  matchMentions,
  mentionLabel,
  mentionToken,
  sameMention,
  splitMentions,
  type Mention,
  type MentionChoice,
  type MentionInput,
  type MentionOptions,
} from "../../shared/mentions.ts";
import { everyone, type ChatPeople, type Person } from "../../shared/protocol.ts";
import { formatBytes } from "../../shared/util.ts";
import { api } from "../api.ts";
import { AgentAvatar, Avatar, tintOf, tintStyle, useSharedChat } from "./people.tsx";

/** The agent, as the picker offers it in a shared chat, where "@pi" is what calls it. */
const AGENT_CHOICE = { agent: true, detail: "agent · asks it to answer" } as const;
/** For the owner, when nobody they know matches: tag the name anyway, and get an invite link to send them. */
type InviteChoice = { invite: string; detail: string };
type Choice = MentionChoice | typeof AGENT_CHOICE | InviteChoice;

/**
 * Who "@" knows besides the people in the chat: the people the user shares other chats with (`known`), whom tagging
 * offers to add (TagCard). `canInvite`: the user owns the chat, so a name nobody matches can get an invite link.
 */
export interface Outside {
  known: readonly Person[];
  canInvite: boolean;
}

/** Someone just tagged who is not in the chat: one the user knows, or (`invite`) a name nobody matched. */
export type Outsider = Person | { name: string; invite: true };

/**
 * "@" in the composer: as the user types "@" (or presses the @ button), a list of the chat owner's files and
 * artifacts opens over the input, filtered by what follows the "@". Arrows move, Enter or Tab picks, Escape closes.
 * A pick puts `@<path>`, `@<title>` or `@<name>` in the text and is sent with the message while that text is still there.
 * In a `shared` chat (its `people`, and the viewer's `uid`) the agent comes first: "@pi" in a message is what calls it
 * there; then the others in the chat, who are told when a message tags them.
 */
export function useMentions(
  chatId: string,
  draft: string,
  setDraft: (text: string) => void,
  input: RefObject<HTMLTextAreaElement | null>,
  people: ChatPeople | null,
  uid: string,
  outside?: Outside,
  /** All in the chat, the owner too, also in a chat nobody shares, where `people` is null: who is not an outsider. */
  inChat: readonly Person[] = [],
) {
  const shared = people !== null;
  // The last person tagged who is not in the chat, until the user answers the card about them.
  const [outsider, setOutsider] = useState<Outsider | null>(null);
  const [options, setOptions] = useState<MentionOptions | null>(null);
  const [picked, setPicked] = useState<Mention[]>([]);
  const [caret, setCaret] = useState(0);
  const [active, setActive] = useState(0);
  // Escape closes the list until the "@" it was for is gone or another is typed.
  const [dismissedAt, setDismissedAt] = useState<number | null>(null);
  const loading = useRef(false);

  const typed = activeQuery(draft, caret);
  // A picked mention's "@" is done while its text is there and the caret is within or just after it, wherever the caret
  // came from; edit the text, or type on past it, and the list reopens.
  const done =
    typed !== null &&
    [...picked.map(mentionLabel), ...(shared ? [AGENT_NAME] : [])].some(
      (label) => draft.startsWith(`@${label}`, typed.start) && typed.query.trimEnd().length <= label.length,
    );
  const query = typed && !done && typed.start !== dismissedAt ? typed : null;

  // Read when an "@" opens the list, so files uploaded and artifacts published since are in it.
  const wanted = query !== null;
  useEffect(() => {
    if (!wanted || loading.current) return;
    loading.current = true;
    api
      .mentions(chatId)
      .then(setOptions, () => setOptions({ files: [], artifacts: [] }))
      .finally(() => (loading.current = false));
  }, [wanted, chatId]);
  const typing = typed !== null;
  useEffect(() => {
    if (!typing) setDismissedAt(null);
  }, [typing]);

  // Everyone else in a shared chat: they are known before the files and artifacts load.
  // The people the user knows who are not in the chat: tagging one asks whether to add them (TagCard).
  const outsiders = useMemo(() => {
    const here = new Set([uid, ...inChat.map((person) => person.uid)]);
    return (outside?.known ?? []).filter((person) => !here.has(person.uid));
  }, [uid, inChat, outside?.known]);
  const others = useMemo<MentionChoice[]>(() => {
    const inside = people
      ? everyone(people)
          .filter((person) => person.uid !== uid)
          .map((person) => ({
            mention: { kind: "person" as const, uid: person.uid, name: person.name },
            detail: person.uid === people.owner.uid ? "owner · gets a notice" : "in this chat · gets a notice",
          }))
      : [];
    const known = outsiders.map((person) => ({ mention: { kind: "person" as const, uid: person.uid, name: person.name }, detail: "not in this chat" }));
    return [...inside, ...known];
  }, [people, uid, outsiders]);
  const all = useMemo<MentionChoice[]>(
    () =>
      options
        ? [
            ...options.artifacts.map((a) => ({
              mention: { kind: "artifact" as const, id: a.id, title: a.title },
              detail: `artifact · v${a.latest}${a.chatId === chatId ? " · this chat" : ""}`,
            })),
            ...options.files.map((f) => ({
              mention: { kind: "file" as const, path: f.path, ...(f.own && { own: true as const }) },
              detail: f.own ? `your file · ${formatBytes(f.size)}` : formatBytes(f.size),
            })),
          ]
        : [],
    [options, chatId],
  );
  const choices = useMemo<Choice[]>(() => {
    if (!query) return [];
    const callsAgent = shared && AGENT_NAME.startsWith(query.query.trim().toLowerCase());
    const matched = matchMentions([...others, ...all], query.query);
    // A name, typed in full, that is nobody the user knows: the owner may invite them by link.
    const name = query.query.trim();
    const invite =
      outside?.canInvite && /^[\p{L}][\p{L}\p{N}._-]{1,31}$/u.test(name) && !matched.some((choice) => choice.mention.kind === "person") && !AGENT_NAME.startsWith(name.toLowerCase())
        ? [{ invite: name, detail: "not in this chat · invite by link" }]
        : [];
    return [...(callsAgent ? [AGENT_CHOICE] : []), ...matched, ...invite];
  }, [all, others, query?.query, shared, outside?.canInvite]);
  // An "@" in running text ("@ the team") matches nothing once a space follows: then it was not a mention.
  const open = query !== null && !(options && choices.length === 0 && /\s/.test(query.query));

  /** Put `token` in place of draft[start, end), with the caret after it. */
  const replace = (start: number, end: number, token: string) => {
    const at = start + token.length;
    setDraft(draft.slice(0, start) + token + draft.slice(end));
    setCaret(at);
    setActive(0);
    requestAnimationFrame(() => {
      input.current?.focus();
      input.current?.setSelectionRange(at, at);
    });
  };

  const pick = (choice: Choice) => {
    if (!query) return;
    // The agent is called by the text itself: nothing to send with the message.
    if ("agent" in choice) return replace(query.start, caret, `${AGENT_TOKEN} `);
    // Nobody to send either: the card offers an invite link.
    if ("invite" in choice) {
      setOutsider({ name: choice.invite, invite: true });
      return replace(query.start, caret, `@${choice.invite} `);
    }
    const { mention } = choice;
    if (mention.kind === "person" && outsiders.some((person) => person.uid === mention.uid)) setOutsider({ uid: mention.uid, name: mention.name });
    replace(query.start, caret, `${mentionToken(choice.mention)} `);
    // Its text now follows the "@", so the list closes for it (see `done`).
    setPicked((current) => (current.some((m) => sameMention(m, choice.mention)) ? current : [...current, choice.mention]));
  };

  /** Keys the list takes while it is open; true when it took this one. */
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): boolean => {
    if (!open || event.nativeEvent.isComposing) return false;
    if (event.key === "Escape") {
      setDismissedAt(query!.start);
    } else if (choices.length === 0) {
      return false;
    } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      const step = event.key === "ArrowDown" ? 1 : -1;
      setActive((i) => (i + step + choices.length) % choices.length);
    } else if ((event.key === "Enter" && !event.shiftKey) || event.key === "Tab") {
      pick(choices[Math.min(active, choices.length - 1)]);
    } else {
      return false;
    }
    event.preventDefault();
    return true;
  };

  /** Follow the caret: the list is about the "@" just before it. */
  const track = () => {
    setCaret(input.current?.selectionStart ?? draft.length);
    setActive(0);
  };

  /** Put an "@" at the caret, with a space before it when it would touch a word, and open the list. */
  const insertAt = () => {
    const at = input.current?.selectionStart ?? draft.length;
    replace(at, at, at > 0 && !/\s/.test(draft[at - 1]) ? " @" : "@");
    setDismissedAt(null);
  };

  /** The picks still named in `text`, to send with it; the list starts empty for the next message. */
  const take = (text: string): MentionInput[] => keptMentions(text, picked);
  const clear = () => setPicked([]);
  /**
   * A message brought back to send again (`text`, with the caret at its end): what it named counts as picked again, so
   * it goes with the text as before, and an "@" at its end that named nothing does not open the list.
   */
  const restore = (text: string, mentions: readonly Mention[] = []) => {
    setPicked((current) => [...current, ...mentions.filter((mention) => !current.some((m) => sameMention(m, mention)))]);
    setDismissedAt(activeQuery(text, text.length)?.start ?? null);
    // Where the caret lands, so the list is not about the old draft's caret for a render (which could let go of the dismissal).
    setCaret(text.length);
  };

  // The agent and the people are there before the files and artifacts have loaded.
  return {
    open,
    loaded: options !== null || choices.length > 0,
    choices,
    active,
    setActive,
    pick,
    onKeyDown,
    track,
    insertAt,
    take,
    clear,
    restore,
    outsider,
    dismissOutsider: () => setOutsider(null),
  };
}

export function MentionList({ mentions }: { mentions: ReturnType<typeof useMentions> }) {
  const { open, loaded, choices, active, setActive, pick } = mentions;
  const people = useSharedChat();
  if (!open) return null;
  return (
    <div className="mention-list" role="listbox" aria-label={people ? "People, files and artifacts" : "Files and artifacts"}>
      {!loaded ? (
        <div className="mention-empty">Loading…</div>
      ) : choices.length === 0 ? (
        <div className="mention-empty">
          {people ? "No one, and no file or artifact, matches." : "No file or artifact matches."} Upload files from the sidebar.
        </div>
      ) : (
        choices.map((choice, i) => (
          <Fragment key={choiceKey(choice)}>
            {(i === 0 || choiceGroup(choices[i - 1]) !== choiceGroup(choice)) && (
              <div className="mention-group" role="presentation">
                {choiceGroup(choice)}
              </div>
            )}
            <button
              type="button"
              role="option"
              aria-selected={i === active}
              className={i === active ? "mention-choice active" : "mention-choice"}
              // Before the input loses focus, so the caret is still where the "@" is.
              onMouseDown={(e) => {
                e.preventDefault();
                pick(choice);
              }}
              onMouseEnter={() => setActive(i)}
            >
              {"agent" in choice ? (
                <AgentAvatar />
              ) : "invite" in choice ? (
                <Avatar name={choice.invite} tint={0} />
              ) : choice.mention.kind === "person" ? (
                <Avatar name={choice.mention.name} tint={people ? tintOf(people, choice.mention.uid) : 0} />
              ) : (
                <span className="mention-icon">{choice.mention.kind === "file" ? "▤" : "▦"}</span>
              )}
              <span className="mention-label">{"agent" in choice ? AGENT_NAME : "invite" in choice ? choice.invite : mentionLabel(choice.mention)}</span>
              <small>{choice.detail}</small>
            </button>
          </Fragment>
        ))
      )}
    </div>
  );
}

/** The heading a choice is listed under: the agent, people, then files and artifacts. */
function choiceGroup(choice: Choice): string {
  if ("agent" in choice) return "Agent";
  if ("invite" in choice) return "People";
  return { person: "People", file: "Files", artifact: "Artifacts" }[choice.mention.kind];
}

function choiceKey(choice: Choice): string {
  if ("agent" in choice) return "agent";
  if ("invite" in choice) return `i:${choice.invite}`;
  const { mention } = choice;
  if (mention.kind === "person") return `p:${mention.uid}`;
  return mention.kind === "file" ? `f:${mention.own ? "own:" : ""}${mention.path}` : `a:${mention.id}`;
}

/**
 * A message's text with its mentions as chips: a file by its name (path on hover), an artifact as a link to its page,
 * a person in their colour (stronger where it is the viewer, `me`), and the agent where it was called.
 */
export function MentionText({ text, mentions, me }: { text: string; mentions?: Mention[]; me?: string }) {
  const people = useSharedChat();
  if (!text.includes("@")) return <>{text}</>;
  return (
    <>
      {splitMentions(text, mentions ?? []).map((part, i) =>
        typeof part === "string" ? (
          <AgentRun key={i} text={part} />
        ) : part.kind === "person" ? (
          <span
            key={i}
            className={part.uid === me ? "mention-chip person me" : "mention-chip person"}
            style={people ? tintStyle(tintOf(people, part.uid)) : undefined}
            title={part.uid === me ? "Mentions you" : `Mentions ${part.name}`}
          >
            @{part.name}
          </span>
        ) : part.kind === "artifact" ? (
          <a key={i} className="mention-chip" href={`/a/${part.id}`} target="_blank" rel="noreferrer" title={`Artifact "${part.title}": open its page`}>
            @{part.title}
          </a>
        ) : (
          <span key={i} className="mention-chip" title={part.path}>
            @{baseName(part.path)}
          </span>
        ),
      )}
    </>
  );
}

/** Plain text, with the agent as a chip where it is called. */
function AgentRun({ text }: { text: string }) {
  return (
    <>
      {splitAgent(text).map((part, i) =>
        part.call ? (
          <span key={i} className="mention-chip agent" title={`Asks ${AGENT_NAME} to answer`}>
            {part.text}
          </span>
        ) : (
          part.text
        ),
      )}
    </>
  );
}
