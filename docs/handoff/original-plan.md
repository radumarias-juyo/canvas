# Agents: implementation plan (branch `feat/agents`)

Sources, all in scope (Radu, 2026-11-06 21:46, "implement all"):

- Multi-agent group chats: https://claude.ai/artifact/CLg5SddVwXQhm4HrwDWnTd (plain text copy: `/mnt/project-files/agents-impl/specs/multi-agent-proposal.txt`)
- Agents that run on their own: https://claude.ai/artifact/ApCSg8CU7ydx5rMMfPaLae (`specs/routines-proposal.txt`)
- MCP sign-in for scheduled agents: https://claude.ai/artifact/1P8U1DJjSV8cS6F3FBC4yo (`specs/mcp-background-signin.md`)
- Tech spec: https://claude.ai/artifact/DJqwPPri6VeECn5z9VTr9p (`specs/tech-spec.md`)

## Rules for every task

- Branch off `feat/agents`, open the PR **into `feat/agents`** (never `main`). The lead thread squash-merges it.
- Before the PR: format the code (match the surrounding style: 2 spaces, double quotes, semicolons, lines up to ~150 chars),
  `pnpm typecheck`, `pnpm test`, then run the `/complete-review-and-fix` skill on the change and fix what it finds.
- Tests for the new code in `test/`, in the repo's style (real code against the fakes in `test/fakes.ts`).
- UI changes: screenshots (light and dark, desktop and phone width) in `docs/media/<feature>/` (Git LFS), linked in the PR
  as `https://github.com/radumarias/pi-artifacts/raw/<commit>/docs/media/...`.
- Keep the app generic: no deployment's server names or business domain in code or docs, no Claude terminology in the app.
- Never deploy to production or `pi.oxfer.app`. A preview deploy, if needed, uses a separate Worker name.
- Rebase on `feat/agents` before asking for the merge; other tasks merge meanwhile.
- Security model stays: identity only from the verified Access token; only the owner's messages are instructions; turns
  nobody (or nobody but the owner) asked for are read-only unless the autonomy and guardrail rules allow a write; members
  see only the chat's files and artifacts; only `worker/storage/` touches R2 and the repos.

## What phase 1 built (merged as PR #104, squash aa514fc)

- `shared/agents.ts`: definition types (name, avatar, color, job, instructions, model, effort, servers, sharedServers,
  trigger, scope, workflow steps, autonomy 1-4, assumed, copiedFrom, a per-agent `version` for edit conflicts),
  `checkAgent`, `speakerLabel`, `AGENT_EFFORTS`, `AGENT_ID_PATTERN`, the chat entry kinds `chat.agent` (an agent's
  reply) and `chat.turn` (a turn's input, data `ChatTurnData {turn, calledBy, hop, root?}`), views. `@name` matching
  (`callPattern`, `calledNames`, `summonsAgent`) lives in `shared/mentions.ts`.
- `worker/agents/store.ts`: `AgentStore`, the `agents` table in each user's `UserDirectory`; routes `/api/agents` in
  `worker/agents-routes.ts`. Model-made proposals (`agent_propose`, `worker/agents/tools.ts`) are saved off.
- `worker/agents/roster.ts`: a chat's roster (`chat_agents`) and durable turn queue (`chat_agent_turns`). A turn ends
  with its reply kept in its row (an outbox: `reply`, `to_pi`) and the hand-offs it queues, in one synchronous write;
  the reply is then posted (`#deliver`), and `resume()` posts undelivered ones after a restart.
- `worker/agents/turns.ts`, `controller.ts`: each roster agent is its own pi session in the chat object, configured per
  turn (`#configureAgent`). Before each turn its session gets one passive write with what was said since its last turn
  (`CatchUp`, newest first, `MIRROR_TOTAL_CHARS` budget); the turn's input names who asked; its final text is posted as
  a `chat.agent` entry; `@name` in a reply hands off (MAX_HOPS 3 per chain, a hand-off to pi counted on the handing
  turn). pi's own answers are scanned from its log by a cursor (`#piScan`, `PI_SCAN_KEY`) for the agents they name.
- Tools: the session's tools are an allow-list (`allowedTools`); the harness offers and runs no tool off it. A turn its
  owner did not ask for gets only read-only MCP tools of the servers shared with the chat plus `READ_TOOLS`, no
  skill/agent_propose/code/private files/sign-in links. Known open item (T6 brief item 7): a hand-off to pi runs with
  the owner's full tools.
- Stop ends agents' turns too; a member who leaves stops the chains rooted at their messages (`turns.leave`).
- Chat routes `/api/chats/:id/agents` (list, add, remove; owner only for changes), the `agents` socket message,
  `AgentReply` rendering with `AgentByline`/`AgentBadge`, the shared `ArtifactCard`.
- Gaps: chat export/import does not carry the roster (asked of T2); the chat's traces open sessions one by one.

## Architecture decisions for the rest

1. **An agent's own conversation** is an ordinary chat of its owner (a `ChatAgent` object, `uid:<chatId>`), marked in
   the owner's `UserDirectory.chats` row with the agent's id. It is listed in the sidebar like a contact (badge, last
   post, unread). The agent is on its roster and is the chat's default speaker there. It is made when the agent is turned
   on.
2. **Runs execute in that home chat object.** `Scheduler` from `agents/schedules` is installed in the chat object's
   `Lifecycle` (it shares the alarm with pi). Local times are one-shot schedules recomputed after each run with `Intl`
   for the definition's time zone (DST-safe). Watches use `scheduler.every`. A run is one fresh pi session per scope item
   (`harness.sessions.create()`), recorded in an `agent_runs` table with the unique key `(agent, due_at, item)` so a
   duplicate alarm sends once; operation ids `run:<agentId>:<dueAt>:<item>`. Steps run in code (look = `McpHub.read`,
   onlyIf/if = a small safe expression language over earlier results), only `work` calls the model. Replies to a run's
   post continue it in `sessions.fork(runSession)`.
3. **Delivery**: the home conversation (a `chat.agent` entry with `run`), a shared chat where the agent is on the roster
   and its owner is in the chat (RPC into that chat object), a notification (sidebar notice + browser notification
   through the `Tag` path, and Web Push), a page version (artifact_write edits / snapshot, check, publish: the existing
   rules), an outside tool (an MCP write through the hub's gate).
4. **Write gate in the hub**: every MCP call that is not read-only goes through one policy check given the call's
   context (agent, autonomy level, who asked, run or chat). Level 1 refuses, 2 returns a proposal card with the exact
   call, 3 stores a pending action (expires by a scheduler one-shot), 4 runs it if the guardrails pass. Guardrails are
   rules on the tool's input schema (min, max, max change, never, quiet dates, calls per day; block / approve / warn,
   strictest wins). An approved action runs exactly as stored.
5. **Member agents**: the room stays the owner's chat object (no separate Room class: the log and the turn controller
   are already there). A member's agent is a *seat*: a session in the member's own agent home object, reached by RPC
   (deliver entries with gap repair by seq, give a turn, post the reply back). Tokens never cross namespaces.
