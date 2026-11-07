// The agents feature end to end, as an owner (ada) and someone she invites (bob) use it, on the scripted model: each
// message carries the script its agent follows (/say, /tool: worker/dev-model.ts). The flows run in order and build on
// each other; each ends on a screenshot in e2e/screens/.

import { expect, test } from "@playwright/test";
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
  ada = await signIn(browser, "ada");
  bob = await signIn(browser, "bob");
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
  const [popup] = await Promise.all([page.waitForEvent("popup").catch(() => null), page.getByRole("link", { name: "Sign in" }).click()]);
  const signedIn = popup ?? page;
  await signedIn.waitForLoadState();
  await page.goto(`/c/${started.homeChatId}`);
  await expect(agentReply(page, "notes", "Two notes: the quarterly review and the renewals.")).toBeVisible();
  await expect(page.getByText("Sign in to vault", { exact: true })).toHaveCount(0);
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

test.skip("limits and approvals (do steps waiting for the owner): in an open PR (#113), not on feat/agents yet", () => {});
test.skip("members' own agents in a shared chat: in an open PR (#110), not on feat/agents yet", () => {});
test.skip("agents speaking up unprompted: needs INTEREST_MODEL (Workers AI embeddings), which PI_OFFLINE=1 leaves empty", () => {});
