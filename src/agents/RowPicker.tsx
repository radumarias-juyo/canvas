import { useEffect, useId, useState } from "react";
import { MIN_WATCH_MINUTES, MAX_WATCH_MINUTES, WEEKDAYS, type AgentDefinition, type AgentStep, type Weekday } from "../../shared/agents.ts";
import { isReadOnly, type ToolInfo } from "../../shared/protocol.ts";
import { errorMessage } from "../../shared/util.ts";
import { api } from "../api.ts";
import { lockedServers, type RowEdit, type RowKey, type TellVia } from "./draft-edit.ts";
import { DAY_NAMES } from "./glance.ts";

/** What a draft card's pickers offer, from what the app knows: the deployment's servers, the user's skills, the chat. */
export interface PickerKnown {
  servers: readonly string[];
  skills: readonly string[];
  /** The people in the chat, by name: recipients an outside tool may take. */
  people: readonly string[];
  /** The chat the card is in, when it is the user's own: a report can go there. */
  chat?: { id: string };
}

/** Every step of a workflow, those inside an if's branches too. */
const allSteps = (steps: readonly AgentStep[] | undefined): AgentStep[] =>
  (steps ?? []).flatMap((step) => (step.kind === "if" ? [step, ...allSteps(step.then), ...allSteps(step.else)] : [step]));

/** A server's tools, read once per picker; [] when they cannot be read (signed out, down). */
function useTools(server: string | undefined): { tools: ToolInfo[] | null; error?: string } {
  const [state, setState] = useState<{ server?: string; tools: ToolInfo[] | null; error?: string }>({ tools: null });
  useEffect(() => {
    if (!server) return;
    let gone = false;
    setState({ server, tools: null });
    api.serverTools(server).then(
      (tools) => !gone && setState({ server, tools }),
      (e: unknown) => !gone && setState({ server, tools: [], error: errorMessage(e) }),
    );
    return () => {
      gone = true;
    };
  }, [server]);
  return state.server === server ? state : { tools: null };
}

const DAY_SETS: { label: string; days?: Weekday[] }[] = [
  { label: "Every day" },
  { label: "Weekdays", days: ["mon", "tue", "wed", "thu", "fri"] },
  { label: "Weekends", days: ["sat", "sun"] },
];

const localZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";

/**
 * The picker a row's Change opens in place, built from what the agent and the app know. It answers with the row's
 * edit (applyRowEdit saves it), or nothing on Cancel.
 */
export function RowPicker({
  agent,
  row,
  known,
  busy,
  onSave,
  onCancel,
}: {
  agent: AgentDefinition;
  row: RowKey;
  known: PickerKnown;
  busy: boolean;
  onSave: (edit: RowEdit) => void;
  onCancel: () => void;
}) {
  const id = useId();
  const [edit, setEdit] = useState<RowEdit | null>(null);
  const body =
    row === "runs" ? (
      <RunsPicker agent={agent} onChange={setEdit} />
    ) : row === "reads" ? (
      <ReadsPicker agent={agent} known={known} onChange={setEdit} />
    ) : row === "tells" ? (
      <TellsPicker agent={agent} known={known} onChange={setEdit} />
    ) : row === "knows" ? (
      <KnowsPicker agent={agent} known={known} onChange={setEdit} />
    ) : (
      <ScopePicker agent={agent} known={known} onChange={setEdit} />
    );
  return (
    <form
      className="row-picker"
      aria-labelledby={`${id}-title`}
      onSubmit={(event) => {
        event.preventDefault();
        if (edit && !busy) onSave(edit);
      }}
      onKeyDown={(event) => {
        if (event.key === "Escape") onCancel();
      }}
    >
      <span id={`${id}-title`} className="sr-only">
        Change what it {row === "runs" ? "runs on" : row}
      </span>
      {body}
      <div className="row-picker-actions">
        <button type="submit" className="primary" disabled={busy || !edit}>
          {busy ? "Saving…" : "Save"}
        </button>
        <button type="button" onClick={onCancel} disabled={busy}>
          Cancel
        </button>
      </div>
    </form>
  );
}

