# PR #113 · T6 — autonomy levels, guardrails, approvals and "Needs you"

Handoff written 2026-11-07 ~18:40 UTC. Read [README.md](README.md) first for the project, branch model and rules.

## Goal and acceptance

Goal: every MCP call that is not read-only goes through one write gate in the hub. What happens depends on the agent's
autonomy level and who asked: 1 Inform (refuse), 2 Recommend (proposal card the owner presses), 3 Approve (pending
action that waits and expires), 4 Run (runs if the guardrails pass). Guardrails are rules on a tool's input schema (min,
max, maxChange, never, quietDates, callsPerDay with effect block / approve / warn; the strictest wins). Approvals show in
the feed's "Needs you" and as a card in the chat they came from. A Limits tab on the agent page edits it all. `do`
steps in scheduled runs and `tell` through an outside tool (`tell.via`) go through the gate.

Acceptance (brief: [briefs/T6.md](briefs/T6.md)): a blocked guardrail never reaches the server; an approved call runs
exactly as stored; level behaviour, expiry, strictest-wins, hand-off cap; screenshots of the Limits tab, a proposal
card and the Needs you list in `docs/media/agent-limits/` (exist on the PR branch, 12 PNGs, Git LFS);
`/complete-review-and-fix` before the PR.

## Git state (verified 2026-11-07 ~18:40 UTC)

