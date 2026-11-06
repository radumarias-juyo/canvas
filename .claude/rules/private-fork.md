# Private fork workflow

This repo (`radumarias-juyo/canvas`) is a **private** extension of the public open-source
project [`radumarias/pi-artifacts`](https://github.com/radumarias/pi-artifacts).

- `origin` = this private repo. All work is pushed here.
- `upstream` = the public `pi-artifacts` repo. Only fetched from, never pushed to by default.
- Code goes public only through a deliberate PR to upstream.

## Rules for every change

1. **Keep private features in their own folders or packages, and keep edits to upstream
   files small.** Prefer adding new files/modules and hooking them in with minimal
   one-line touches to existing upstream code. Merges from upstream then rarely conflict.
   Never edit upstream's `CLAUDE.md`; put private instructions in `.claude/rules/` instead.
2. **Keep commits that might go upstream separate from private-only work.** A generic fix
   or improvement gets its own commit (no private code mixed in) so it can be
   cherry-picked into a public PR. Private-only work goes in separate commits.

## Syncing from upstream

The **Sync from upstream** GitHub Action (`.github/workflows/upstream-sync.yml`) runs every
Monday (or on demand from the Actions tab): it copies upstream's new Git LFS files into this
repo and opens a PR from `upstream-sync` into `main`. Merge it with a **merge commit**, never
squash or rebase, so later syncs stay clean.

Upstream stores `docs/media/**` in Git LFS. Claude's cloud workspace can download LFS files
but cannot upload them (the S3 storage host is blocked), so a manual merge pushed from there
fails until the Action has copied the files. Run the Action first, then push.

Manual sync:

```bash
git remote add upstream https://github.com/radumarias/pi-artifacts  # once
git fetch upstream
git merge upstream/main   # resolve conflicts, then push to origin
```

## Contributing back upstream

```bash
git fetch upstream
git switch -c upstream-pr/<topic> upstream/main
git cherry-pick <commit>...          # only the generic, non-private commits
# review the diff carefully: nothing private may be included
git push <public-remote> upstream-pr/<topic>   # then open a PR on pi-artifacts
```

Never push private branches or `main` to `upstream`.