function RunsPicker({ agent, onChange }: { agent: AgentDefinition; onChange: (edit: RowEdit | null) => void }) {
  const trigger = agent.trigger;
  const [mode, setMode] = useState<"schedule" | "called" | "watch">(trigger?.kind ?? "called");
  const [at, setAt] = useState(trigger?.kind === "schedule" ? trigger.at : "08:00");
  const [days, setDays] = useState<Weekday[] | undefined>(trigger?.kind === "schedule" ? trigger.days : undefined);
  const [every, setEvery] = useState(String(trigger?.kind === "watch" ? trigger.everyMinutes : 60));
  const tz = trigger?.kind === "schedule" ? trigger.tz : localZone();
  useEffect(() => {
    if (mode === "called") onChange({ key: "runs", trigger: null });
    else if (mode === "schedule") {
      const ok = /^\d{2}:\d{2}$/.test(at) && days?.length !== 0;
      onChange(ok ? { key: "runs", trigger: { kind: "schedule", at, tz, ...(days && { days }) } } : null);
    }
    else if (trigger?.kind === "watch") {
      const minutes = Number(every);
      const ok = Number.isInteger(minutes) && minutes >= MIN_WATCH_MINUTES && minutes <= MAX_WATCH_MINUTES;
      onChange(ok ? { key: "runs", trigger: { ...trigger, everyMinutes: minutes } } : null);
    }
  }, [mode, at, days, every, tz, trigger, onChange]);
  const preset = DAY_SETS.find((set) => (set.days ?? []).join() === (days ?? []).join());
  return (
    <div className="row-picker-fields">
      <div className="row-picker-choices" role="radiogroup" aria-label="When it runs">
        <label>
          <input type="radio" checked={mode === "schedule"} onChange={() => setMode("schedule")} /> On a schedule
        </label>
        {trigger?.kind === "watch" && (
          <label>
            <input type="radio" checked={mode === "watch"} onChange={() => setMode("watch")} /> When {trigger.step.server} changes
          </label>
        )}
        <label>
          <input type="radio" checked={mode === "called"} onChange={() => setMode("called")} /> Only when someone calls it
        </label>
      </div>
      {mode === "schedule" && (
        <>
          <div className="row-picker-line">
            <label>
              At <input type="time" value={at} onChange={(e) => setAt(e.target.value)} required />
            </label>
            <small>{tz}</small>
          </div>
          <div className="row-picker-chips" role="group" aria-label="Days">
            {DAY_SETS.map((set) => (
              <button key={set.label} type="button" aria-pressed={preset === set} onClick={() => setDays(set.days)}>
                {set.label}
              </button>
            ))}
          </div>
          <div className="row-picker-chips" role="group" aria-label="Or pick days">
            {WEEKDAYS.map((day) => {
              const on = !days || days.includes(day);
              return (
                <button
                  key={day}
                  type="button"
                  aria-pressed={on}
                  onClick={() => {
                    const now = days ?? [...WEEKDAYS];
                    const next = on ? now.filter((one) => one !== day) : WEEKDAYS.filter((one) => one === day || now.includes(one));
                    setDays(next.length === 7 ? undefined : next);
                  }}
                >
                  {DAY_NAMES[day]}
                </button>
              );
            })}
          </div>
          {days?.length === 0 && <small className="form-error">Pick at least one day.</small>}
        </>
      )}
      {mode === "watch" && (
        <label className="row-picker-line">
          Checks every <input inputMode="numeric" value={every} onChange={(e) => setEvery(e.target.value)} aria-describedby="watch-range" /> minutes
          <small id="watch-range">
            {MIN_WATCH_MINUTES} to {MAX_WATCH_MINUTES}
          </small>
        </label>
      )}
    </div>
  );
}