| Thing | Value |
| --- | --- |
| PR | #113 "Agents T6: autonomy levels, guardrails, approvals and Needs you", open, not draft, base `feat/agents` |
| PR base used | `feat/agents` at 17dd6c8 (a merge of 17dd6c8 is inside the branch); feat/agents is now b2f2422 (#121), NOT merged into the PR branch |
| PR branch | `claude/project-thread-h00jsq`, head **d3cd761** (34 commits ahead of feat/agents, 70 files, +5883/-196) |
| **Unpushed work, now saved** | branch **`wip/pr113-round4`**, head **cc66f3e**: d3cd761 + 6938338 (round 4 fixes 34-41 with tests) + bf501d3 (simplify) + b2deca1 (code-review fixes) + cc66f3e (merge of feat/agents b2f2422 / #121). Created by the T6 thread when asked; NOT on the PR branch. |
| GitHub review comments / CI | none (no review threads, no check runs) |
| Review history | all in [reviews/pr113.md](reviews/pr113.md): round 1 items 1-11, round 2 12-22, round 3 23-33, round 4 34-41 |

To continue: check out `wip/pr113-round4`, then either push it onto the PR branch (it is a fast-forward of
`claude/project-thread-h00jsq`: d3cd761 is its ancestor) or open a new PR. Pushing to the PR branch is a plain
(non-force) push, but it changes an open PR, so ask Radu first (see Approvals).

## Latest results (re-run by the handoff thread, Node 22.23, pnpm 10.28)

| Ref | `pnpm typecheck` | `pnpm test` | `pnpm e2e` |
| --- | --- | --- | --- |
| d3cd761 (PR head) | exit 0 | 1445 passed, 2 skipped (88 files passed, 1 skipped) | not run on this ref |
| cc66f3e (`wip/pr113-round4`) | exit 0 | 1457 passed, 2 skipped (matches what the T6 thread reported) | 7 passed, 1 failed (flow f, toast), 4 not run; see README.md |

Lint: the repo has no lint or formatter config. Do not run prettier with defaults (it reflows whole files). Match the
style by hand: 2 spaces, double quotes, semicolons, lines up to about 150 characters.

## What is complete (on the PR branch d3cd761 unless noted)

- Gate: `WriteGate` in `worker/agents/limits/gate.ts` on the chat's `McpHub` (`hub.guard`, `worker/mcp/hub.ts`). The hub
  fails closed: `read()` only runs read-only tools.
- Levels: `worker/agents/limits/levels.ts` (`turnLevel`, `inputLevel`). Owner's own message naming the agent -> 4; routed,
  unprompted, an offer's Yes (drafts only) and anyone else's turn -> 2 with read tools only; pi's hand-off -> 4 only if
  the handing turn was level 4 and not unattended; runs -> `agent.autonomy`.
- Rules: `shared/limits.ts` (612 lines: schema paths, `violation`, recipient normalisation, `hasPath`),
  `worker/agents/limits/directory.ts` (rules stored per agent and per user in UserDirectory), `src/agents/limits/rules.ts`
  and `RuleList.tsx` (rule editor generated from the tool's input schema), `src/agents/LimitsTab.tsx`.
- Approvals: `worker/agents/limits/actions.ts` (`pending_actions`, expiry through a Scheduler one-shot),
  `worker/agents/limits/feed.ts` (approval items in the feed, with `FeedAction` + result + `decidedAt` kept once ended),
  `worker/limits-routes.ts`, `src/chat/ActionCard.tsx`, `worker/agents/limits/tell.ts` (tell via an outside tool).
- Runs: `do` steps enabled in `worker/agents/runs/executor.ts`; scope elements kept in `agent_run_elements` so a run that
  goes on after a decision never re-lists the scope; missed decisions after a restart handled in `ChatAgent.onStart`
  (`#tellRunsDecided`).
- Review rounds 1-3 (items 1-8, 10, 12-33) fixed on the PR branch; round 3 checked by the lead at d3cd761 (23, 24, 27-33
  fixed; 25 and 26 only partly).
- Screenshots: `docs/media/agent-limits/` (feed-approvals, limits-tab, proposal-card; desktop/phone, light/dark).

### Database changes (no migrations framework: tables are created with `CREATE TABLE IF NOT EXISTS`, columns via `addColumns`)

New tables: `pending_actions` (`worker/agents/limits/actions.ts`), `tool_calls` and `waiting_actions`
(`worker/agents/limits/directory.ts`, the per-user directory), `agent_run_elements` (`worker/agents/runs/store.ts`, the
chat object). Per-user rules sit in the directory's key-value store under `guardrails`; per-agent rules are part of the
agent definition (`agent.guardrails`, `agent.autonomy`). New `FeedAction` fields on feed items. Nothing is deployed, so
there is no data to migrate.

## What remains, in exact execution order

1. **Get the round 4 work onto a branch that Radu has agreed on** (see Approvals): `wip/pr113-round4` (cc66f3e) is the
   state to continue from. It already contains the fixes below.
2. Round 4 items (from [reviews/pr113.md](reviews/pr113.md)), all fixed in 6938338 and its two review-pass commits, but
   NOT yet checked by the lead:
   - **34 (must)** `worker/agents/runs/executor.ts` ~440: a run waiting for a sign-in was stopped "failed" when its
     workflow changed (regression of #120's "waits follow changed steps"). Fixed: the shape check applies only to a run
     that has gone into its items. Tests added for both cases.
   - **35 (must)** `worker/chat-agent.ts` ~3465 `#configureAgent` -> `allowedTools`: a routed turn in the owner's private
     chat lost read-only tools of servers that sign in each user. Fixed: with nobody else in the chat the agent keeps every
     read-only tool of its own servers.
   - 36 `#tellRunsDecided` for every open run status; 37 reopened item after a turn-off; 38 `#run` catch uses
     `runs.stop`; 39 `skipWaiting`/`#turnedOffNow` stop items; 40 quoted local part in never rules; 41 sub-path rule with a
     plain value; optional `ruleWarning` for a rule on a tool that is now read-only. All fixed with tests.
3. **Re-verify round 4** against [reviews/pr113.md](reviews/pr113.md) (lead's method: one verifier per item group, two
   refuters per medium/high new defect; lows go to the final PR's known gaps rather than block the merge).
4. **Run `/security-review` on round 4** (not done; the T6 thread had only done simplify and code review on it).
5. **Decide the one open code-review finding** (reported by the T6 thread): a routed turn alone with the owner can read
   sign-in servers, and that session's transcript keeps the results after the chat is later shared;
   `ChatMemory.audienceChanged` does not refresh that session. Either refresh/clear the session when the audience
   changes, or accept it as a documented gap.
6. Two findings left by design (put in the final PR's known gaps if nobody changes them): no recheck before sending on a
   fresh single-pass run; the per-item definition re-read in `executor.ts` kept for safety.
7. **Item 9 — the seat owner in `#callerOf`** (`worker/chat-agent.ts`): a member's agent runs as a seat in the member's
   chat object; the gate must treat the seat's owner as "the owner" (`Caller.byOwner` only when the asker is that agent's
   owner). Do it in whichever of #110 / #113 merges second. Related: #110 item 17 (see
   [pr-110-members-agents.md](pr-110-members-agents.md)). The check said a seat's uid is already the member's, so it
   may come almost for free; add a test.
8. Un-skip the e2e flow `limits and approvals (do steps waiting for the owner)` in `e2e/agents.spec.ts` (line ~316, a
   `test.skip` placeholder) and write the flow; add screenshots to `docs/media/agents-e2e/`.
9. Known gap to carry into the final PR: a run that goes on after a decision past the spend cap ends "failed / Skipped"
   with no report, though it already acted. Also `callsPerDay` is exact only per chat (the Limits tab says so; the lead
   accepted it).
10. Merge (lead's job, with Radu's agreement): squash-merge into `feat/agents`. Never into `main`.

## Design decisions to keep

- One "Needs you": the feed's. Approval feed items carry the `FeedAction`; a decided one keeps its outcome (Ran, Failed,
  Declined, Expired).
- Strictest rule wins. `never` reads leaves and object keys (depth 6, fails closed) and normalises recipient forms
  (comments, spaces around `@`, `group:` prefix, trailing `;`, quoted local parts after round 4).
- Hub fails closed: tests of other tasks that call write tools must list the tool read-only or go through the gate.
- A turn nobody asked for (router-picked, speak-up, an offer's Yes) only proposes; it never writes.
- Page rebuilt by a run must not call write tools it did not call before.

## Dependencies and merge order

- Needs from feat/agents: everything merged through #121. The PR branch has 17dd6c8; `wip/pr113-round4` has b2f2422.
- Touches the same files as #110: `worker/chat-agent.ts`, `worker/agents/turns.ts`, `worker/agents/controller.ts`,
  `shared/agents.ts`, `worker/users.ts`, `worker/agents/runs/*`. Whichever merges second must merge feat/agents in and
  resolve conflicts, then do item 9 (and #110's item 17).
- Safe order: **#113 (after the round 4 verification and a security review) first, then #110**. Reason: #113 is closer to
  done (only round 4 checks left), #110 has an unverified round 3. The second one to land does the seat owner work.
  The lead had not yet decided which goes first; either order works if item 9 is done by the second.

## Approvals needed from Radu

- Any merge (squash into `feat/agents`), and the final PR into `main`.
- Pushing to the PR branch `claude/project-thread-h00jsq` (changes an open PR). Force pushes: none needed; the
  classifier refused force pushes before, so use merge commits or a new branch instead.
- Any deploy (see README.md; preview deploy only to a separate Worker name, needs Radu's `cf` sign-in code).

## Reproduce

```sh
git fetch origin wip/pr113-round4
git worktree add ../wt-113 origin/wip/pr113-round4   # or a branch off it
cd ../wt-113 && pnpm install --frozen-lockfile
pnpm typecheck && pnpm test
E2E_CHROMIUM=/opt/pw-browsers/chromium pnpm e2e      # a Chromium path is needed in the cloud container
```
