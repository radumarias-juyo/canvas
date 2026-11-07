# Agents on Cloudflare: tech spec (summary of https://claude.ai/artifact/DJqwPPri6VeECn5z9VTr9p)

Scope: agent definitions, several agents and people in one chat, scheduled and triggered runs, run records, delivery
into conversations and pages, autonomy levels, guardrails and approvals, shared copies, memory notes. Out of scope for
now: outside chat-app adapters, public sign-up, billing. One new Cloudflare piece: an Analytics Engine dataset for
metrics. Workflows (the product) not used: pi durable + Lifecycle already survive crashes. KV not used.

## Objects (spec's shape; see plan.md for how this repo maps it)

| Object | Name | Tables |
| --- | --- | --- |
| UserDirectory | uid | `agents(id, name, definition, status, version, updated_at)`, `memory(id, scope, agent_id, chat_id, text, source, uses, pinned, forgotten_at)`, `conversations(id, kind, title, preview, last_at, unread)`, `push_subs` |
| Agent | uid:agentId | `contexts(context, session_id)` (chat:<id>, run:<id>, fork:<id>), `runs(id, due_at, item, status, session_id, cost, summary)`, `pending_actions(id, call, input, run_id, expires_at, state)`, `cache_shares` |
| Chat (Room later) | uid:chatId | `log(seq, author_kind, author_id, text, card, reply_to, at)`, `roster(agent_id, owner_uid, name, delivered_seq)`, `turns(human_seq, hops, tokens)` |
| Source | hash(server, tool, input) | `subscribers(owner_uid, agent_id, watch_id)`, `last(hash, at)` |

## Runs

```ts
readonly scheduler = new Scheduler({ callbacks: {
  run: (p: { agentId: string; dueAt: number }) => this.startRun(p),
  watch: (p: { watchId: string }) => this.checkWatch(p),
  expire: (p: { actionId: string }) => this.expireAction(p),
}});
readonly lifecycle = Lifecycle.install(this).use(this.harness).use(this.sockets).use(this.scheduler);
```
(`Scheduler` is exported by `agents/schedules` in agents@0.31.0: `set(when, callback, payload)`, `every(seconds, ...)`,
`get`, `list`, `cancel`.)

1. Schedule: on Turn on and after each run, compute the next local time with `Intl` for the definition's time zone and
   `scheduler.set(dueAt, "run", …)`. Cron is UTC only, so local times are one-shots (07:00 stays 07:00 across DST).
   Watches use `scheduler.every(seconds, "watch", …)`.
2. Start: insert `runs(id, due_at, status: "running")` under the unique key `(agent, due_at, item)`; an alarm that fires
   twice finds the row and stops.
3. Scope: list the items once, then run per item with a concurrency cap (e.g. 4), each in its own fresh session.
4. Steps: Look at = `McpHub.read()` in code, the result lands in the session as a passive write. Only if / If evaluate a
   small expression over earlier results in code. Work out submits the step's prompt (with its skill): the only model
   call. Do, Tell, Page go through delivery and limits.
5. Record: each step appends to the run record with its cost; status ends `sent`, `not_today` or `failed` (plus
   `needs_sign_in`, see the MCP doc). The runs list reads `runs`; the run detail reads the session's entries (the step
   panels already show them).
6. Reply to a run: a reply to a post from a run forks that run's session (`sessions.fork()`), so the answer starts with
   that morning's numbers in context.

Test it: the same executor in a fork with Do and Tell replaced by recorders; shown as a run marked "test". Watches shared
by many people go through a Source object keyed by the hub's `callIdentity`: it polls once, compares a hash, and tells
subscribers only when the hash moves.

## Delivery

| Target | How | Autonomy |
| --- | --- | --- |
| Agent's own conversation | post on the agent's own chat; directory updates the sidebar row | 1 |
| Shared chat | post on a chat where the agent is on the roster; the post carries the run id so replies fork the run | 1, only chats its owner belongs to |
| Notification | sidebar socket notice, and Web Push (VAPID keys as secrets like FILES_MASTER_KEY); the push says only that something arrived | 1 |
| Page version | artifact_write with edits (the findings block) or a snapshot, then check and publish; a page that fails the check is not published and the run says so | 1 |
| Outside tool (email, chat app) | an MCP server's send tool through the hub, as the owner | 4, or 3 with approval |

