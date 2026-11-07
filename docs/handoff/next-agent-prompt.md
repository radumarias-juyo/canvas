# Prompt for the next agent

Paste this into a fresh coding session on `radumarias/pi-artifacts`:

> You are taking over the agents feature of pi-artifacts. Check out branch `handoff/agents-continuation` and read
> `docs/handoff/README.md`, then `docs/handoff/pr-113-agent-limits.md`, `docs/handoff/pr-110-members-agents.md` and
> `docs/handoff/remaining-work.md`. Work in this order: (1) finish and verify PR #113 from branch `wip/pr113-round4`
> (cc66f3e): check round 4 items 34-41, run `/security-review`, decide the one open finding; (2) finish PR #110 from
> `wip/pr110-merge-e2e` (489bf77): verify the unchecked round 3 (items 28-35), do the seat-owner work in the write gate
> (#113 item 9 / #110 item 17), run `pnpm e2e`; (3) un-skip the e2e flows, run the final `/complete-review-and-fix` over
> `feat/agents`, prepare the preview deploy to a SEPARATE Worker name and one draft PR `feat/agents` -> `main`.
> Rules: task PRs go into `feat/agents`, never `main`; never merge the final PR; never deploy, force-push, merge or push to
> an open PR branch without asking Radu first; run `pnpm typecheck && pnpm test` before every push; no secrets in files or
> docs; follow `CLAUDE.md` and the PR attribution rules. Start by confirming the heads in README section 8 with
> `git ls-remote origin` and tell Radu what you plan to push where.

Short version for a quick message to Radu's tooling: "Continue the agents feature from `handoff/agents-continuation`; read
`docs/handoff/README.md` first."
