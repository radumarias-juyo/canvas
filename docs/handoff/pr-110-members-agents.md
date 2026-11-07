# PR #110 · T8 — members bring their own agents (seats, private forks, review before posting)

Handoff written 2026-11-07 ~18:40 UTC. Read [README.md](README.md) first for the project, branch model and rules.

> **UPDATE 2026-11-07 ~19:00 UTC — MERGED.** Radu approved the merges. `wip/pr110-merge-e2e` (489bf77) plus a merge of
> `feat/agents` 60168c6 (#113) with conflict fixes (commit c146fc7, typecheck clean, `pnpm test` 1529 passed / 2 skipped) was pushed
> onto the PR branch (a fast-forward of be0d051) and PR #110 was squash-merged into `feat/agents` as **a8cac57**. The text below
> describes the state before the merge; read "What remains" as open follow-ups. Round 3 (items 28-35) was never verified by the lead and
> `pnpm e2e` flows for members' agents were never written. Merge-conflict decisions: the controller's `Caller` is imported in
> `worker/chat-agent.ts` as `TurnCaller` (the write gate has its own `Caller`); `#configureAgent` takes an optional `alone` flag and a
> seat's turn passes `alone: false`, so the "alone with the owner reads sign-in servers" rule from #113 never applies to a seat
> (its reply goes to a room with other people); the Setup tab saves both `assumed` and `reviewBeforePosting`.

## Goal and acceptance

Goal: a member of a shared chat can add one of their own agents to it. The agent runs as a **seat**: a pi session for that
chat inside the member's own chat object (`<uid>:seat-<agentId>`), never in the owner's object, so the member's sign-ins,
files, skills and budget stay theirs. The room (the owner's chat object) delivers log entries to the seat by RPC with gap
repair by seq, gives turns by RPC, and the seat posts its reply back. Permissions follow the person who asks: the agent's
owner gets all of their servers, anyone else only the owner's shared list, read-only. Uneven access: an owner's turn that
may reach a server outside the shared list runs in a **fork** of the session; only the posted reply returns to the shared
session; a reply built on a private server carries a **source chip**; optional **review before posting** shows the reply
first as a draft only its owner sees (Post to chat / Edit / Discard). Names are unique per chat (`@planner-ana`). A
per-person rate limit on each agent (`AGENT_TURNS`).

Acceptance (brief: [briefs/T8.md](briefs/T8.md)): a non-member is refused everywhere; another member's question cannot use
a private server; a private result never reaches the shared session; a duplicate delivery is placed once; a seat with a gap
pulls the range. Screenshots in `docs/media/member-agents/` (exist on the PR branch, 9 files, Git LFS).
`/complete-review-and-fix` before the PR.

## Git state (verified 2026-11-07 ~18:40 UTC)

| Thing | Value |
| --- | --- |
| PR | #110 "Agents: members bring their own agents (seats, private turns, review before posting)", open, not draft, base `feat/agents` |
| PR branch | `claude/project-thread-bkbjsb`, head **be0d051** (40 commits ahead of feat/agents, 53 files, +4957/-439); feat/agents 17dd6c8 (#114) is merged in, **b2f2422 (#121) is not** |
| **Unpushed work, now saved** | branch **`wip/pr110-merge-e2e`**, head **489bf77** (one commit on be0d051): merges feat/agents b2f2422 (#121); conflicts in `worker/agents/controller.ts`, `shared/agents.ts`, `src/chat/AgentsBar.tsx` resolved by keeping #110's side and adding #121's `drafted` field and agent-page link; `drafted` now flows through `outputsOf` so a seat turn's reply shows its draft card to the member (only when the reply's outputs are the chat's); one new test in `test/member-agents.test.ts`. |
| GitHub review comments / CI | none (no review threads, no check runs) |
| Review history | [reviews/pr110.md](reviews/pr110.md) (items 1-35 in 3 rounds), [pr-110-fixes-log.md](pr-110-fixes-log.md) (how each item was fixed, incl. design gaps left open), checks the lead wrote to verify: [reviews/pr110-checks/](reviews/pr110-checks/) (`*.test.ts.txt`, rename to `.test.ts` and copy into `test/` to run) |

`wip/pr110-merge-e2e` is a fast-forward of the PR branch (be0d051 is its parent). The T8 thread's last status (08:45) was
"merge b2f2422, make seat replies carry `drafted`, run `pnpm test` and `pnpm e2e`, push": merge and `drafted` are done on the
wip branch; `pnpm e2e` was never run by that thread (the handoff thread's e2e result is in the README).

## Latest results (re-run by the handoff thread)

| Ref | `pnpm typecheck` | `pnpm test` | `pnpm e2e` |
| --- | --- | --- | --- |
| be0d051 (PR head) | exit 0 | 1428 passed, 2 skipped | not run on this ref |
| 489bf77 (`wip/pr110-merge-e2e`) | exit 0 | 1436 passed, 2 skipped (matches the T8 thread's report) | 7 passed, 1 failed (flow f, toast), 4 not run; see README.md |

No lint/format tool exists in the repo; match style by hand (see README).

## What is complete (be0d051)

Round 1 (items 1-15, fixed in 39d6c24), round 2 (16, 18-27, e343212) and round 3 (28-35, be0d051) are all *claimed fixed* by
the T8 thread with tests and a full review pass (simplify, code review at high, security review). **The lead had verified
rounds 1 and 2 only; round 3 is UNCHECKED** (the lead hit its usage limit before running the verification).

Design (full list in [pr-110-fixes-log.md](pr-110-fixes-log.md)):

- Seats: `worker/agents/seats/seat.ts` (the seat object side: `agent_seats`, `agent_seat_turns`, `#start`, `#restart`, `abort`),
  `link.ts` (room <-> seat RPC: seatGive/seatAbort/seatWake/seatDrop, seatLog gap pull, seatEnded outbox with retries
  1s/5s/30s), `rules.ts`, `names.ts` (unique names, alias stored as column `alias_of`). Roster column `seat` stores the
  seat's chat id.
- Every turn an owner gives their own agent runs in a **fork** (room and seat). A forked ask is also written into the shared
  session. Each MCP result records `details.server`; a result from a server that can't be told counts as "private sources".
- Withholding of fork outputs until the reply is posted is per turn (round 3): tables `chat_agent_forks` (session, posted),
  `chat_agent_fork_pages`, `chat_agent_fork_files`, `chat_agent_fork_drafts`, `chat_agent_apart_windows` (all in
  `worker/agents/roster.ts`), plus `agent_seats` / `agent_seat_turns` in the seat. New columns are added with `addColumns`
  (`chat_agents`, `chat_agent_turns`, `agent_chats.owner_uid`, ...). Exports carry the fork tables. `THIS_TURN` in roster.ts.
- Posting rule is decided in `ChatRoster.release`; members see the newest posted version (`newestShown`, `shownOf`,
  `ChatAgent.held`); `announceArtifact` after posting; `routableAgents` (a member's agent is routed/speaks up only when the
  member allows it); a seat reports what it spent, and the chat budget counts it.
- Rate limit: new Rate Limiting binding **`AGENT_TURNS`** (namespace 4204, 10 per 60 s per person and agent) in
  `cloudflare.config.ts`; the PR added it, feat/agents does not have it yet. `by_uid` counts the person who started the chain.
- UI: `src/chat/AgentDraft.tsx` (draft review card), `src/chat/AgentsBar.tsx`, `src/agents/SetupTab.tsx` (review toggle).
- Memory: a seat's memory reads as the room's audience, never "alone" (item 16, done in this PR because #111 merged first).

## What remains, in exact execution order

1. Continue from `wip/pr110-merge-e2e` (489bf77). Decide with Radu whether to push it onto the PR branch or open a new PR.
2. **Verify round 3 (items 28-35)** with the lead's method: one verifier per item group, then two refuters per medium/high
   new defect. Use [reviews/pr110.md](reviews/pr110.md) round 3 as the checklist and the `pr110-checks` tests as starting
   points for reproductions.
3. Run `pnpm e2e` on the branch (not run by the T8 thread) and check a seat turn's reply carries `drafted` end to end.
4. **Item 17 (cross-PR):** the write gate inside a seat — `#callerOf` in `worker/chat-agent.ts` must treat the seat's owner as
   "the owner" (see [pr-113-agent-limits.md](pr-113-agent-limits.md) item 9). Do it if #110 merges second; if #113 merges
   second it does it. Also T10's items 9-10 (seat/levels wiring) are moved onto whichever merges second.
5. Open design gaps from rounds 2-3 (decide: fix, or put into the final PR's known gaps):
   - A withheld version's title and publish time can still show in members' listings (titles are not stored per version).
   - A reused session's transcript still holds a discarded turn's conversation, so the next turn's model can see it; files are
     not hidden from other sessions' reads, only from members.
   - The page route makes one chat-object call per non-owner load (`withheldFrom`).
   - Author values stay blocked for good after a discarded withheld version (fail closed, on purpose).
   - `speaksUp` is not cached on the roster (rooms don't hear about definition changes).
   - A small window remains between `publishVersion` and `recordPage`.
   - Fork sessions are never deleted; seat turns show no live steps in the room; hyphenated real names of member agents can look
     like aliases on rename.
6. Deploy requirement: the `AGENT_TURNS` binding must exist at deploy (it is in the PR's `cloudflare.config.ts`).
7. Un-skip the e2e placeholder `members' own agents in a shared chat` in `e2e/agents.spec.ts` (~line 317), write the flow, add
   screenshots under `docs/media/agents-e2e/`.
8. Merge into `feat/agents` (lead's job, with Radu's agreement): squash-merge. Never into `main`.

## Dependencies and merge order

- Depends on everything already in feat/agents. Needs b2f2422 merged into the branch (done only on the wip branch).
- Shares files with #113 (`worker/chat-agent.ts`, `worker/agents/turns.ts`, `worker/agents/controller.ts`, `shared/agents.ts`,
  `worker/users.ts`): expect merge conflicts for whichever goes second.
- Safe order: **#113 first, then #110** (see the reasoning in [pr-113-agent-limits.md](pr-113-agent-limits.md)); the second one
  merges feat/agents in, re-runs `pnpm typecheck && pnpm test && pnpm e2e`, and does the seat owner work (items above).

## Approvals needed from Radu

- Any merge into `feat/agents` or `main`; pushing to `claude/project-thread-bkbjsb` (open PR); any deploy; creating the
  `AGENT_TURNS` binding on a real Worker (a preview deploy to a separate Worker name only).

## Reproduce

```sh
git fetch origin wip/pr110-merge-e2e
git worktree add ../wt-110 origin/wip/pr110-merge-e2e
cd ../wt-110 && pnpm install --frozen-lockfile
pnpm typecheck && pnpm test
E2E_CHROMIUM=/opt/pw-browsers/chromium pnpm e2e
# the lead's scratch reproductions (may need small path fixes; they were written against 39d6c24..e343212):
# cp docs/handoff/reviews/pr110-checks/seat-races.test.ts.txt test/seat-races.test.ts && pnpm vitest run test/seat-races.test.ts
```