## Limits and safety

- Autonomy: the hub reads the level before any call whose tool lacks `readOnlyHint`. 1 refuses; 2 returns a proposal
  card with the exact call; 3 stores a pending action; 4 runs it after the guardrails pass. A turn started by another
  agent, a watch, or a reply from someone other than the owner is capped at the shared-chat server list and read-only.
- Guardrails: rows `{server, tool, arg, kind, value, effect}`, kind = min | max | maxChange | never | quietDates |
  callsPerDay, effect = block | approve | warn; checked against the tool's input schema before the call leaves the
  object; the strictest rule wins; the settings UI is generated from the input schemas (domain-free).
- Approval queue: `pending_actions` stores the exact call. The approver's inbox shows Approve / Decline; on Approve the
  object runs the stored call itself, so the model can't change it. Expiry is a Scheduler one-shot per action. The run
  gets the result as an `app.approval` input.
- Uneven access: an owner's turn that reaches a server off the shared-chat list runs in `sessions.fork()` of the chat's
  session; only the posted reply returns, with a source chip from the servers the hub recorded for that turn.
- Writes can't be handed over: passive writes never start a run; every input no person typed carries an `app.*` entry
  kind so permission checks can tell them apart.
- Identity: objects named from the verified uid; membership checked on every socket and post.

## Scaling, cost, observability

Cache shares per agent first, then one object per agent. Large tool results to an R2 file + short summary. Each agent
its own alarm (no central queue); conditions skip the model; identical watches share one Source. AI Gateway metadata
tags each request with uid, agent and run; a daily meter per user in UserDirectory stops runs at the cap; chats get a
token budget. Rate Limiting bindings per member per agent and per watch. Metrics to Analytics Engine: cache hit,
eviction, run outcome, router pick, CPU per turn.

## Chat kinds, branches and follows

| Piece | Where | How |
| --- | --- | --- |
| Chat kind | Chat: `kind` (private, group, page, off_record) and `page_id`, copied to each member's sidebar row | checked on every socket and post; narrowing lists who loses access, then removes them in the same request |
| Off the record | the kind travels with every write call | UserDirectory refuses `memory` rows whose chat is off the record; search, routine reads and feed previews skip the chat; in code, not the prompt |
| Chat on a page | owner's UserDirectory `page_chats(artifact_id, chat_id)` | joining runs the same check as opening the artifact; each new version reaches the agent's session as a passive write |
| Add by tagging | Chat | a tag of a non-member answers `not_member` to the poster's socket; the card's Add uses the member add; needs a people directory, so until organisations exist the card offers the invite link |
| Branch off | a new Chat, `branches(from_chat, from_seq, to_chat)` in both | copies the log up to the message, fills the agent session with passive writes (one summary write when long); a line in the original links to the branch |
| Close, mark unread | member's sidebar row: `closed`, `unread` | close hides the row until a Tag for that person arrives (touchChat reopens it) |
| Follows and the feed | UserDirectory `follows(target_kind, target_id)`, `feed(id, kind, ref, at, read)` | page and agent owners keep a follower list; on a new chat, post or version they call `UserDirectory.addFeed()` per follower; the sidebar socket pushes it |
| Live step phrase | agent session entries | each tool call carries a short status phrase, shown beside the step timer |
| Item chips | the hub's record of each turn | chips come from items the hub saw in tool results (server, id, title, link), never from the model's text |

Channels wait for organisations.

## Tests named by the spec

- Runs: a duplicate alarm sends once; a local 07:00 survives a DST change; a false condition makes no model call; a reply
  sees the run's numbers.
- Multi-agent: every speaker has earlier replies without a pull; a write starts no run; a duplicate delivery is placed
  once; the hop cap holds.
- Limits: a Source polls once for two subscribers; a page that fails its check isn't published; a blocked guardrail never
  reaches the server; an approved call runs exactly as stored.
- Members: a non-member is refused everywhere; another member's question can't use a private server; a private result
  never reaches the shared session.

Local dev: `AUTH_MODE=demo PI_OFFLINE=1 pnpm dev`; a `DEV_TOOLS` route fires a run's alarm on demand. New Durable Object
classes are new `exports.durableObject` entries in `cloudflare.config.ts`.
