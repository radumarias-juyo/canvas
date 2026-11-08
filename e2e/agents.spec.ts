// The agents feature end to end, as an owner (ada) and someone she invites (bob) use it, on the scripted model: each
// message carries the script its agent follows (/say, /tool: worker/dev-model.ts). The flows run in order and build on
// each other; each ends on a screenshot in e2e/screens/.

import { expect, test, type Page } from "@playwright/test";
import { addToChat, agentReply, call, crmState, newChat, piReply, send, shot, signIn, type Person } from "./app.ts";

test.describe.configure({ mode: "serial" });

let ada: Person;
let bob: Person;
/** ada's chat with her agents in it (flows a and b), and the one she shares with bob (c). */
let agentsChat: string;
let sharedChat: string;
/** The agent with a workflow (e), by id. */
let scoutId: string;

/** What a person writes to make pi draft an agent: agent_propose's input, on one line. */
const propose = (input: Record<string, unknown>) => `/tool agent_propose ${JSON.stringify(input)}`;

test.beforeAll(async ({ browser }) => {
  [ada, bob] = await Promise.all([signIn(browser, "ada"), signIn(browser, "bob")]);
});

test("a. an agent made in the editor answers in a chat", async () => {
  const { page } = ada;
  await page.getByRole("button", { name: "Agents" }).click();
  await page.getByRole("link", { name: "New agent" }).click();
  await expect(page.getByRole("heading", { name: "New agent" })).toBeVisible();
  await page.locator("[data-field=name] input").fill("helper");
  await page.locator("[data-field=job] input").fill("Answers questions about the deals");
  await page.locator("[data-field=instructions] textarea").fill("1. Look the deals up.\n2. Answer in a sentence.");
  await page.getByRole("button", { name: "Make the agent" }).click();
  await expect(page.getByRole("heading", { name: "helper" })).toBeVisible();
  await expect(page.getByText("On", { exact: true })).toBeVisible();
  await expect(page.getByRole("navigation", { name: "Your agents" }).getByRole("link", { name: /@helper/ })).toBeVisible();

  agentsChat = await newChat(page);
  await addToChat(page, "helper");
  await send(page, "@helper /say hello from the agent");
  const reply = agentReply(page, "helper", "hello from the agent");
  await expect(reply).toBeVisible();
  await expect(reply).toContainText("ada's");
  await shot(page, "a-agent-reply");
});

test("a. pi drafts an agent, and its card turns it on in the chat", async () => {
  const { page } = ada;
  await send(page, propose({ name: "relay", job: "Hands the summary to pi", instructions: "/say @pi please summarise the deals", servers: ["crm"] }));
  const card = page.getByRole("article", { name: "Agent @relay" });
  await expect(card).toBeVisible();
  await expect(card).toContainText("Proposed by pi");
  await expect(page.getByRole("navigation", { name: "Your agents" }).getByText("Draft")).toBeVisible();
  await card.getByRole("button", { name: "Turn on" }).click();
  await expect(card).toContainText("@relay is on and in this chat");
  await expect(page.locator(".chat-notice", { hasText: "@relay" })).toBeVisible();
  await shot(page, "a-draft-card");
});

test("b. a hand-off: the agent's reply names @pi, and pi answers", async () => {
  const { page } = ada;
  await send(page, "@relay over to you");
  const handed = agentReply(page, "relay", "please summarise the deals");
  await expect(handed).toBeVisible();
  // pi's turn reads the hand-off ("[relay · agent]: @pi please…"), which carries no script: the scripted model's ok.
  const answer = piReply(page, "ok: @pi please summarise the deals");
  await expect(answer).toBeVisible();
  // pi answers after the hand-off, not to the person's message.
  const order = await page.locator(".agent-reply, .assistant").allInnerTexts();
  expect(order.findIndex((text) => text.includes("ok: @pi please"))).toBeGreaterThan(order.findIndex((text) => text.includes("@relay")));
  await shot(page, "b-hand-off");
});

