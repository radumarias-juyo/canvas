# Lead review of #108, round 2 (the fixes and the merge of #105/#109)

#108 is merged into feat/agents as cd654c9. These items came out of checking the 19 fixes at 5314b4b. Two more
reviewers checked each one and tried to refute it; all are confirmed by both unless marked "split". Please make the
fixes as their own commits in the UI PR, each with a test where one fits. Line numbers are at 5314b4b.

## Must fix

1. **Medium, security · `worker/agents/runs/page.ts` ~80 `publishRebuilt`.** A rebuild can still make the page write
   as the owner. The manifest compare stops newly declared tools, but not new calls to write tools the seed already
   declares. Example: a page declares `crm.update_deal` behind a button. A rebuild steered by the report's MCP text adds
   a load handler that calls it. In the check, `not_granted` counts only as a warning, so the draft passes and gets
   published. The owner's next view runs the write with `hub.call` as the owner. Fix: publish a rebuilt snapshot with
   no `mcp` declaration, or with only the seed's read-only tools. Recording calls during the check is not enough,
   because code can skip the call while it is checked.
2. **Medium · `worker/chat-agent.ts` ~2777 `#onAlarm`, detached runs.** The one-shot now completes at once and
   Lifecycle re-arms for the next job, so the deadman alarm that used to wake the object after a reset is gone. A
   deploy mid-run (in a look, the sign-in check or a delivery) leaves the run "running" until the next wake, often
   the next day's alarm. Yesterday's report then comes next to today's. Fix: while `runs.unfinished()` is non-empty,
   keep a short idempotent Scheduler wake (a minute or two ahead, renewed), so `resume()` runs soon after any reset.
3. **Medium · `worker/chat-agent.ts` ~2809 run servers.** `setRunServers` and the pre-run `checkSignIns` get only the
   watch, scope and look servers. Work steps also get `runTools` from all of the agent's servers, sign-in ones
   included. An agent with `servers: ['calendar']` (oauth) and one work step has no run servers. The keep-alive
   never refreshes calendar, the run starts, and the calendar call fails inside the model turn with no sign-in
   wait or notice. Fix: for workflows with a work step, include the oauth servers its tools can come from in both.
4. **Medium · `worker/chat-agent.ts` ~3204 `#pageStep`.** Its `onPublished` override drops #109's `#tellPageChat`.
   A version a run publishes never reaches the page's Discuss chat: no notice line, a stale `kinds.page().version`,
   and its agents keep reading the old version. Fix: keep the page-chat notice, then add a test that a run's publish
   calls `pageVersion` on the linked page chat.
5. **Medium (from T8's review of its merge) · home chats with members.** In an agent's home chat, a message that
   names nobody still goes to the home agent after the chat has members. CLAUDE.md says that in a shared chat only a
   summons or a reply runs an agent, and as it is, members spend the owner's budget. Fix: follow the chat's kind
   (`answersEveryMessage`), as every other chat does.

## Should fix

6. `worker/agents/runs/page.ts` ~75: `publishRebuilt` picks the newest passed draft of the page saved since `dueAt`,
   whoever wrote it. That can be the owner's work in progress in the home chat, or the draft of an overlapping run of
   the same agent (a watch, or Run now). Bind it to this delivery: publish only a draft the rebuild session wrote
   (the ids its `artifact_write`/`artifact_check` returned), or one that descends from this seed.
7. `worker/agents/runs/page.ts` ~16: the run mark has no agent id. Two agents with the same due time and the same
   step key on one page skip each other's delivery as "published already". Put the agent id in the mark.
8. `worker/agents/turns.ts` ~180 `askLine`: a run's report (turn 0) reaches the agent's main session twice. Once
   from `#placeRun`'s context write, and again from the catch-up as `[you, in a run]: …`. Label only forked turns'
   replies (`data.run && data.turn`), or drop one of the two. The new test asserts the double read, so change it.
9. `worker/agents/runs/runner.ts` ~162: a reset after the one-shot completes but before `#apply` sets the next alarm
   stops the schedule for good. `reconcile` returns early because the stale row is still there. Arm the retry before
   the definition read (and cancel it once the next alarm is set). Make `reconcile` re-apply a schedule row whose
   `due_at` has passed, or whose job `scheduler.get()` no longer finds.
10. `worker/agents/runs/executor.ts` ~284: test runs waiting for a sign-in are never restarted. A chat hears
    `signedIn` only from `mcp_waiting`, and test runs skip `notifySignInNeeded`. Record the home as waiting for
    tests too, without a notice or push (an option on the call), and log rejected `signInNeeded` RPCs.
11. `worker/agents/runs/executor.ts` ~501: a run whose only delivery failed still ends `sent` when an item acted. If
    the workflow has deliveries and none was sent or recorded, end `failed`.
12. `worker/agents/runs/executor.ts` ~337: a watch run without a work step never writes the value that fired it, so a
    reply to its report (a fork of the item session) can't see what changed. Write the watch value whenever a watch
    started the run.
13. `worker/chat-agent.ts` `sourceMoved`: it accepts the Source's notice before handling it, so a failed handling
    counts as told and that change is lost until the value moves again. Await the handling, at least up to storing
    the run row, so a failure rejects `notify`.
14. (split, low) `runner.ts` ~125 and `chat-agent.ts` ~2810: the version guard only remembers the last apply that
    changed the row. A same-trigger no-op doesn't record the newer version, `#clear` drops it, and
    `setRunServers` runs whatever `apply` decided. One checker found no way for notices to arrive out of order in
    practice. Cheap to harden: keep the applied version per agent in KV and skip older definitions everywhere
    `agentChanged` acts.