function ReadsPicker({ agent, known, onChange }: { agent: AgentDefinition; known: PickerKnown; onChange: (edit: RowEdit | null) => void }) {
  const locked = lockedServers(agent);
  const [chosen, setChosen] = useState<Set<string> | null>(agent.servers ? new Set(agent.servers) : null);
  const all = [...new Set([...known.servers, ...(agent.servers ?? []), ...locked])];
  const names = all.join("\n");
  useEffect(
    () => onChange({ key: "reads", servers: chosen ? names.split("\n").filter((server) => chosen.has(server)) : null }),
    [chosen, names, onChange],
  );
  return (
    <div className="row-picker-fields">
      <label className="row-picker-check">
        <input type="checkbox" checked={chosen === null} onChange={(e) => setChosen(e.target.checked ? null : new Set(all))} />
        Any of your servers
      </label>
      {chosen && (
        <div className="row-picker-list">
          {all.map((server) => (
            <label
              key={server}
              className="row-picker-check"
              title={locked.includes(server) ? "A step reads it: change that step's sentence to drop it." : undefined}
            >
              <input
                type="checkbox"
                checked={chosen.has(server)}
                disabled={locked.includes(server)}
                onChange={(e) => {
                  const next = new Set(chosen);
                  if (e.target.checked) next.add(server);
                  else next.delete(server);
                  setChosen(next);
                }}
              />
              {server}
              {locked.includes(server) && <small>a step reads it</small>}
            </label>
          ))}
        </div>
      )}
    </div>
  );
}

/** Where a report can go, as the Tells picker offers it. */
type Channel = "own" | "here" | "notify" | "tool";

function TellsPicker({ agent, known, onChange }: { agent: AgentDefinition; known: PickerKnown; onChange: (edit: RowEdit | null) => void }) {
  const tell = allSteps(agent.workflow).find((step): step is Extract<AgentStep, { kind: "tell" }> => step.kind === "tell");
  const startVia = tell?.via;
  const [channel, setChannel] = useState<Channel>(
    typeof startVia === "object" ? "tool" : startVia === "notify" ? "notify" : known.chat && tell?.to.includes(known.chat.id) ? "here" : "own",
  );
  const servers = agent.servers ?? known.servers;
  const [server, setServer] = useState(typeof startVia === "object" ? startVia.server : servers[0]);
  const [tool, setTool] = useState(typeof startVia === "object" ? startVia.tool : "");
  const [to, setTo] = useState(typeof startVia === "object" ? (tell?.to.join(", ") ?? "") : "");
  const { tools, error } = useTools(channel === "tool" ? server : undefined);
  const writes = (tools ?? []).filter((one) => !isReadOnly(one));
  useEffect(() => {
    const recipients = to
      .split(/[,;\n]/)
      .map((one) => one.trim())
      .filter(Boolean);
    const via: TellVia | null = channel === "tool" ? (server && tool ? { server, tool } : null) : channel === "notify" ? "notify" : "chat";
    if (!via) return onChange(null);
    if (channel === "tool") return onChange(recipients.length ? { key: "tells", to: recipients, via } : null);
    onChange({ key: "tells", to: [channel === "here" && known.chat ? known.chat.id : "owner"], via });
  }, [channel, server, tool, to, known.chat, onChange]);
  return (
    <div className="row-picker-fields">
      <div className="row-picker-choices" role="radiogroup" aria-label="Where its report goes">
        <label>
          <input type="radio" checked={channel === "own"} onChange={() => setChannel("own")} /> Its own chat with you
        </label>
        {known.chat && (
          <label>
            <input type="radio" checked={channel === "here"} onChange={() => setChannel("here")} /> This chat
          </label>
        )}
        <label>
          <input type="radio" checked={channel === "notify"} onChange={() => setChannel("notify")} /> A notification to you
        </label>
        <label>
          <input type="radio" checked={channel === "tool"} onChange={() => setChannel("tool")} /> Through one of its servers
        </label>
      </div>
      {channel === "tool" && (
        <>
          <div className="row-picker-line">
            <label>
              Server{" "}
              <select value={server} onChange={(e) => (setServer(e.target.value), setTool(""))}>
                {servers.map((name) => (
                  <option key={name}>{name}</option>
                ))}
              </select>
            </label>
            <label>
              Tool{" "}
              <select value={tool} onChange={(e) => setTool(e.target.value)} disabled={!tools}>
                <option value="">{tools ? (writes.length ? "Pick one" : "None that sends") : "Reading its tools…"}</option>
                {writes.map((one) => (
                  <option key={one.name}>{one.name}</option>
                ))}
              </select>
            </label>
          </div>
          {error && <small className="form-error">{error}</small>}
          <label className="row-picker-line wide">
            To
            <input value={to} onChange={(e) => setTo(e.target.value)} placeholder="Addresses or names, comma between" />
          </label>
          {known.people.length > 0 && (
            <div className="row-picker-chips" role="group" aria-label="People in this chat">
              {known.people.map((person) => (
                <button key={person} type="button" onClick={() => setTo((now) => (now.trim() ? `${now.replace(/[,\s]+$/, "")}, ${person}` : person))}>
                  + {person}
                </button>
              ))}
            </div>
          )}
          <small>It sends through the tool as you, within its limits: at Inform, a card asks you first.</small>
        </>
      )}
    </div>
  );
}