test("c. a shared chat: bob joins by link, and his turns only read", async () => {
  const owner = ada.page;
  sharedChat = await newChat(owner);
  await addToChat(owner, "helper");
  await send(owner, "@helper /say Welcome to the deals room.");
  await expect(agentReply(owner, "helper", "Welcome to the deals room.")).toBeVisible();

  await owner.getByRole("button", { name: "Share" }).click();
  await owner.getByRole("button", { name: "Create an invite link" }).click();
  const link = await owner.locator(".invite-link input").inputValue();
  expect(link).toMatch(/\/join\//);
  await owner.keyboard.press("Escape");

  const member = bob.page;
  await member.goto(link);
  await member.getByRole("button", { name: "Join the chat" }).click();
  await expect(member).toHaveURL(new RegExp(`/c/${sharedChat}$`));
  await expect(agentReply(member, "helper", "Welcome to the deals room.")).toBeVisible();
  await expect(owner.locator(".chat-notice", { hasText: "bob joined" })).toBeVisible();

  // bob's "@pi" gives pi a turn, which everyone sees.
  await send(member, "@pi /say Hi bob, pi here.");
  await expect(piReply(member, "Hi bob, pi here.")).toBeVisible();
  await expect(piReply(owner, "Hi bob, pi here.")).toBeVisible();

  // A turn bob gives @helper gets only read tools: the write is neither offered nor run.
  const before = (await crmState(member)).writes.length;
  await send(member, '@helper /tool crm.update_deal {"id":"d2","stage":"won"}');
  const refused = agentReply(member, "helper", /crm__update_deal failed/);
  await expect(refused).toBeVisible();
  expect((await crmState(member)).writes.length).toBe(before);
  await expect(agentReply(member, "helper", /for bob/)).toBeVisible();
  await shot(member, "c-member-refused");

  // ada's own turn may write.
  await send(owner, '@helper /tool crm.update_deal {"id":"d2","stage":"won"}');
  await expect(agentReply(owner, "helper", /crm__update_deal: \{"updated"/)).toBeVisible();
  const after = await crmState(owner);
  expect(after.writes).toHaveLength(before + 1);
  expect(after.deals.find((deal) => deal.id === "d2")?.stage).toBe("won");
  await shot(owner, "c-owner-writes");
});

test("d. chat kinds: a private chat, and one off the record", async () => {
  const { page } = ada;
  await newChat(page);
  // A new chat is private: only its owner, and pi answers every message.
  const chip = page.locator("button.kind-chip");
  await expect(chip).toHaveText(/^Private/);
  await chip.click();
  const kinds = page.getByRole("dialog", { name: "What kind of chat this is" });
  await expect(kinds.getByRole("button", { name: /^Private/ })).toHaveAttribute("aria-pressed", "true");
  await shot(page, "d-kinds-menu");
  await kinds.getByRole("button", { name: /^Off the record/ }).click();
  await expect(kinds).toContainText("nothing leaves this chat");
  await kinds.getByRole("button", { name: "Change", exact: true }).click();
  await expect(chip).toHaveText(/^Off the record/);
  // Nothing leaves a chat off the record: pi cannot keep a memory note from it.
  await send(page, '@pi /tool memory_note {"text":"Deal reviews happen on Fridays.","kind":"fact","scope":"user"}');
  await expect(piReply(page, /memory_note failed/)).toBeVisible();
  await shot(page, "d-off-record");
});

test("g. a memory note pi keeps in a private chat shows on the Memory page", async () => {
  const { page } = ada;
  await newChat(page);
  await send(page, '/tool memory_note {"text":"Ada wants the deal summary on Mondays.","kind":"preference","scope":"user"}');
  await expect(piReply(page, /memory_note: /)).toBeVisible();
  await page.getByRole("link", { name: /notes?$/ }).click();
  await expect(page.getByRole("main").getByRole("heading", { name: "Memory" })).toBeVisible();
  await expect(page.getByText("Ada wants the deal summary on Mondays.")).toBeVisible();
  await shot(page, "g-memory");
});

test("e. a scheduled run reports in its home chat, the Runs tab and the feed", async () => {
  const { page } = ada;
  const scout = await call<{ id: string }>(page, "POST", "/api/agents", {
    name: "scout",
    job: "Watches the deals at proposal",
    instructions: "1. List the deals at proposal.\n2. Say which need a nudge.",
    servers: ["crm"],
    trigger: { kind: "schedule", at: "09:00", tz: "UTC" },
    workflow: [
      { kind: "look", server: "crm", tool: "list_deals", input: { stage: "proposal" }, as: "deals" },
      { kind: "work", prompt: "/say Northwind renewal is still at proposal: 42,000 open." },
      { kind: "tell", to: ["owner"], via: "chat" },
    ],
  });
  scoutId = scout.id;
  const started = await call<{ dueAt: number; homeChatId: string }>(page, "POST", `/api/dev/agents/${scoutId}/run`, {});

  await page.goto(`/c/${started.homeChatId}`);
  const report = agentReply(page, "scout", "Northwind renewal is still at proposal");
  await expect(report).toBeVisible();
  await shot(page, "e-home-chat");

  await page.goto(`/agents/${scoutId}?tab=runs`);
  const run = page.locator(".run-row").first();
  await expect(run).toContainText("Sent");
  await expect(run).toContainText("Northwind renewal is still at proposal");
  await shot(page, "e-runs-tab");
  await run.click();
  await expect(page.getByRole("heading", { name: "What it sent" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "How it got there" })).toBeVisible();
  await shot(page, "e-run-detail");

  await page.getByRole("link", { name: /^Feed/ }).click();
  await expect(page.getByRole("main").getByRole("heading", { name: "Feed" })).toBeVisible();
  await expect(page.locator(".feed-item, li").filter({ hasText: "scout" }).first()).toBeVisible();
  await shot(page, "e-feed");
});

test("f. bob follows ada's agent and sees its post in his feed", async () => {
  const owner = ada.page;
  await owner.goto(`/c/${sharedChat}`);
  await addToChat(owner, "scout");
  await call(owner, "PATCH", `/api/chats/${sharedChat}/agents/${scoutId}`, { shared: true });

  const member = bob.page;
  // The agent's menu in the people bar opens its shared page, read-only.
  await member.goto(`/c/${sharedChat}`);
  await member.getByRole("button", { name: /^@scout,/ }).click();
  await member.getByRole("link", { name: "See how it is set up" }).click();
  await expect(member).toHaveURL(new RegExp(`/agents/${scoutId}\\?chat=${sharedChat}`));
  await expect(member.getByText("is ada’s", { exact: false })).toBeVisible();
  await member.getByRole("button", { name: "Follow" }).click();
  await expect(member.getByRole("button", { name: "Following" })).toBeVisible();
  await shot(member, "f-follow");

  await call(owner, "POST", `/api/dev/agents/${scoutId}/run`, {});
  await member.goto("/feed");
  await expect(member.getByText("@scout posted")).toBeVisible();
  await expect(member.getByText("Northwind renewal is still at proposal").first()).toBeVisible();
  await shot(member, "f-feed");
});

test("h. a run that needs a sign-in says so, and goes on once signed in", async () => {
  const { page } = ada;
  const notes = await call<{ id: string }>(page, "POST", "/api/agents", {
    name: "notes",
    job: "Reads the shared notes",
    instructions: "1. Read the notes.\n2. Say what is due.",
    servers: ["vault"],
    trigger: { kind: "schedule", at: "08:00", tz: "UTC" },
    workflow: [
      { kind: "look", server: "vault", tool: "read_notes", input: {}, as: "notes" },
      { kind: "work", prompt: "/say Two notes: the quarterly review and the renewals." },
      { kind: "tell", to: ["owner"], via: "chat" },
    ],
  });
  const started = await call<{ homeChatId: string }>(page, "POST", `/api/dev/agents/${notes.id}/run`, {});
  await page.goto(`/c/${started.homeChatId}`);
  const notice = page.locator("aside, div").filter({ has: page.getByText("Sign in to vault", { exact: true }) }).last();
  await expect(page.getByText("Sign in to vault", { exact: true })).toBeVisible();
  await expect(notice).toContainText("@notes is waiting for you to sign in");
  await shot(page, "h-sign-in-notice");

  // The stand-in approves at once: the sign-in comes back to the app, and the run goes again.
  // The link opens the sign-in in a tab of its own; the chat hears the run's reply and the sign-in over its sockets.
  const popup = page.waitForEvent("popup");
  await page.getByRole("link", { name: "Sign in" }).click();
  const signInTab = await popup;
  await signInTab.waitForLoadState();
  await expect(agentReply(page, "notes", "Two notes: the quarterly review and the renewals.")).toBeVisible();
  await expect(page.getByText("Sign in to vault", { exact: true })).toHaveCount(0);
  // Closed once done, as a person would: left open, it keeps ada's tab in the background, where the browser slows its
  // frames to about one a second and every later click waits on them.
  await signInTab.close();
  await page.bringToFront();
  await shot(page, "h-signed-in");
});

test("i. pi offers a next step, and the owner's Yes drafts it", async () => {
  const { page } = ada;
  // What pi does for the Yes, which carries no script: the owner's system prompt holds it (a line the model follows).
  const routine = {
    name: "monday-digest",
    job: "Sends the deals summary every Monday",
    instructions: "1. List the deals.\n2. Summarise them.",
    servers: ["crm"],
    trigger: { kind: "schedule", at: "09:00", tz: "UTC", days: ["mon"] },
    assumed: ["trigger"],
  };
  await call(page, "PUT", "/api/me/system-prompt", { text: propose(routine) });
  try {
    await newChat(page);
    await send(page, "/say Three deals are open, 69,000 in all.\nNext step: Send this every Monday?");
    const offer = page.getByRole("group", { name: "Offered next step" });
    await expect(offer).toContainText("Send this every Monday?");
    await expect(piReply(page, "Three deals are open")).not.toContainText("Next step:");
    await shot(page, "i-offer");
    await offer.getByRole("button", { name: "Yes" }).click();
    const card = page.getByRole("article", { name: "Agent @monday-digest" });
    await expect(card).toBeVisible();
    await expect(card).toContainText("Proposed by pi");
    await expect(card).toContainText("Mon at 09:00");
    await expect(offer.getByRole("button", { name: "Yes" })).toHaveCount(0);
    await shot(page, "i-offer-draft");
  } finally {
    await call(page, "PUT", "/api/me/system-prompt", { text: "" });
  }
});

test("i. a roster agent offers a next step, and the owner's Yes drafts it", async () => {
  const { page } = ada;
  await call(page, "POST", "/api/agents", {
    name: "planner",
    job: "Plans the recurring reports",
    // What it does for the Yes, which carries no script: its instructions hold it.
    instructions: propose({
      name: "friday-digest",
      job: "Sends the deals summary every Friday",
      instructions: "1. List the deals.",
      trigger: { kind: "schedule", at: "16:00", tz: "UTC", days: ["fri"] },
    }),
  });
  await page.goto(`/c/${agentsChat}`);
  await addToChat(page, "planner");
  await send(page, "@planner /say The pipeline grew by two deals.\nNext step: Send this every Friday?");
  const reply = agentReply(page, "planner", "The pipeline grew by two deals.");
  await expect(reply.getByRole("group", { name: "Offered next step" })).toContainText("Send this every Friday?");
  await reply.getByRole("button", { name: "Yes" }).click();
  const draftReply = agentReply(page, "planner", "Drafted the agent @friday-digest");
  await expect(draftReply).toBeVisible();
  const drafted = await call<{ name: string; enabled: boolean; origin: string }[]>(page, "GET", "/api/agents");
  expect(drafted.find((agent) => agent.name === "friday-digest")).toMatchObject({ enabled: false, origin: "agent" });
  // Its reply says "turns it on from its card": the card shows under the reply, for its owner.
  const card = draftReply.getByRole("article", { name: "Agent @friday-digest" });
  await expect(card).toContainText("Proposed by @planner");
  await card.scrollIntoViewIfNeeded();
  await shot(page, "i-agent-offer");
});

test("j. checklists: pi's and an agent's plans show as cards", async () => {
  const { page } = ada;
  await page.goto(`/c/${agentsChat}`);
  const steps = (first: string) => [
    { text: "Read the deals", status: "done" },
    { text: first, status: "doing" },
  ];
  await send(page, `/tool checklist ${JSON.stringify({ title: "Weekly deals review", steps: steps("Write the summary") })}`);
  await expect(page.getByRole("region", { name: "Plan: Weekly deals review" })).toContainText("pi's plan · 1 of 2 done");
  await send(page, `@helper /tool checklist ${JSON.stringify({ title: "Stage check", steps: steps("Flag the stuck deals") })}`);
  await expect(page.getByRole("region", { name: "Plan: Stage check" })).toContainText("@helper's plan");
  await shot(page, "j-checklists");
});

test("k. a run's write waits for the owner's approval, and one a guardrail blocks never reaches the server", async () => {
  const { page } = ada;
  const before = await crmState(page);
  // At autonomy 3 each write waits for ada; a rule blocks marking a deal lost, whatever the level.
  const closer = await call<{ id: string }>(page, "POST", "/api/agents", {
    name: "closer",
    job: "Moves the deals along",
    instructions: "1. Move Northwind to negotiation.\n2. Mark Initech lost.",
    servers: ["crm"],
    trigger: { kind: "schedule", at: "10:00", tz: "UTC" },
    autonomy: 3,
    guardrails: [
      { id: "nolost", server: "crm", tool: "update_deal", arg: "stage", kind: "never", value: ["lost"], effect: "block", note: "People mark deals lost." },
    ],
    workflow: [
      { kind: "do", server: "crm", tool: "update_deal", input: { id: "d1", stage: "negotiation" } },
      { kind: "do", server: "crm", tool: "update_deal", input: { id: "d3", stage: "lost" } },
      // After the blocked step: never reached.
      { kind: "work", prompt: "/say Both deals moved." },
      { kind: "tell", to: ["owner"], via: "chat" },
    ],
  });
  const started = await call<{ homeChatId: string }>(page, "POST", `/api/dev/agents/${closer.id}/run`, {});

  // The call waits, as a card in the run's chat and in the feed's Needs you; nothing reached the server yet.
  await page.goto(`/c/${started.homeChatId}`);
  const card = page.getByRole("article", { name: "@closer asks to crm.update_deal" });
  await expect(card).toContainText("negotiation");
  await expect(card.getByRole("button", { name: "Approve" })).toBeVisible();
  await shot(page, "k-approval-card");
  expect((await crmState(page)).writes).toHaveLength(before.writes.length);

  await page.goto("/feed");
  await page.getByRole("tab", { name: /^Needs you/ }).click();
  const item = page.locator(".feed-item").filter({ hasText: 'crm.update_deal {"id":"d1","stage":"negotiation"}' });
  await expect(item).toBeVisible();
  await shot(page, "k-needs-you");
  await item.getByRole("button", { name: "Approve" }).click();

  // The server got exactly the stored call, once; the run went on to the blocked step, which never reached it and
  // stopped the item there: the run is blocked, never "Sent", and nothing after the step ran or went out.
  await page.goto(`/agents/${closer.id}?tab=runs`);
  const run = page.locator(".run-row").first();
  await expect(run).toContainText("Blocked");
  await expect(run).toContainText("Blocked: crm.update_deal was refused");
  await expect(run).not.toContainText("Sent");
  await expect(run).not.toContainText("Acted on");
  await run.click();
  await expect(page.getByRole("heading", { name: "How it got there" })).toBeVisible();
  await expect(page.locator(".run-detail .form-error")).toContainText(/Blocked: crm\.update_deal was refused: Not run: a rule blocks it.*People mark deals lost/);
  await expect(page.getByText("Nothing: no item got to a step that sends.")).toBeVisible();
  const after = await crmState(page);
  expect(after.writes).toEqual([...before.writes, { tool: "update_deal", input: { id: "d1", stage: "negotiation" } }]);
  expect(after.deals.find((deal) => deal.id === "d3")?.stage).toBe(before.deals.find((deal) => deal.id === "d3")?.stage);
  await shot(page, "k-run-blocked");

  await page.goto(`/c/${started.homeChatId}`);
  await expect(card).toContainText("Ran");
  await expect(card.getByRole("button", { name: "Approve" })).toHaveCount(0);
  await expect(agentReply(page, "closer", "Both deals moved.")).toHaveCount(0);
});

test("l. bob brings his own agents to ada's shared chat: his turns write, hers only read, his drafts and approvals are his", async () => {
  const owner = ada.page;
  const member = bob.page;
  // bob's agents, from his own account: clerk asks him before marking a deal lost; scribe reads a server it does not
  // share with chats, and bob reviews its replies before they are posted.
  await call(member, "POST", "/api/agents", {
    name: "clerk",
    job: "Updates the deals for bob",
    instructions: "Update the deals bob names.",
    servers: ["crm"],
    guardrails: [{ id: "asklost", server: "crm", tool: "update_deal", arg: "stage", kind: "never", value: ["lost"], effect: "approve" }],
  });
  await call(member, "POST", "/api/agents", {
    name: "scribe",
    job: "Writes up the deals for bob",
    instructions: "Summarise the deals.",
    servers: ["crm"],
    sharedServers: [],
    reviewBeforePosting: true,
  });
  await owner.goto(`/c/${sharedChat}`);
  await member.goto(`/c/${sharedChat}`);
  await addToChat(member, "clerk");
  await addToChat(member, "scribe");
  await expect(owner.locator(".chat-notice", { hasText: "added @clerk to the chat" })).toBeVisible();

  // bob's own turn runs in his own account and may write.
  const before = (await crmState(member)).writes.length;
  await send(member, '@clerk /tool crm.update_deal {"id":"d2","stage":"negotiation"}');
  await expect(agentReply(member, "clerk", /crm__update_deal: \{"updated"/)).toBeVisible();
  await expect(agentReply(owner, "clerk", /crm__update_deal: \{"updated"/)).toBeVisible();
  expect((await crmState(member)).writes.slice(before)).toEqual([{ tool: "update_deal", input: { id: "d2", stage: "negotiation" } }]);

  // ada's turn on bob's agent only reads: the write is neither offered nor run.
  await send(owner, '@clerk /tool crm.update_deal {"id":"d2","stage":"won"}');
  await expect(agentReply(owner, "clerk", /crm__update_deal failed/)).toBeVisible();
  expect((await crmState(owner)).writes).toHaveLength(before + 1);
  await shot(owner, "l-owner-read-only");

  // A write bob's rule holds: the card shows to bob alone, and his Approve runs the stored call.
  await send(member, '@clerk /tool crm.update_deal {"id":"d3","stage":"lost"}');
  const held = member.getByRole("article", { name: "@clerk asks to crm.update_deal" });
  await expect(held).toContainText("lost");
  await expect(held.getByRole("button", { name: "Approve" })).toBeVisible();
  // ada sees clerk's reply to it (its third), not the card.
  await expect(owner.locator(".agent-reply").filter({ has: owner.getByText("@clerk", { exact: true }) })).toHaveCount(3);
  await expect(owner.getByRole("article", { name: "@clerk asks to crm.update_deal" })).toHaveCount(0);
  await shot(member, "l-member-approval");
  expect((await crmState(member)).writes).toHaveLength(before + 1);
  await held.getByRole("button", { name: "Approve" }).click();
  // Once it ran, its card gives way to an outcome line, for bob alone.
  await expect(held).toHaveCount(0);
  const outcome = member.getByLabel("Ran: @clerk crm.update_deal, only you see this");
  await expect(outcome).toContainText("Ran · @clerk crm.update_deal");
  await expect(owner.locator(".action-outcome")).toHaveCount(0);
  await shot(member, "l-member-outcome");
  expect((await crmState(member)).writes.slice(before + 1)).toEqual([{ tool: "update_deal", input: { id: "d3", stage: "lost" } }]);

  // scribe's reply read a server bob does not share: a draft only he sees until he posts it, edited.
  await send(member, '@scribe /tool crm.list_deals {"stage":"won"}');
  const draft = member.getByLabel("Draft reply of @scribe, only you can see it");
  await expect(draft).toContainText("crm__list_deals");
  for (const action of ["Post to chat", "Edit", "Discard"]) await expect(draft.getByRole("button", { name: action })).toBeVisible();
  await shot(member, "l-member-draft");
  await expect(agentReply(owner, "scribe", /./)).toHaveCount(0);
  await draft.getByRole("button", { name: "Edit" }).click();
  await draft.getByLabel("Edit the reply before posting it").fill("No deal is won right now.");
  await draft.getByRole("button", { name: "Post to chat" }).click();
  await expect(draft).toHaveCount(0);
  await expect(agentReply(owner, "scribe", "No deal is won right now.")).toBeVisible();
  await expect(agentReply(member, "scribe", "No deal is won right now.")).toBeVisible();
});

test("m. agents speak up after a pause in the chat, and a muted one does not", async () => {
  const { page } = ada;
  // Two agents that may speak up, both close to what the chat is about. On the scripted model the interest stage scores
  // by the words two texts share (worker/dev-model.ts): tracker is the closer, dispatch is past the threshold too.
  const agents = [
    { name: "tracker", job: "Shipping delays at the warehouse", instructions: "/say Shipping delays at the warehouse: two orders are past due." },
    { name: "dispatch", job: "Warehouse shipping", instructions: "/say Noted: warehouse shipping." },
  ];
  for (const agent of agents) await call(page, "POST", "/api/agents", { ...agent, speaksUp: true });
  await newChat(page);
  await addToChat(page, "tracker");
  await addToChat(page, "dispatch");
  await page.getByRole("button", { name: "Agents in this chat" }).click();
  const settings = page.getByRole("dialog", { name: "Add agents to this chat" });
  // Checked once the chat has saved it.
  const speakUp = settings.getByRole("checkbox", { name: /Let agents speak up/ });
  await speakUp.click();
  await expect(speakUp).toBeChecked();
  await settings.getByRole("button", { name: "Close" }).click();

  // Muted here, tracker stays quiet though it is the closer: dispatch is the one that speaks up after the pause.
  const toggleMute = async (name: string, mute: boolean) => {
    await page.getByRole("button", { name: new RegExp(`^@${name},`) }).click();
    const menu = page.getByRole("dialog", { name: `@${name}` });
    await menu.getByRole("button", { name: mute ? "Mute here" : "Unmute here" }).click();
    await expect(menu.getByRole("button", { name: mute ? "Unmute here" : "Mute here" })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(menu).toBeHidden();
  };
  await toggleMute("tracker", true);
  await send(page, "Shipping delays at the warehouse");
  const dispatchPost = agentReply(page, "dispatch", "Noted: warehouse shipping.");
  await expect(dispatchPost).toBeVisible();
  await expect(dispatchPost.locator(".mute-row")).toContainText("Nobody asked");
  await expect(page.locator(".agent-reply").filter({ has: page.getByText("@tracker", { exact: true }) })).toHaveCount(0);

  // Unmuted, it speaks up after the next pause (dispatch waits out its cooldown); its post can mute it again.
  await toggleMute("tracker", false);
  await send(page, "More shipping delays at the warehouse");
  const trackerPost = agentReply(page, "tracker", "two orders are past due");
  await expect(trackerPost).toBeVisible();
  await expect(trackerPost.locator(".mute-row")).toContainText("Nobody asked");
  await shot(page, "m-speak-up");
  await trackerPost.getByRole("button", { name: "Mute @tracker here" }).click();
  await expect(trackerPost).toContainText("@tracker won't speak up unasked here again.");
  await expect(agentReply(page, "dispatch", /./)).toHaveCount(1);
});

/** One stage of the speak-up funnel, as a chat kept it (DEV_TOOLS: GET /api/dev/chats/:id/funnel). */
type FunnelStage = { agent: string; stage: "gates" | "interest" | "turn"; passed: boolean; refusal?: string; score?: number; at: number };

/** The first stage of `agentId`'s in `chatId` since `since` (epoch ms) that `match` takes, once the chat has kept one. */
async function weighed(page: Page, chatId: string, agentId: string, since: number, match: (stage: FunnelStage) => boolean): Promise<FunnelStage> {
  let found: FunnelStage | undefined;
  await expect
    .poll(async () => {
      const stages = await call<FunnelStage[]>(page, "GET", `/api/dev/chats/${chatId}/funnel`);
      found = stages.find((stage) => stage.agent === agentId && stage.at >= since && match(stage));
      return found !== undefined;
    })
    .toBe(true);
  return found!;
}

/** The owner lets agents speak up in the open chat, from its agent settings, and sets `limits` there (label: value). */
async function letSpeakUp(page: Page, limits: Record<string, string> = {}): Promise<void> {
  await page.getByRole("button", { name: "Agents in this chat" }).click();
  const settings = page.getByRole("dialog", { name: "Add agents to this chat" });
  const speakUp = settings.getByRole("checkbox", { name: /Let agents speak up/ });
  await speakUp.click();
  await expect(speakUp).toBeChecked();
  for (const [label, value] of Object.entries(limits)) {
    const form = settings.locator("form").filter({ hasText: label });
    await form.getByLabel(label).fill(value);
    await form.getByRole("button", { name: "Save" }).click();
    await expect(form.getByRole("button", { name: "Save" })).toBeDisabled();
  }
  await settings.getByRole("button", { name: "Close" }).click();
}

test("n. speaking-up limits: the stricter of the chat's and the agent's holds, and a PASS raises its bar", async () => {
  const { page } = ada;
  const PER_MESSAGES = "One post per this many messages";
  // ada's own limit for courier (one post per 3 messages) is stricter than the one she sets for the chat (per 2).
  const courier = await call<{ id: string }>(page, "POST", "/api/agents", {
    name: "courier",
    job: "Parcel route updates",
    instructions: "/say Courier note: parcel route checked.",
    speaksUp: true,
  });
  await page.goto(`/agents/${courier.id}`);
  await page.getByLabel(PER_MESSAGES).fill("3");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByRole("button", { name: "Save", exact: true })).toBeDisabled();
  const chat = await newChat(page);
  await addToChat(page, "courier");
  await letSpeakUp(page, { [PER_MESSAGES]: "2" });

  const posts = page.locator(".agent-reply").filter({ has: page.getByText("@courier", { exact: true }) });
  // Its first post needs no messages before it; after it, the second and third messages are not enough for its own
  // limit (they would be for the chat's), and the fourth is.
  let since = Date.now();
  await send(page, "Parcel route");
  await expect(posts).toHaveCount(1);
  for (let i = 0; i < 2; i++) {
    since = Date.now();
    await send(page, "Parcel route");
    await weighed(page, chat, courier.id, since, (stage) => stage.refusal === "messages");
    await expect(posts).toHaveCount(1);
  }
  await send(page, "Parcel route");
  await expect(posts).toHaveCount(2);
  await expect(posts.last()).toContainText("Courier note: parcel route checked.");
  await shot(page, "n-limits");

  // sentry answers PASS when it is given a turn: nothing is posted, and its bar goes up in this chat, so the same
  // conversation, which reached it the first time, no longer does. On the scripted model the interest is the words two
  // texts share (worker/dev-model.ts): 0.577 for these, past the threshold (0.55), not past it raised by a PASS (0.58).
  const sentry = await call<{ id: string }>(page, "POST", "/api/agents", {
    name: "sentry",
    job: "Pallet audit night watcher",
    instructions: "/say PASS",
    speaksUp: true,
    speakUpLimits: { perMessages: 1 },
  });
  const quiet = await newChat(page);
  await addToChat(page, "sentry");
  await letSpeakUp(page);
  since = Date.now();
  await send(page, "Pallet audit");
  const first = await weighed(page, quiet, sentry.id, since, (stage) => stage.stage === "interest");
  expect(first).toMatchObject({ passed: true });
  expect(first.score).toBeGreaterThanOrEqual(0.55);
  await weighed(page, quiet, sentry.id, since, (stage) => stage.stage === "turn");
  // Its turn ends with PASS: nothing posted.
  await expect
    .poll(async () => {
      const { turns } = await call<{ turns: Record<string, { status: string }[]> }>(page, "GET", `/api/chats/${quiet}/agents`);
      return turns[sentry.id]?.[0]?.status;
    })
    .toBe("done");
  since = Date.now();
  await send(page, "Pallet audit");
  const again = await weighed(page, quiet, sentry.id, since, (stage) => stage.stage === "interest");
  expect(again).toMatchObject({ passed: false, score: first.score });
  await expect(page.locator(".agent-reply").filter({ has: page.getByText("@sentry", { exact: true }) })).toHaveCount(0);
});

test("o. an agent learns overnight: in use with why, facts to confirm, nothing from what it never read, nothing off the record", async () => {
  const { page } = ada;
  const research = await call<{ id: string }>(page, "POST", "/api/agents", { name: "research", job: "Looks the deals up", instructions: "Answer about the deals." });
  // A private chat: research answers, and ada replies to it with a correction (a "corrected" signal).
  await newChat(page);
  await addToChat(page, "research");
  await send(page, "@research /say Three deals are open.");
  const answer = agentReply(page, "research", "Three deals are open.");
  await expect(answer).toBeVisible();
  await answer.hover();
  await answer.getByRole("button", { name: "Reply" }).click();
  await send(page, "No, that's wrong: only the won deals.");
  await expect(agentReply(page, "research", "ok: [Replying to research")).toBeVisible();

  // Its dream, with the model's answer scripted (DEV_TOOLS): a wide preference and a fact citing what it read, and a
  // note citing a chat it never read. Where each goes is the app's to decide (placeDreamNote).
  const dream = (notes: object[]) => JSON.stringify({ summary: "Learned to keep to the won deals.", notes, retire: [] });
  const learned = "Lists only the won deals unless asked for more.";
  const fact = "The pipeline review is on Fridays.";
  const madeUp = "Always copy the finance team.";
  const record = await call<{ status: string; learned: string[]; waiting: string[] }>(page, "POST", "/api/dev/dream", {
    subject: research.id,
    answer: dream([
      { text: learned, kind: "preference", scope: "wide", cites: ["c0.s0", "c0.s1"], why: "corrected to the won deals", confidence: 0.9 },
      { text: fact, kind: "fact", scope: "wide", cites: ["c0.s1"], why: "said in passing", confidence: 0.8 },
      { text: madeUp, kind: "preference", scope: "wide", cites: ["c5.s0"], why: "never said", confidence: 0.9 },
    ]),
  });
  expect(record).toMatchObject({ status: "dreamt" });
  // One in use at once (the preference), one waiting (the fact); the third cites nothing it read and is not kept.
  expect(record.learned).toHaveLength(1);
  expect(record.waiting).toHaveLength(1);

  // The fact waits in Needs you, as "Learned"; it opens research's Knows tab.
  await page.goto("/feed");
  await page.getByRole("tab", { name: /^Needs you/ }).click();
  const item = page.locator(".feed-item").filter({ hasText: "@research learned something overnight to confirm" });
  await expect(item).toContainText("Learned");
  await shot(page, "o-needs-you");
  await item.getByRole("link").first().click();
  await expect(page).toHaveURL(new RegExp(`/agents/${research.id}\\?tab=knows`));
  const overnight = page.getByRole("region", { name: "Learned overnight" });
  const note = (text: string) => overnight.locator("li").filter({ hasText: text });
  await expect(note(learned)).toContainText("corrected to the won deals");
  await expect(note(learned)).not.toContainText("To confirm");
  await expect(note(fact)).toContainText("To confirm");
  await expect(note(fact)).toContainText("Fact");
  await expect(page.getByText(madeUp)).toHaveCount(0);
  // It just dreamt: Dream now waits.
  await expect(overnight.getByRole("button", { name: "Dream now" })).toBeDisabled();
  await shot(page, "o-knows");

  // Keep: the fact is in use, and Needs you has nothing left of it.
  await note(fact).getByRole("button", { name: "Keep" }).click();
  await expect(note(fact)).not.toContainText("To confirm");
  await page.goto("/feed");
  await page.getByRole("tab", { name: /^Needs you/ }).click();
  await expect(page.locator(".feed-item").filter({ hasText: "@research learned something overnight to confirm" })).toHaveCount(0);

  // Forget it, then bring it back from the forgotten notes.
  await page.goto(`/agents/${research.id}?tab=knows`);
  await note(learned).getByRole("button", { name: "Forget" }).click();
  await expect(note(learned)).toHaveCount(0);
  await page.goto("/memory");
  await page.getByRole("button", { name: /^Show forgotten/ }).click();
  await page.locator("li.memory-note").filter({ hasText: learned }).getByRole("button", { name: "Bring back" }).click();
  await page.goto(`/agents/${research.id}?tab=knows`);
  await expect(note(learned)).toBeVisible();

  type Note = { text: string; scope: string; chatId?: string; agentId?: string; confirmed: boolean };
  const notes = async () => (await call<{ notes: Note[] }>(page, "GET", "/api/memory")).notes;

  // In the chat ada shares with bob: what is learned there stays with that chat, and a lesson for everywhere waits.
  const minutes = await call<{ id: string }>(page, "POST", "/api/agents", { name: "minutes", job: "Keeps the meeting notes", instructions: "Note what was said." });
  await page.goto(`/c/${sharedChat}`);
  await addToChat(page, "minutes");
  await send(page, "@minutes /say Noted the agenda.");
  await expect(agentReply(page, "minutes", "Noted the agenda.")).toBeVisible();
  const here = "Keeps the agenda notes short in this chat.";
  const lesson = "Ends a note with the next step.";
  expect(
    await call(page, "POST", "/api/dev/dream", {
      subject: minutes.id,
      answer: dream([
        { text: here, kind: "preference", scope: "chat", cites: ["c0.s0"], why: "the room's habit", confidence: 0.9 },
        { text: lesson, kind: "preference", scope: "wide", cites: ["c0.s0"], why: "a way of working", confidence: 0.9 },
      ]),
    }),
  ).toMatchObject({ status: "dreamt" });
  const kept = await notes();
  expect(kept.find((one) => one.text === here)).toMatchObject({ scope: "chat", chatId: sharedChat });
  expect(kept.find((one) => one.text === lesson)).toMatchObject({ scope: "agent", agentId: minutes.id, confirmed: false });

  // Off the record: nothing is recorded, so the dream has nothing to learn from and keeps nothing.
  const ghost = await call<{ id: string }>(page, "POST", "/api/agents", { name: "ghost", job: "Answers off the record", instructions: "Answer briefly." });
  await newChat(page);
  const chip = page.locator("button.kind-chip");
  await chip.click();
  const kinds = page.getByRole("dialog", { name: "What kind of chat this is" });
  await kinds.getByRole("button", { name: /^Off the record/ }).click();
  await kinds.getByRole("button", { name: "Change", exact: true }).click();
  await expect(chip).toHaveText(/^Off the record/);
  await addToChat(page, "ghost");
  await send(page, "@ghost /say Kept here only.");
  await expect(agentReply(page, "ghost", "Kept here only.")).toBeVisible();
  const offRecord = await call<{ status: string; learned: string[] }>(page, "POST", "/api/dev/dream", {
    subject: ghost.id,
    answer: dream([{ text: "Answers in one line.", kind: "preference", scope: "wide", cites: ["c0.s0"], why: "off the record", confidence: 0.9 }]),
  });
  expect(offRecord).toMatchObject({ status: "quiet", learned: [] });
  expect((await notes()).filter((one) => one.agentId === ghost.id)).toEqual([]);
});

test("p. a member sees only what a shared agent's runs posted in their chat; Make, the allowance ring and run groups", async () => {
  const owner = ada.page;
  const member = bob.page;
  // A run that reads crm and posts its digest in the chat ada shares with bob, where she shares the agent.
  const digest = await call<{ id: string }>(owner, "POST", "/api/agents", {
    name: "digest",
    job: "Posts the weekly digest in the deals room",
    instructions: "1. List the deals.\n2. Post the digest in the deals room.",
    servers: ["crm"],
    trigger: { kind: "schedule", at: "08:30", tz: "UTC" },
    workflow: [
      { kind: "look", server: "crm", tool: "list_deals", input: {}, as: "deals" },
      { kind: "work", prompt: "/say Weekly digest: three deals are open." },
      { kind: "tell", to: [sharedChat], via: "chat" },
    ],
  });
  await owner.goto(`/c/${sharedChat}`);
  await addToChat(owner, "digest");
  await call(owner, "PATCH", `/api/chats/${sharedChat}/agents/${digest.id}`, { shared: true });
  await call(owner, "POST", `/api/dev/agents/${digest.id}/run`, {});
  await expect(agentReply(owner, "digest", "Weekly digest: three deals are open.")).toBeVisible();

  // bob, from the chat: the run's post, and only that.
  await member.goto(`/agents/${digest.id}?chat=${sharedChat}&tab=runs`);
  await expect(member.getByText("The runs that posted in", { exact: false })).toBeVisible();
  const row = member.locator(".run-row").first();
  await expect(row).toContainText("Weekly digest: three deals are open.");
  await row.click();
  await expect(member.getByText("Only ada sees how a run got there", { exact: false })).toBeVisible();
  await expect(member.locator(".run-items")).toHaveCount(0);
  await expect(member.getByText(/Look at crm\.list_deals/)).toHaveCount(0);
  await shot(member, "p-member-run");
  // ada sees all of it.
  await owner.goto(`/agents/${digest.id}?tab=runs`);
  await owner.locator(".run-row").first().click();
  await expect(owner.getByText(/Look at crm\.list_deals/).first()).toBeVisible();

  // The composer's Make, on Auto: "every morning…" reads as an agent to draft; a question about last week does not.
  const page = owner;
  await newChat(page);
  await expect(page.getByRole("button", { name: "Make: Auto" })).toBeVisible();
  await send(page, "Every morning, the deals.");
  await expect(piReply(page, "This reads as something to run on its own")).toBeVisible();
  await send(page, "What were the deals every day last week?");
  const past = piReply(page, "What were the deals every day last week?");
  await expect(past).toBeVisible();
  await expect(past).not.toContainText("This reads as something to run on its own");
  // pi follows the line with agent_propose (here from the owner's system prompt, the scripted model's way): a draft.
  await call(page, "PUT", "/api/me/system-prompt", {
    text: propose({
      name: "morning-deals",
      job: "Lists the deals at proposal every morning",
      instructions: "1. List the deals at proposal.",
      servers: ["crm"],
      trigger: { kind: "schedule", at: "08:00", tz: "UTC" },
    }),
  });
  try {
    await send(page, "Every morning, list the deals at proposal.");
    await expect(page.getByRole("article", { name: "Agent @morning-deals" })).toContainText("Proposed by pi");
    await shot(page, "p-make-auto");
  } finally {
    await call(page, "PUT", "/api/me/system-prompt", { text: "" });
  }

  // The allowance ring beside the context ring, and its panel.
  const ring = page.getByRole("button", { name: /^Today's allowance: \$[\d.]+ of \$5\.00/ });
  await expect(ring).toBeVisible();
  await ring.click();
  const allowance = page.getByRole("dialog", { name: "Today's allowance" });
  await expect(allowance).toContainText("of $5.00");
  await expect(allowance).toContainText("tokens");
  await shot(page, "p-allowance");
  await page.keyboard.press("Escape");
  await expect(allowance).toBeHidden();

  // A scoped run's detail groups its items: two acted on, one a rule blocked, with the rule's reason.
  const sweeper = await call<{ id: string }>(page, "POST", "/api/agents", {
    name: "sweeper",
    job: "Saves each deal's stage again",
    instructions: "For each deal, save its stage again.",
    servers: ["crm"],
    trigger: { kind: "schedule", at: "11:00", tz: "UTC" },
    autonomy: 4,
    guardrails: [{ id: "nod2", server: "crm", tool: "update_deal", arg: "id", kind: "never", value: ["d2"], effect: "block", note: "Globex is frozen." }],
    scope: { list: { kind: "look", server: "crm", tool: "list_deals", input: {} }, each: true },
    workflow: [{ kind: "do", server: "crm", tool: "update_deal", input: { id: "{{item.id}}", stage: "{{item.stage}}" } }],
  });
  await call(page, "POST", `/api/dev/agents/${sweeper.id}/run`, {});
  await page.goto(`/agents/${sweeper.id}?tab=runs`);
  const run = page.locator(".run-row").first();
  await expect(run).toContainText("2 of 3 acted · 1 blocked, not acted on");
  await run.click();
  const acted = page.getByRole("region", { name: /^Acted on/ });
  const blocked = page.getByRole("region", { name: /^Blocked/ });
  await expect(acted).toContainText("2 of 3");
  await expect(acted).toContainText("Northwind renewal");
  await expect(blocked).toContainText("Globex pilot");
  await expect(blocked).toContainText(/crm\.update_deal was refused: Not run: a rule blocks it: id of crm\.update_deal is "d2"/);
  await shot(page, "p-run-groups");
});
