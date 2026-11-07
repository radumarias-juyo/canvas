# Branches, bundles and project files — what exists and what was checked

Checked 2026-11-07 ~18:45 UTC against `git ls-remote`, GitHub and the shared project folder.

## Branches that matter

| Branch | Head | State |
| --- | --- | --- |
| `main` | 6e1b667 | production source; `feat/agents` is ahead, 0 behind |
| `feat/agents` | a8cac57 | long-lived integration branch; #104-#109, #111-#121, #113 (60168c6) and #110 (a8cac57) squash-merged into it |
| `claude/project-thread-bkbjsb` | c146fc7 | PR #110 (T8), merged as a8cac57; head = wip/pr110-merge-e2e + merge of feat/agents (#113) |
| `wip/pr110-merge-e2e` | 489bf77 | #110 + feat/agents b2f2422 merged + `drafted` (saved from the T8 thread during this handoff) |
| `claude/project-thread-h00jsq` | cc66f3e | PR #113 (T6), merged as 60168c6; head = wip/pr113-round4 |
| `wip/pr113-round4` | cc66f3e | #113 + round 4 fixes + feat/agents b2f2422 merged (saved from the T6 thread during this handoff) |
| `handoff/agents-continuation` | this branch | docs only, cut from feat/agents b2f2422 and merged with a8cac57 |
| `claude/project-thread-slcjuk` | 4ea664c | lead's integration/e2e branch; tree identical to feat/agents (empty diff), fully merged via #121 |
| `claude/project-thread-8plygb` (T1), `778l4e` (T2), `s4mewb` (T3), `55r4nj` (T4), `bpnddo` (T5), `w2h5lv` (T7), `bgfa9m` (T9), `8zkqto` (T10) | various | task branches, all squash-merged (the PRs above); kept for history, nothing to continue |

Unrelated open PRs against `main`: #26 `local-runtime-models`, #102 `claude/project-thread-bgo371` (MCP sign-in after a domain move),
#103 `claude/project-thread-00vrh1` (chat cost on phones). Branch `claude/project-thread-u08pnp`, `b2bexg`, `6confx` are older
non-agents work.

No implementation exists only in a temporary worktree: the lead and the T6/T8 threads confirmed this, and the only unpushed work
they had was pushed to the two `wip/*` branches above. The handoff thread's own scratch worktrees (`/home/user/wt/*`) are clean
checkouts of pushed refs.

## Git bundles in the project folder (`/mnt/project-files/agents-impl/`)

`t4-ui.bundle`, `t4-followups.bundle`, `t4-round2.bundle`, `t4-round3.bundle`, `t4-round4.bundle`, `t9-followups.bundle`,
`t9-item23.bundle`, `t4-lfs.tar` (LFS media for T4). They were hand-offs from task threads whose branches could not be force-pushed;
the lead opened PRs from them: #115 (runs UI), #116, #118, #120 (T4 rounds 2-4 and T9 follow-ups) are squash-merged into
`feat/agents`, per the lead's status file. They are **superseded and not copied here** (binary, 7 MB of LFS). The T4 screenshots
are in `docs/media/scheduled-agents/` on `feat/agents`. If you need the exact original commits, read them from the project folder.

## Project-folder files copied into this folder

| Source in `/mnt/project-files/agents-impl/` | Here |
| --- | --- |
| `plan.md` | [original-plan.md](original-plan.md) |
| `status.md` | [lead-status-2026-11-07-0846.md](lead-status-2026-11-07-0846.md) |
| `known-gaps.md` | [known-gaps.md](known-gaps.md) |
| `briefs/T1..T10.md` | [briefs/](briefs/) |
| `specs/*` (tech-spec, both proposals, mcp-background-signin) | [specs/](specs/) |
| `reviews/pr108*.md`, `pr110.md`, `pr111.md`, `pr112.md`, `pr113.md`, `pr114.md`, `pr115.md` | [reviews/](reviews/) |
| `reviews/pr110-fixes.md` | [pr-110-fixes-log.md](pr-110-fixes-log.md) |
| `reviews/pr110-checks/*.test.ts`, `pr111-compact.test.ts`, `vitest.config.ts` | `reviews/pr110-checks/*.txt`, `reviews/pr111-compact.test.ts.txt` (renamed `.txt` so vitest and tsc ignore them) |

Not copied: the t4/t9 bundles and LFS tar, `t4-ui-screenshots/` (already in `docs/media/scheduled-agents/`). Reviews of #112 etc. are
history; the live checklists are in the two PR documents.

Other project-folder files relevant to this feature: `deploy-guide/pi-artifacts-deploy-new-account.md` (deploy to another GitHub
fork and a fresh Cloudflare account), `design-system-zip/report.md`, `effort-in-costs/unrelated-review-fixes.patch` (not part of
agents). Project memory entries `pi-artifacts-agents-impl`, `-scheduled-runs`, `-memory-notes`, `-agent-limits`, `-member-agents`,
`-agents-speak-up`, `-feed`, `-group-chat-agents`, `-agent-editor`, `-chat-kinds`, `-t3-background-signin` hold the same story in short.

## Threads read

Lead "Build multi-agent chats and scheduled agents" (cmsg_01H8rfDMngckgCVjYrKSU16ARPHfNsD2iugAAfXEmFDMDX); T8 "Let members bring
their own agents" (…ANLge9WbPmQNEhzKRFgNDeh); T6 "Add agent limits and approvals" (…AAGKKghkePYG43KgLwH4Pbn). The eight finished task
threads (T1-T5, T7, T9, T10) are listed done/resolved in the lead's status table and the thread list; none reported unpushed work.
Both the lead and T6/T8 stopped on the usage limit at 08:47 UTC on 2026-11-07 (reset about two days later), and Radu then told them
not to resume task work.
