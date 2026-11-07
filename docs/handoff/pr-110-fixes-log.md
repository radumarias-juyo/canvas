# PR #110: how the review items were fixed (head 39d6c24)

Items 1-15 of pr110.md were all still open at 26cbf00; 08b2416 had only half-done item 2. All 15 are fixed in 39d6c24. It is pushed, typecheck passes, and 1161 tests pass. The full review pass ran on the fixes: simplify, code review at high with fixes applied, and security review, which found nothing above the bar.

1. Every turn an owner gives their own agent now runs in a fork, in the room and in a seat. The old fork rule (forksFor) and the apart flag are gone, which also closes item 8.
2. Each MCP result records its server when it is called (`details.server`). A result from an MCP tool whose server can't be told counts as "private sources" and is never shared.
3. What a fork publishes or saves is hidden from members until its reply is posted, and stays hidden for good after a discard. This covers members' listings, attaching and opening files, and page calls to sign-in servers. It is tracked in the `chat_agent_forks` table (session, posted flag), which exports carry. The traces read decides per session, and reads a fork whose turn has ended only once more. Page calls read a cache that is kept only while no fork runs.
4. `changed()` now runs after `setFork`, so the owner follows the fork live. Followers also compare session as well as turn.
5. A forked turn's ask is also written into the shared session (room and seat). There is a test.
6. A seat give is retried on errors marked retryable. When it still fails, the room stops the turn at the seat. A seat also stops a running turn the room gave up on before it starts the next one.
7. A member's agent reads its owner's messages as instructions only from where it joined (`owner_from`). pi's prompts count as the owner's only for an agent the chat owner owns.
9. A requeued fork keeps its session, and its input is submitted there again (placed once).
10. A fork whose outputs can't be read shows the "private sources" chip, and is held for review when review is on.
11. The rate limit counts the person who started the chain (`by_uid`, also carried in the data of a turn handed to pi).
12. A copy takes "Review before posting" only from the copier (`OWN_FIELDS`).
13. An alias is stored as a column instead of being guessed from the name.
14. The owner's second seat shows no Agents button.
15. A seat sets a single alarm to post again the results its rooms did not take. A repeated give of a known turn wakes that turn.

## Known gaps (design calls)
- Holding back works by page id and file path, not by version. A fork that publishes a new version of a page already in the chat, or overwrites a file already in the chat, is visible to members before its reply is posted.
- A publish that was aborted or interrupted has no result details, so it slips past the hide list. The security review suggests recording what each fork published at publish time (onPublished) instead.
- Items 16 and 17 belong to whichever of #111 and #113 merges second. Neither is in feat/agents yet.

# Round 2 (items 16, 18-27) and the review pass: head e343212