function KnowsPicker({ agent, known, onChange }: { agent: AgentDefinition; known: PickerKnown; onChange: (edit: RowEdit | null) => void }) {
  const work = allSteps(agent.workflow).find((step): step is Extract<AgentStep, { kind: "work" }> => step.kind === "work");
  const [skill, setSkill] = useState<string | null>(work?.skill ?? null);
  useEffect(() => onChange(work ? { key: "knows", skill } : null), [skill, work, onChange]);
  if (!work) return <p className="row-picker-empty">Its steps do no work a skill would help with: say in a step what it should work out.</p>;
  const skills = [...new Set([...known.skills, ...(work.skill ? [work.skill] : [])])];
  return (
    <div className="row-picker-fields">
      <div className="row-picker-choices" role="radiogroup" aria-label="The skill it works with">
        <label>
          <input type="radio" checked={skill === null} onChange={() => setSkill(null)} /> No skill in particular
        </label>
        {skills.map((name) => (
          <label key={name}>
            <input type="radio" checked={skill === name} onChange={() => setSkill(name)} /> {name}
          </label>
        ))}
      </div>
    </div>
  );
}

function ScopePicker({ agent, known, onChange }: { agent: AgentDefinition; known: PickerKnown; onChange: (edit: RowEdit | null) => void }) {
  const list = agent.scope?.list;
  const servers = agent.servers ?? known.servers;
  const [each, setEach] = useState(!!list);
  const [server, setServer] = useState(list?.server ?? servers[0]);
  const [tool, setTool] = useState(list?.tool ?? "");
  const { tools, error } = useTools(each ? server : undefined);
  const reads = (tools ?? []).filter(isReadOnly);
  useEffect(
    () => onChange(!each ? { key: "scope", list: null } : server && tool ? { key: "scope", list: { server, tool } } : null),
    [each, server, tool, onChange],
  );
  return (
    <div className="row-picker-fields">
      <div className="row-picker-choices" role="radiogroup" aria-label="What one run covers">
        <label>
          <input type="radio" checked={!each} onChange={() => setEach(false)} /> One run covers everything
        </label>
        <label>
          <input type="radio" checked={each} onChange={() => setEach(true)} /> One run per item of a list
        </label>
      </div>
      {each && (
        <div className="row-picker-line">
          <label>
            Server{" "}
            <select value={server} onChange={(e) => (setServer(e.target.value), setTool(""))}>
              {servers.map((name) => (
                <option key={name}>{name}</option>
              ))}
            </select>
          </label>
          <label>
            List{" "}
            <select value={tool} onChange={(e) => setTool(e.target.value)} disabled={!tools}>
              <option value="">{tools ? (reads.length ? "Pick one" : "None that reads") : "Reading its tools…"}</option>
              {reads.map((one) => (
                <option key={one.name}>{one.name}</option>
              ))}
            </select>
          </label>
        </div>
      )}
      {error && <small className="form-error">{error}</small>}
    </div>
  );
}
