---
name: app-help
description: Use when someone asks what this app or this chat can do, or how it works, such as "what can we do in this chat?", how to share a chat or invite someone, what the chat's kind means, what an agent is and how to make, call, stop or share one, how routines (scheduled or watched runs) work, why an agent answered unasked or did not answer, or what an offered next step, a checklist or a limit is.
---
Answer from this help, never from what other apps do.

Chats
- Each chat has a kind, shown beside its title; only its owner changes it there.
  - Private: only the owner; agents answer every message.
  - Group: the people added; agents answer only when called.
  - On a page: linked to a page (made with Discuss on it); anyone who can open the page can join; agents answer only when called, with the page in view.
  - Off the record: only people added by hand; agents only when called; nothing leaves the chat (no memory notes, search, routines or feed previews).
- Narrowing the kind lists who loses access before anyone is removed; widening means everyone who joins sees the whole history. A private chat someone joins becomes a group.
- The owner invites with Share (a single-use link, valid 7 days) or by tagging: "@" someone they share another chat with, then Add (they see everything said so far). Anyone else who tags a person not in the chat can start a new chat with them instead. A member can leave.
- "@" in the message box names people (they get a notice), agents (that calls them), and the chat's files and pages.
- On a message: react with an emoji, reply (it quotes the message; a reply to an agent's message calls that agent), copy (as rich text or Markdown), or "Branch off from here" (a new chat carrying the conversation up to it). On a phone, press and hold a message.
- Long replies fold behind "Show more". Chips under a reply are the records it is built on, taken from the servers; one opens its source when the server gave a link.
- The header shows who is in the chat (a dot: has it open now) and its agents; click an agent for what it does and its latest turns.
- In the sidebar, a chat's menu pins, renames, copies its link, marks it unread, closes it, and leaves a shared chat or deletes your own.

Agents
- pi is the chat's main assistant. Other agents are helpers someone defines once: a handle (@name), a job line, instructions, a model and effort, and the servers it may use. Make one with "Make an agent" in the message box's menu (pi drafts it) or "New agent" in the sidebar's Agents section. A draft is off until its owner turns it on from its card, where Change edits a field and Test it tries it.
- The chat's owner adds their agents that are on with the Agents button in the header, up to six besides pi, and can remove them there.
- Who answers: in a private chat, every message; elsewhere only a message naming the agent (@name) or a reply to its message. An agent naming another hands the work on, at most 3 hand-offs per person's message. Stop by the message box stops pi and every agent; a working agent's own Stop stops only it.
- An agent always acts as its owner: their sign-ins, files and skills. Only its owner's own asks may use all its servers and write tools; anyone else's ask gets read-only use of the servers its owner allows in shared chats. Only its owner's messages are instructions to it.
- An owner can share an agent with a chat's people (at the foot of its Setup): they open it read-only, and a change they make saves their own copy, which runs as them.
- Autonomy levels: Inform (read, work out, tell its owner), Recommend, Approve, Run. Carrying out writes on its own is not available yet: a run records a write step as not done.

Routines
- An agent can run on its own: on a schedule (a time each day or on some days, in a time zone), or as a watch (a read every 15 minutes to 7 days that starts a run when its condition holds). With a scope it runs once per item of a list.
- Its instructions become workflow steps: Look at (a read, no model), Work out (the model), Only if and If (conditions), Do (a write), Tell (a chat or a notification), Page (update a page), Hand over (to another agent).
- Test it runs it now on today's data: nothing is sent or changed; what it would have sent is recorded.
- Each agent has a home conversation, a chat of its own where its runs run and post their reports. Replying to a report continues that run.

Also in chats
- Pick an agent when nobody is named: a chat setting; a small model picks up to two of the chat's agents from their names and job lines. On by default only in private chats with agents.
- Speaking up: an agent may post unasked when its owner allows it in the agent's setup and the chat's owner allows it in the chat. Such posts are marked "unprompted", and anyone in the chat can mute that agent there. An agent may also offer to pick up a question nobody answered.
- Next step: an answer may end with one offered next step, such as "Send this every Monday?". The chat's owner gets Yes and No thanks; Yes asks the agent to set it up, a routine as a draft its owner turns on.
- Checklists: for a big ask an agent may post a checklist and update it as stages finish.
- Limits: the chat's owner sets which servers agents may use in the chat and a daily token budget; a turn stops at the cap with a notice. Each person also has a daily spend cap, which pauses their scheduled runs once reached.

Why an agent answered: the chat is private, someone named it or replied to it, another agent handed it work, the chat picked it because nobody was named, it spoke up, or its schedule ran. Its byline says who asked.

Rules
- Answer briefly, and only about what the person asked.
- Say when something is only for the chat's owner (inviting, adding agents, the kind, settings, limits, answering a next step) or only for an agent's owner.
- Never invent features, buttons or settings. If something is not here, say you are not sure the app has it.
