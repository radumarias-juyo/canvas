# Prompt for the next agent

Paste this into a fresh coding session on `radumarias/pi-artifacts`:

> You are taking over the agents feature of pi-artifacts. Check out branch `handoff/agents-continuation` and read
> `docs/handoff/README.md`, then `docs/handoff/remaining-work.md`, `pr-113-agent-limits.md` and `pr-110-members-agents.md`.
> PRs #113 and #110 are already merged into `feat/agents` (a8cac57) but not fully verified. Work in this order: (1) verify #113
> round 4 and run `/security-review` on it, decide its open finding; (2) verify #110 round 3 and make the write gate know a
> seat's turns (today a member's agent's writes are refused); (3) un-skip the e2e flows and settle the e2e flake in flow f;
> (4) run the final `/complete-review-and-fix` over `feat/agents`, prepare the preview deploy to a SEPARATE Worker name and one
> draft PR `feat/agents` -> `main`. Rules: task PRs go into `feat/agents`, never `main`; never merge the final PR; never deploy,
> force-push or merge anything new without asking Radu first; run `pnpm typecheck && pnpm test` before every push; no secrets in
> files or docs; follow `CLAUDE.md` and the PR attribution rules. Start by confirming the heads in README section 8 with
> `git ls-remote origin`.

Short version for a quick message to Radu's tooling: "Continue the agents feature from `handoff/agents-continuation`; read
`docs/handoff/README.md` first."
