# Agents feature — handoff (2026-11-07)

Radu stopped the agents implementation on 2026-11-07 (about 18:28 UTC) and asked for a complete handoff to another coding
agent. This folder is that handoff. It was written from the repository, the Git history, the open PRs, every task thread and
the lead thread's files in the project's shared folder. Nothing was merged, deployed or force-pushed to produce it.

Start here, then read the two unfinished-PR documents:

- [pr-113-agent-limits.md](pr-113-agent-limits.md) — T6, autonomy levels, guardrails, approvals (PR #113)
- [pr-110-members-agents.md](pr-110-members-agents.md) — T8, members bring their own agents (PR #110)
- [remaining-work.md](remaining-work.md) — everything after those two PRs, in order, down to the draft PR into `main`
- [branches-and-artifacts.md](branches-and-artifacts.md) — every branch, bundle and project file, and what was checked
- [next-agent-prompt.md](next-agent-prompt.md) — a short prompt to hand the next agent

## 1. Objective

Build, on a long-lived branch `feat/agents` (never on `main`), the multi-agent and scheduled-agent feature of pi-artifacts, as
specified in the proposals in [specs/](specs/):

- **Multi-agent group chats** ([specs/multi-agent-proposal.txt](specs/multi-agent-proposal.txt)): a chat has a roster of agents,
  each its own pi session in the chat object; people `@name` an agent or reply to it; agents can hand off to each other (max 3
  hops) and to pi; members can bring their own agents (seats); agents can speak up unasked.
- **Agents that run on their own** ([specs/routines-proposal.txt](specs/routines-proposal.txt)): agents made from chat
  (`agent_propose`), scheduled and watched runs with typed workflow steps (only `work` calls the model), run records, daily page
  versions, autonomy levels 1-4 and guardrails, make-it-mine copies, scoped memory notes, follows and a feed with "Needs you".
- **MCP sign-in that works with nobody present** ([specs/mcp-background-signin.md](specs/mcp-background-signin.md)) plus Web Push.
- Technical shape: [specs/tech-spec.md](specs/tech-spec.md). Radu approved the whole scope on 2026-11-06 ("implement all"); the
  working rules he approved are in [original-plan.md](original-plan.md) ("Rules for every task").

The rules that govern all of it (from Radu and the repo's `CLAUDE.md`):

- Task work goes in PRs **into `feat/agents`**, squash-merged by the lead after review. Never `main`, never production.
- At the very end: **one draft PR `feat/agents` -> `main`**, never merged by an agent. Radu decides.
- Preview deploys only to a **separate Worker name**, never `pi.oxfer.app`.
- Before every PR: format, `pnpm typecheck`, `pnpm test`, then the `/complete-review-and-fix` skill (simplify, code review at
  high with fixes, security review). Do not swap `/security-review` for a hand-made check.
- Keep the app generic: no deployment's server names or business domain in code or docs, no Claude terminology in the app UI.
- UI changes need screenshots (light and dark, desktop and phone) in `docs/media/<feature>/` (Git LFS), linked in the PR as
  `https://github.com/radumarias/pi-artifacts/raw/<commit>/docs/media/...`.
- Security model stays: identity only from the verified Access token; only the owner's messages are instructions; turns nobody (or
  nobody but the owner) asked for are read-only unless autonomy and guardrails allow a write; members see only the chat's files and
  artifacts; only `worker/storage/` touches R2 and the repos. `CLAUDE.md` in the repo root has the rest.
- PRs carry the attribution block required by the project (see the session context), and are assigned to Radu.

## 2. Architecture (as built)

One stateless Worker. Per chat a `ChatAgent` Durable Object (own pi agent, `uid:chatId`) plus a Sandbox DO/container; per user a
`UserDirectory` DO plus R2 files. The agents feature adds, all inside those objects (no separate Room class — a deviation to
flag in the final PR; see [original-plan.md](original-plan.md) decision 5):

- **Definitions** in `UserDirectory` (`worker/agents/store.ts`, routes in `worker/agents-routes.ts`); shared types and checks in
  `shared/agents.ts`; `@name` matching in `shared/mentions.ts`.
- **Roster and turn queue** in the chat object (`worker/agents/roster.ts`): a turn ends with its reply kept in its row (an outbox)
  and the hand-offs it queues, in one synchronous write; replies are then posted; `resume()` posts undelivered ones after a restart.
- **Turns** (`worker/agents/turns.ts`, `controller.ts`, `live.ts`): each roster agent is its own pi session, configured per turn
  (`#configureAgent` in `worker/chat-agent.ts`); sessions get an allow-list of tools; a catch-up passive write before each turn.
- **Scheduled runs** (`worker/agents/runs/`): home conversation per agent, `Scheduler` from `agents/schedules`, one fresh pi
  session per scope item, `agent_runs` keyed `(agent, due_at, item)` for idempotence, steps run in code, report delivery, runs UI
  (`src/agents/runs/`), "Test it" (`POST /api/agents/:id/test`).
- **Sign-ins and push** (`worker/mcp/*`, `worker/push/`): sealed per-user MCP tokens, grant checks and notices, keep-alive,
  Disconnect, Web Push.
- **Chat kinds** (`shared/chat-kinds.ts`, `worker/chat-kind.ts`, `worker/branch.ts`): private / group / page / off the record,
  add by tagging, branches, sidebar actions.
- **Memory notes** (`worker/memory/*`), **follows and the feed** (`worker/feed/*`), **speak up / router / budgets / checklists /
  offers / metrics** (`worker/agents/router.ts`, `speak-up.ts`, `funnel.ts`, `spend.ts`, `worker/metrics.ts`).
- **E2E** (`e2e/`, `pnpm e2e`): Playwright against the dev server with a scripted model (`DEV_MODEL=script`,
  `worker/dev-model.ts`) and stand-in MCP servers (`e2e/stand-in.ts`, `test/fake-portal.ts`).
- Not yet in `feat/agents`: the write gate and Limits UI (#113) and seats / private forks (#110).

## 3. Completed work (merged into `feat/agents`, head b2f2422, verified from `git log`)

| PR | Merge commit | Content | Task thread |
| --- | --- | --- | --- |
| #104 | aa514fc | Phase 1: definitions, roster, turns | lead |
| #107 | ccfa5e3 | T2 agent editor, draft card, shared agents and copies, export/import | "Build the agent editor" |
| #106 | 43b8b6d | T1 group chat UI, live turns, people bar, @ picker | "Build group chat UI for agents" |
| #109 | bae9627 | T5 chat kinds, page chats, add by tagging, branches | "Add chat kinds for agents" |
| #105 | 1e0b356 | T3 background MCP sign-in and Web Push | "Add background MCP sign-in and push" |
| #108 | cd654c9 | T4 scheduled/watched runs engine | "Add scheduled agent runs" |
| #115 | 6315561 | T4 runs UI, round 2, traces side by side | same |
| #112 | 3fb1b37 | T9 follows and the feed (Needs you) | "Add follows and the feed" |
| #111 | 36659d5 | T7 memory notes | "Let agents remember notes" |
| #116 | 26efe32 | runs and feed follow-ups | lead branch |
| #117 | 46da283 | memory notes round 3 | T7 |
| #118 | 9e31da1 | runs and feed round 3 | lead branch |
| #119 | e06a58d | memory notes round 4 | T7 |
| #120 | 4993ba3 | runs round 4 | lead branch |
| #114 | 17dd6c8 | T10 speak up, router, budgets, checklists, offers, metrics | "Let agents speak up, add metrics" |
| #121 | b2f2422 | end-to-end check: 12 browser flows on a scripted model | lead |

(#104-#109, #111, #112, #114-#121 as in project memory; #110 and #113 are the two open ones.) Leftover low-severity gaps from
those PRs are in [known-gaps.md](known-gaps.md) — include them in the final PR description. Per-task lead reviews are in
[reviews/](reviews/); the briefs each task started from are in [briefs/](briefs/). The lead's final status table is
[lead-status-2026-11-07-0846.md](lead-status-2026-11-07-0846.md).

## 4. Unfinished work

1. **PR #113 (T6)** — round 4 (items 34-41) fixed and tested but only on `wip/pr113-round4`; not verified by the lead, no security
   review of round 4; item 9 (seat owner) waits for #110. -> [pr-113-agent-limits.md](pr-113-agent-limits.md)
2. **PR #110 (T8)** — round 3 (items 28-35) claimed fixed but never verified; the #121 merge and `drafted` work only on
   `wip/pr110-merge-e2e`; item 17 waits for #113. -> [pr-110-members-agents.md](pr-110-members-agents.md)
3. Un-skip three e2e flows (limits, members' agents, speak-up needs `INTEREST_MODEL`).
4. Final full-branch `/complete-review-and-fix`, preview deploy to a separate Worker, screenshots, the draft PR into `main`.
   -> [remaining-work.md](remaining-work.md)

All other task threads (T1-T5, T7, T9, T10, E2E) are finished and merged; their threads hold nothing unpushed (checked: see
[branches-and-artifacts.md](branches-and-artifacts.md)).

## 5. Merge order

1. Verify and merge **#113** into `feat/agents` (squash, by the lead with Radu's agreement).
2. Merge feat/agents into **#110**, verify its round 3, add the seat owner work (#113 item 9 / #110 item 17), merge it.
3. Un-skip e2e flows, final review, preview deploy, draft PR `feat/agents` -> `main`.

`feat/agents` is currently up to date with `main` (main is 6e1b667; 0 commits behind, 16 ahead). Keep it rebased/merged on `main`
if `main` moves. Other open PRs against `main` (#26 local runtime models, #102 MCP sign-in after a domain move, #103 chat cost on
phones) are unrelated to this feature; #102 touches MCP sign-in and may conflict with T3's `worker/mcp/oauth.ts` work.

## 6. Dependencies, bindings and config the feature needs (names only, no values)

Deploy configuration the final PR must list (from the lead's notes and `cloudflare.config.ts`):

- `AGENT_ROUTER_MODEL`, `INTEREST_MODEL`, `RUNS_DAILY_USD`; optional `METRICS` Analytics Engine dataset (#114).
- `AGENT_TURNS` rate-limit binding, namespace 4204, 10 per 60 s (added by #110 only).
- `PAGE_AI` rate-limit binding (namespace 4202) and `PAGE_AI_MODEL`, `PAGE_AI_DAILY_USD` — from PR #89, already in
  `cloudflare.config.ts` on feat/agents (check that production has the binding).
- Push: secrets `PUSH_VAPID_PUBLIC_KEY`, `PUSH_VAPID_PRIVATE_KEY`, `PUSH_SUBJECT` (generate with `scripts/vapid-keys.ts`); optional
  `MCP_TOKENS_KEY`. **Never change these once deployed**: sealed records and subscriptions stop opening.
- `DEV_TOOLS` and `DEV_MODEL` must stay unset/false for any deploy.
- Every deploy must set `PI_MCP_SERVERS` so that it still includes the production Cloudflare MCP portal entry (auth `oauth`),
  or that server drops out. The entry's name and URL are the operator's (Radu's) and are deliberately not written here: read them
  from the last production deploy, or ask Radu.

Tooling: Node >= 22, pnpm, the `cf` CLI for configuration and deploys (no Wrangler config), Docker for the sandbox image build,
Chromium for `pnpm e2e` and the page check tests (in the cloud container set `E2E_CHROMIUM=/opt/pw-browsers/chromium`).

## 7. Deployment status

- Production is **https://pi.oxfer.app**, deployed from `main` only. Last recorded state (2026-11-06 20:55): main 3c9b7e3 deployed
  as version 367c753a with everything through #100. After that `main` gained #101 (message history in the composer) and
  screenshots (now 6e1b667); whether those were deployed is not recorded here.
- **`feat/agents` has never been deployed anywhere**, and neither have #110 or #113. No preview Worker exists.
- Deploys use `cf deploy` with a device login that Radu approves (a 5-minute code), unless a `CLOUDFLARE_API_TOKEN` is added to
  the environment. PRs are squash-merged. The sandbox image build needs Docker.
- Nothing in this handoff changed any deployment.

## 8. Verification done for this handoff (2026-11-07, UTC)

- Branch and PR state read from GitHub (open PRs: #26, #102, #103, #110, #113; no review threads or check runs on #110/#113).
- Heads confirmed with `git ls-remote`: `feat/agents` b2f2422, #110 be0d051, #113 d3cd761, `main` 6e1b667.
- The lead's merge branch `claude/project-thread-slcjuk` has a tree identical to `feat/agents` (empty `git diff`).
- Every task thread read to its latest status; the T6 and T8 threads were asked to push uncommitted work and did, to the two
  `wip/*` branches. The lead thread reported all its worktrees are clean checkouts of pushed heads.
- Test, typecheck and e2e results (fresh installs from the lockfile, Node 22.23, pnpm 10.28):

| Ref | `pnpm typecheck` | `pnpm test` | `pnpm e2e` |
| --- | --- | --- | --- |
| `feat/agents` b2f2422 | exit 0 | 1364 passed, 2 skipped | 7 passed, 1 failed, 4 not run (note below) |
| #110 be0d051 | exit 0 | 1428 passed, 2 skipped | not run |
| `wip/pr110-merge-e2e` 489bf77 | exit 0 | 1436 passed, 2 skipped | 7 passed, 1 failed, 4 not run (same) |
| #113 d3cd761 | exit 0 | 1445 passed, 2 skipped | not run |
| `wip/pr113-round4` cc66f3e | exit 0 | 1457 passed, 2 skipped | 7 passed, 1 failed, 4 not run (same) |

`pnpm e2e` (run in this cloud container with `E2E_CHROMIUM=/opt/pw-browsers/chromium`, 15 tests defined): on `feat/agents`
b2f2422, `wip/pr113-round4` and `wip/pr110-merge-e2e` alike, flows a-e and g (7 tests) pass, **flow "f. bob follows ada's agent and
sees its post in his feed" fails after the 2-minute test timeout** (a notification-permission toast from `src/chat/notify.tsx`
covers the "See how it is set up" link it clicks), and the remaining 4 flows (h, i, i, j) then do not run; 3 are `test.skip`
placeholders. The lead had reported 12 flows passing at b2f2422 on its own machine, so this is either specific to this container
or a latent flake; it is not caused by #110/#113 (same result on plain `feat/agents`). First thing to settle: see
[remaining-work.md](remaining-work.md) step 4. The wip branches' own e2e therefore could not confirm anything beyond flows a-e, g.
The T6 thread reported `pnpm e2e` 12 passed / 3 skipped at cc66f3e in its own environment (not reproduced here).

There is no lint or formatter configuration in the repository (do not run prettier with its defaults). "Lint" in the project's
sense is `pnpm typecheck` plus the review skills.

## 9. What needs Radu's approval

- Every merge (task PRs into `feat/agents` were pre-approved on 2026-11-06 for the lead thread; with the lead stopped, ask again
  or confirm that the next agent is the lead), and above all the final PR into `main` — never merged by an agent.
- Pushes to the open PR branches `claude/project-thread-h00jsq` (#113) and `claude/project-thread-bkbjsb` (#110), or force pushes
  to anything. Force pushes of rewritten task branches were refused by the permission classifier before; use merge commits or new
  branches.
- Any deploy, including a preview deploy: needs Radu's `cf` device-login code, and a separate Worker name.
- Creating the `AGENT_TURNS` binding or any new secret on a real account.
- Whether to open any PR for this documentation branch (none was opened).