feat/agents is merged in up to 9e31da1 (#116, #117 and #118). Typecheck passes; 1299 tests pass, 2 skipped. The full review pass ran: simplify, code review at high with fixes applied, and security review.

- **16. A seat's memory reads as the room.** It uses the room's kind and the room's chat-object name, and is never "alone". Its saves count as the owner's only on a forked turn the member asked for. A session nobody knows reads and saves nothing.
- **18-25, 27.** Each is fixed with tests:
  - A seat's turn given again while it is being set up is left to that give, and one whose give died is set up again. A taken turn is kept as a tombstone for 24 hours.
  - The outputs of a failed or empty fork stay withheld (held for review when review is on and it read a private server).
  - An agent's own forked reply names the pages it published and the files it saved.
  - Forks' pages are withheld by version (chat_agent_fork_pages, recorded at publish time from the session). They are hidden from other sessions' title matching, reads and publishes.
  - A reviewed fork changes no page or file the chat already has.
  - A reply to a run's report runs apart, like a fork.
- **26.** An alias stores the name it was made from (alias_of). Any rename ends the alias, and the new name is taken when it is free.
- **Review pass:**
  - **One posting rule.** Whether a reply's outputs are posted is decided in ChatRoster.release, from the reply itself. A turn in a run's reply session counts as apart.
  - **Hidden pages.** There is one set of hidden pages, and each page check is one indexed query. Nothing is read when no unposted turn apart exists, and session rules read the full traces only when the session is reviewed.
  - **A run's reply session goes apart only from its newest entry when the turn starts** (from_entry). What came before stays the chat's after a cold read. If an earlier turn there was never posted, the session is `kept`: posting a later reply there releases nothing.
  - **Smaller fixes:**
    - pagesOf counts only unposted rows.
    - artifact_diff defaults to a version the session can see.
    - history and read show only the version counts the session can see.
    - The seat ends a stale turn that was never submitted.
    - chat_agent_turns.session is indexed.
    - Exports carry chat_agent_fork_pages.

## Left open
- **17** (#113's write gate inside a seat) is still waiting for #113.
- **Drafts are per chat, not per session.** An unposted fork's draft can be listed and published from another session of the owner's chat. Fixing that needs the drafts store to record the session.
- **A run's page step builds on meta.latest** (worker/agents/runs/page.ts), so it can carry a fork's withheld version into a new version that members can see.
- **A withheld version that is never posted** (discarded) blocks members from the page's author values for good. Members' calls also fall back to that version's rules.
- **A `kept` run-reply session withholds everything later turns make in it.** The owner still sees all of it. Withholding per turn would need trace windows per turn.
- **A small window remains** between publishVersion and recordPage.

# Round 3 (items 28-35) and the review pass: head be0d051

feat/agents is merged in up to 17dd6c8 (#114). Typecheck passes; 1428 tests pass, 2 skipped. The full review pass ran: simplify, code review at high with fixes applied, and security review.

- **28. Files a turn apart saves are recorded before they are saved** (chat_agent_fork_files, written by saveFiles in files_write and the sandbox's outputs). Nothing is saved once the tool's signal is aborted. Recorded paths are withheld until the reply is posted, also over a file the chat had, and for good after a discard. Stop and restart cases are tested.
- **29. A seat turn that was stopped, ended by a later give, or dropped before its input went in never runs.** abort() ends a running row whose input isn't in; #start re-reads the row before submitting and aborts the session if it stopped meanwhile; a set-up is claimed before its first await (#claimed); a later give waits for a stale set-up to end.
- **30. Drafts are withheld per turn** (chat_agent_fork_drafts): another conversation does not list, read, edit from, check or publish them until that turn is posted. A draft saved from a conversation the chat sees stays the chat's.
- **31. Members get the newest version that is the chat's** in contents, the artifact view (versions and time too) and the page route (a held version is a 404). A held version reaches followers and the page's chat only once its reply is posted (announceArtifact), and not when a newer shown version is out.
- **32. A run's page step builds on the newest version the chat has** (ChatAgent.held, shownOf); it fails when none is.
- **33, 34. Apart windows per turn replace `kept`** (chat_agent_apart_windows): each turn in a run's reply session is posted with its own window, pages, files and drafts. A held reply posted after the next turn starts shows its own chips; a discarded, failed or stopped one stays withheld without holding back later turns. Old rows are migrated fail-closed.
- **35. The router picks a member's agent for someone else's message only when the member lets it speak unasked** (routableAgents, read from the member's directory within the router's time, a failure counts as no). A seat's turn reports what it spent, and the chat's budget counts it.
- **Security review fixes (be0d051):**
  - Withholding is per turn, not per session: a later turn in a run's reply session no longer sees, builds on or publishes an earlier discarded turn's pages, versions or drafts.
  - A page brought into another chat with "@" reads without the versions its own chat holds, so pi in the page's discussion chat cannot quote a withheld version.

## Left open
- **17** (#113's write gate inside a seat) still waits for #113.
- **A withheld version's title and publish time** can still show in members' listings: titles are not stored per version.
- **A reused session's transcript** still holds a discarded turn's conversation, so the next turn's model can see it (pages, files and drafts are now kept apart). Files are not hidden from other sessions' reads either, only from members.
- **The page route makes one chat-object call per non-owner load** (withheldFrom), run in parallel with reading the page.
- **Author values stay blocked for good** after a discarded withheld version (fail closed on purpose).
- **speaksUp is not cached** on the roster, because rooms don't hear about definition changes.