6. **Uneven access**: an owner's turn that may reach a server outside the agent's shared list runs in a fork of the
   agent's chat session; only the posted reply returns (as a write), with a source chip built from the servers the hub
   recorded for that turn, and an optional "review before posting" draft only the owner sees.
7. **Memory notes**, **follows**, **feed** ("Needs you" included) live in `UserDirectory` tables. Off-the-record chats are
   refused by those stores in code.
8. **Notifications**: Web Push with VAPID keys from secrets (`PUSH_VAPID_PUBLIC_KEY`, `PUSH_VAPID_PRIVATE_KEY`), a
   service worker, `push_subs` in `UserDirectory`; the push says only that something arrived.
9. **Metrics**: an optional Analytics Engine binding `METRICS` (no-op when absent): cache hits/evictions per agent,
   run outcomes, router picks, CPU per turn. Cache shares per agent in the hub's cache.

Deviation to flag in the final PR: no separate Room object class (decision 5).

## Tasks

| # | Task | Depends on | Main files |
| --- | --- | --- | --- |
| T1 | Group chat UI and rules for agents | phase 1 | `src/chat/*`, `worker/chat-agent.ts` (sockets), `shared/protocol.ts` |
| T2 | Agent editor, draft card, shared agents and copies | phase 1 | `src/agents/*` (new), `src/App.tsx`, `worker/agents/*`, `worker/users.ts` |
| T3 | Background MCP sign-in + Web Push | phase 1 | `worker/mcp/*`, `worker/users.ts`, `src/` service worker, account menu |
| T4 | Scheduled runs: home conversation, scheduler, run executor, runs UI, Test it | phase 1 (uses T3's sign-in check) | `worker/agents/runs/*` (new), `worker/chat-agent.ts`, `src/agents/runs/*` |
| T5 | Chat kinds and around the chat | phase 1 | `worker/chat-agent.ts`, `worker/members.ts`, `worker/users.ts`, `src/` sidebar and header |
| T6 | Autonomy, guardrails, approvals, Tell via outside tools | T4 | `worker/mcp/hub.ts` gate, `worker/agents/limits/*`, `src/agents/limits/*` |
| T7 | Memory notes | phase 1 | `worker/memory/*` (new), `worker/users.ts`, `src/memory/*` |
| T8 | Member agents and uneven access | T1 | `worker/chat-agent.ts`, `worker/agents/seats/*` (new) |
| T9 | Follows and the feed | T4, T5 | `worker/users.ts`, `src/feed/*` |
| T10 | Agents that speak up, small touches, metrics | T1, T4 | router, funnel, cache shares, metrics, app-help skill |

Each task's brief: `/mnt/project-files/agents-impl/briefs/T<n>.md`. Status of each task is kept in
`/mnt/project-files/agents-impl/status.md` by the lead thread.
