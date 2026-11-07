# Remaining work after the two open PRs, in order

Source: the lead thread's last plan (status posts up to 08:45 UTC and the relay at 18:32 UTC), `original-plan.md`, and Radu's rules.
Steps 1-2 are detailed in [pr-113-agent-limits.md](pr-113-agent-limits.md) and [pr-110-members-agents.md](pr-110-members-agents.md).

1. **#113 round 4**: take `wip/pr113-round4` (cc66f3e), verify items 34-41 (see [reviews/pr113.md](reviews/pr113.md) round 4),
   run `/security-review` on the round, decide the one open code-review finding, then merge into `feat/agents`. *Approval: Radu
   (merge, push to the PR branch).*
2. **#110 round 3**: take `wip/pr110-merge-e2e` (489bf77), merge `feat/agents` in again (it will have #113), verify items 28-35
   ([reviews/pr110.md](reviews/pr110.md) round 3), do the seat owner work in the write gate (#113 item 9 / #110 item 17), run
   `pnpm e2e`, then merge into `feat/agents`. *Approval: Radu.*
3. **End-to-end flows for the two PRs.** In `e2e/agents.spec.ts` replace the three `test.skip` placeholders (lines ~316-318):
   limits and approvals (do steps waiting for the owner), members' own agents in a shared chat, and speaking up unprompted. The
   third needs `INTEREST_MODEL` (Workers AI embeddings), which `PI_OFFLINE=1` leaves empty, so it needs a stand-in or stays a
   documented skip. Keep the suite one worker, flows in order (they share people, agents and chats). Add screenshots under
   `docs/media/agents-e2e/` (Git LFS).
4. **Fix the e2e flake seen by the handoff run** (see the README): flow "f. bob follows ada's agent…" failed in this container
   on the plain `feat/agents` head because a notification-permission toast (`src/chat/notify.tsx`, "Your browser shows it even while
   you are in another tab or app") covered the link it clicks. The lead had reported all 12 flows passing at b2f2422, so this may be
   environment- or timing-dependent. Dismiss or avoid the toast in `e2e/app.ts`/the flow, or fix the stacking.
5. **Final review of the whole branch**: `/complete-review-and-fix` (simplify, `/code-review high --fix`, `/security-review`) over
   the whole `feat/agents` diff against `main` (about 300 files, +35k lines), fixing what it finds in PRs into `feat/agents`. The
   security review diffs against `origin/HEAD`; point it at the base locally with
   `git symbolic-ref refs/remotes/origin/HEAD refs/remotes/origin/main` (or `git remote set-head origin <branch>`).
6. **Preview deploy to a separate Worker name** (never `pi.oxfer.app`): needs Radu to approve a `cf` device login (a 5-minute
   code). Give the preview its own name and bindings (`AGENT_TURNS`, `PAGE_AI`, `PAGE_CALLS`, `DICTATION` namespaces are per
   account: use new numbers or a separate account), its own R2 bucket/Artifacts namespace names, and an `PI_MCP_SERVERS` list. Set
   the config from [README.md](README.md) section 6. Never set `DEV_TOOLS` or `DEV_MODEL`. Then click through: create an agent,
   a shared chat with a second account, a scheduled run, an approval, a member's agent. *Approval: Radu for every deploy.*
7. **Screenshots** of the finished feature (light/dark, desktop/phone) in `docs/media/<feature>/`, linked in the PR as
   `https://github.com/radumarias/pi-artifacts/raw/<commit>/docs/media/...` (not raw.githubusercontent.com, which serves only the
   LFS pointer).
8. **The one draft PR `feat/agents` -> `main`**, assigned to Radu with him as reviewer, body starting with the project's
   attribution block, listing: what shipped per task, the deviation (no separate Room object class), [known-gaps.md](known-gaps.md)
   plus the gaps in the two PR documents, the deploy configuration of README section 6, and the test/e2e results. **Never merge it.**
9. Update project memory (`pi-artifacts-agents-impl` and the per-task entries) as steps complete.

Other deferred items worth tracking (not blocking): the follow-ups owed in [known-gaps.md](known-gaps.md). (Chat export carries the
roster now: `chat_agents` is in `APP_TABLES` of `worker/chat-dump.ts`.)
