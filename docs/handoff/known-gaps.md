# Agents feature: known gaps for the final PR

Collected by the lead as task PRs merge. Each was judged low and fail-safe (or a design call) by the lead's checks.

## Memory notes (#111, #117, #119)
- A fresh start's late look leaves out every memory result that landed after it read the context. That includes a
  recall answered after the join for the current readers, which was safe to keep. The model is then told to call
  again. This hides too much rather than too little.
- There is no beforeCompact hook. Up to 5 looks stop or leave out compactions instead. The hook only gets `reason`,
  and a threshold compaction can be blocking or background.
- A recall whose result is discarded (read again for a join) still counts one use on the notes it found.
- Members' sockets leave out memory tool results by tool name, even for chat or agent notes recalled after a share.
- by_owner is not in the export.

## Scheduled runs and sign-ins (#108, #115, #116, #118, and round 4)
- A sign-in that lands during a run's check, with no released older run, still asks the owner again.
- Waits of an agent that was turned off or changed stay in mcp_waiting until the next sign-in or Disconnect. A notice
  can then still say "@x is waiting".
- `#wakeDeferred` misses a second newer run that is waiting, because newer() ignores needs_sign_in. With T0 released,
  T1 failing and T2 waiting, both T0 and T2 can post.
- Existing agents get step servers only on their next save. There is no deployed data, so nothing is affected yet.
- A test run of an off agent waiting on a step-read server gets Disconnect in the account menu.
- Run sessions are never deleted, because pi-durable has no delete API.
- A run that is checking its sign-ins while its agent's steps change still waits on a server the new steps dropped.
- `#followServers` also runs in fired()'s apply, before the due run's row exists. A run waiting on a server the agent no
  longer uses can then restart beside the due run, and both post. That needs an earlier pass that missed it, such as a
  failed read or a failed tell.
- A run that resume() picks up after a reset during a wake doesn't check whether its agent is on.
- The sidebar can name an agent that only uses the server in work as the one that "reads it in a step".
- agentChanged writes step and run servers after awaits without asking accepts() again. A quick v2/v3 save can leave
  v2's servers.

## Speak up, router, budgets, offers (#114)
- A refused Yes still hides its button in that browser.
- Saved results share ./files/ with user files in the sandbox.
- pi's Yes runs on the root conversation with narrowed tools, not in its own session. A message that arrives while
  the Yes runs joins it on the draft tools, and the tools come back at settle.
- Agent definitions saved before the hidden-character strip aren't cleaned again. UserFiles.put has no saved-result
  name check, so imports aren't covered.
- A few default-ignorable code points (U+034F, U+17B4/5, Mongolian variation selectors) are kept. The draft card
  renders instructions as Markdown, so a reference definition shows as nothing there (the agent page's textarea shows
  it).
