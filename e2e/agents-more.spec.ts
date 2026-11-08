// More of the agents feature end to end, on the scripted model (worker/dev-model.ts): turn order, pi in a chain, the
// budget per message, page authors, chat_history, and a member's agent's seat cleaned up when it leaves a room. Its own
// people (eve, the owner, and finn, whom she invites) and agents, so it runs on its own or after e2e/agents.spec.ts.
// /for gives each agent a message names its own part of the script; /recall answers with what the agent read before
// its turn, which shows what reached it and when. Screenshots land in e2e/screens/more-*.png.

import { expect, test, type Page } from "@playwright/test";
import { addToChat, agentReply, call, newChat, piReply, send, shot, signIn, type Person } from "./app.ts";

test.describe.configure({ mode: "serial" });

let eve: Person;
let finn: Person;
/** eve's room she shares with finn (flows 4 and 6). */
let room: string;

/** An agent of the person on `page`, made through the app's API, on. */
async function agent(page: Page, name: string, job: string, more: Record<string, unknown> = {}): Promise<void> {
  await call(page, "POST", "/api/agents", { name, job, instructions: "Answer what you are asked, briefly.", ...more });
}

/** The texts of the replies in the open chat, in their order: pi's and the agents'. */
function replies(page: Page): Promise<string[]> {
  return page.locator(".agent-reply, .assistant").allInnerTexts();
}

/** The titles of the artifacts on `page`'s person's list (the sidebar's "Yours"). */
async function artifactTitles(page: Page): Promise<string[]> {
  return (await call<{ title: string }[]>(page, "GET", "/api/artifacts")).map((artifact) => artifact.title);
}

test.beforeAll(async ({ browser }) => {
  [eve, finn] = await Promise.all([signIn(browser, "eve"), signIn(browser, "finn")]);
  const { page } = eve;
  await agent(page, "alpha", "Finds the numbers", { instructions: "/pad 48000 @beta over to you" });
  await agent(page, "beta", "Checks what alpha found");
  await agent(page, "research", "Finds and checks data");
  await agent(page, "builder", "Builds on what pi plans");
  await agent(page, "historian", "Remembers what was said");
  // Two agents that write long replies, in turn: each person may give one agent 10 turns a minute (AGENT_TURNS).
  await agent(page, "pad-one", "Writes long replies");
  await agent(page, "pad-two", "Writes long replies too");
});

test("1. two agents named in one message answer in order, the second after the first's reply", async () => {
  const { page } = eve;
  await newChat(page);
  await addToChat(page, "alpha");
  await addToChat(page, "beta");
  // beta answers with the newest line from alpha it read before its turn: there only if alpha's reply came first.
  await send(page, "@alpha @beta /for alpha /say Alpha found 41 rows. /for beta /recall alpha · agent");
  await expect(agentReply(page, "alpha", "Alpha found 41 rows.")).toBeVisible();
  await expect(agentReply(page, "beta", "recalled: [alpha · agent]: Alpha found 41 rows.")).toBeVisible();
  const order = await replies(page);
  expect(order.findIndex((text) => text.includes("recalled:"))).toBeGreaterThan(order.findIndex((text) => text.includes("Alpha found 41 rows.")));
  await shot(page, "more-1-turn-order");
});

test("2. pi takes its place in a chain: after research, and before builder", async () => {
  const { page } = eve;
  await addToChat(page, "research");
  await addToChat(page, "builder");
  // "@research … @pi": pi answers after research, with research's reply in what it read.
  await send(page, "@research @pi /for research /say Research: Q3 has 41,200 signups. /for pi /recall research · agent");
  await expect(agentReply(page, "research", "Research: Q3 has 41,200 signups.")).toBeVisible();
  await expect(piReply(page, "recalled: [research · agent]: Research: Q3 has 41,200 signups.")).toBeVisible();
  // "@pi … @builder": builder waits for pi's answer, and read it.
  await send(page, "@pi @builder /for pi /say Pi: the plan is ready. /for builder /recall pi · agent");
  // Anchored: builder's reply quotes pi's line too.
  await expect(piReply(page, /^Pi: the plan is ready\./)).toBeVisible();
  await expect(agentReply(page, "builder", "recalled: [pi · agent]: Pi: the plan is ready.")).toBeVisible();
  const order = await replies(page);
  expect(order.findIndex((text) => text.includes("recalled: [pi · agent]"))).toBeGreaterThan(order.findIndex((text) => text.includes("Pi: the plan is ready.")));
  await shot(page, "more-2-pi-in-chain");
});

test("3. a low budget per message stops a chain of hand-offs, naming who did not get a turn", async () => {
  const { page } = eve;
  await newChat(page);
  await addToChat(page, "alpha");
  await addToChat(page, "beta");
  await page.getByRole("button", { name: "Agents in this chat" }).click();
  const panel = page.getByRole("dialog", { name: "Add agents to this chat" });
  const budget = panel.locator("form.agent-budget").filter({ hasText: "Token budget per message" });
  await budget.getByRole("textbox").fill("10000");
  await budget.getByRole("button", { name: "Save" }).click();
  await expect(budget.getByRole("button", { name: "Save" })).toBeDisabled();
  await panel.getByRole("button", { name: "Close" }).click();
  // alpha's instructions: a long reply (about 12,000 tokens) that hands on to @beta.
  await send(page, "@alpha go");
  await expect(agentReply(page, "alpha", "@beta over to you")).toBeVisible();
  await expect(page.getByText("so @beta did not get its turn")).toBeVisible();
  await expect(page.getByText("past its budget of 10,000")).toBeVisible();
  await expect(agentReply(page, "beta", /./)).toHaveCount(0);
  await shot(page, "more-3-budget");
});

test("4. a member's agent reads the owner's page, may not publish over it, and publishes a new one", async () => {
  const owner = eve.page;
  room = await newChat(owner);
  await owner.getByRole("button", { name: "Share" }).click();
  await owner.getByRole("button", { name: "Create an invite link" }).click();
  const link = await owner.locator(".invite-link input").inputValue();
  await owner.keyboard.press("Escape");
  const member = finn.page;
  await member.goto(link);
  await member.getByRole("button", { name: "Join the chat" }).click();
  await expect(member).toHaveURL(new RegExp(`/c/${room}$`));

  const page = await call<{ artifactId: string }>(owner, "POST", `/api/dev/chats/${room}/publish`, { title: "Signups", html: "Eve signups by region, week 34" });
  await agent(member, "scout", "Builds pages for finn", { servers: ["crm"] });
  await addToChat(member, "scout");

  // Anyone may read a page posted in the chat.
  await send(member, `@scout /tool artifact_read {"artifact_id":"${page.artifactId}"}`);
  await expect(agentReply(member, "scout", /artifact_read: Version 1 of 1/)).toContainText("Eve signups by region");

  // A new page goes; a new version of eve's page is refused, with what to do instead.
  await send(
    member,
    [
      "@scout",
      '/tool artifact_write {"html":"Finn plan for the West launch"}',
      '/tool artifact_publish {"title":"Finn plan","draft_id":"{{draft}}","new_artifact":true}',
      '/tool artifact_write {"html":"Eve signups, changed by finn"}',
      `/tool artifact_publish {"title":"Signups","draft_id":"{{draft}}","artifact_id":"${page.artifactId}"}`,
    ].join("\n"),
  );
  const refused = agentReply(member, "scout", /artifact_publish failed: .*Not published: artifact \w+ \("Signups"\) is a page another person/);
  await expect(refused).toBeVisible();
  await expect(refused).toContainText("Finn plan");
  await expect(agentReply(owner, "scout", /artifact_publish failed/)).toContainText("Finn plan");
  expect(await artifactTitles(member)).toContain("Finn plan");
  // eve's page is as it was: one version.
  const meta = await call<{ latest: number }>(owner, "GET", `/api/artifacts/${page.artifactId}`);
  expect(meta.latest).toBe(1);
  await shot(member, "more-4-page-authors");
});

test("5. an agent finds an early message beyond its catch-up with chat_history", async () => {
  const { page } = eve;
  await newChat(page);
  await addToChat(page, "pad-one");
  await addToChat(page, "pad-two");
  await addToChat(page, "historian");
  // pi answers it: a chat with nobody else in it.
  await send(page, "The code word is PLUM.");
  await expect(piReply(page, "ok: The code word is PLUM.")).toBeVisible();
  // Ten long replies after it fill an agent's catch-up (60,000 characters, 6,000 of each message).
  for (let i = 1; i <= 10; i++) {
    const padder = i % 2 ? "pad-one" : "pad-two";
    await send(page, `@${padder} /pad 6500 Part ${i}.`);
    await expect(agentReply(page, padder, `Part ${i}.`)).toBeVisible();
  }
  // What historian read before its turn has no code word in it.
  await send(page, "@historian /recall code word");
  await expect(agentReply(page, "historian", 'recalled nothing for "code word"')).toBeVisible();
  // chat_history finds it ("\\u0020": the search's text is not in this message itself).
  await send(page, '@historian /tool chat_history {"text":"word\\u0020is","author":"eve"}');
  const found = agentReply(page, "historian", /chat_history: 1 entry of the chat matching "word is" by eve/);
  await expect(found).toBeVisible();
  await expect(found).toContainText("[eve · person · your owner]: The code word is PLUM.");
  await shot(page, "more-5-chat-history");
});

test("6. a member removes their agent from the room: its posted reply stays, its unposted page goes", async () => {
  const owner = eve.page;
  const member = finn.page;
  await owner.goto(`/c/${room}`);
  // notes reads a server it does not share with chats, and finn reviews such replies before they are posted.
  await agent(member, "notes", "Keeps notes for finn", { servers: ["crm"], sharedServers: [], reviewBeforePosting: true });
  await addToChat(member, "notes");

  // A page posted in the room with its reply.
  await send(member, '@notes /tool artifact_write {"html":"Kept notes body"}\n/tool artifact_publish {"title":"Kept notes","draft_id":"{{draft}}","new_artifact":true}');
  await expect(agentReply(owner, "notes", /artifact_publish: Published/)).toContainText("Kept notes");

  // A page from a reply finn reviews, and discards: never posted.
  await send(
    member,
    '@notes /tool crm.list_deals {}\n/tool artifact_write {"html":"Scratch notes body"}\n/tool artifact_publish {"title":"Scratch notes","draft_id":"{{draft}}","new_artifact":true}',
  );
  const draft = member.getByLabel("Draft reply of @notes, only you can see it");
  await expect(draft).toBeVisible();
  await draft.getByRole("button", { name: "Discard" }).click();
  await expect(draft).toHaveCount(0);
  await expect.poll(() => artifactTitles(member)).toEqual(expect.arrayContaining(["Kept notes", "Scratch notes"]));

  await member.locator(".people-bar button.person.agent").filter({ hasText: "@notes" }).click();
  await member.getByRole("button", { name: "Remove from this chat" }).click();
  await expect(member.locator(".people-bar button.person.agent").filter({ hasText: "@notes" })).toHaveCount(0);

  // Its seat is cleaned up: the page nobody saw leaves finn's list, the posted one stays, and so does its reply.
  await expect.poll(() => artifactTitles(member), { timeout: 30_000 }).not.toContain("Scratch notes");
  expect(await artifactTitles(member)).toContain("Kept notes");
  await expect(agentReply(owner, "notes", /artifact_publish: Published/)).toContainText("Kept notes");
  await expect(agentReply(member, "notes", /artifact_publish: Published/)).toContainText("Kept notes");
  await member.getByRole("button", { name: /^Artifacts/ }).click();
  await expect(member.locator("nav.artifact-list")).toContainText("Kept notes");
  await expect(member.locator("nav.artifact-list")).not.toContainText("Scratch notes");
  await shot(member, "more-6-seat-left");
});

test("7. anyone may ask an agent for a new page, calling only what the chat shares; pi too, on a member's agent's hand-off", async () => {
  const owner = eve.page;
  const member = finn.page;
  await owner.goto(`/c/${room}`);
  await member.goto(`/c/${room}`);
  const crm = JSON.stringify([{ server: "crm", tools: ["list_deals"] }]);
  const vault = JSON.stringify([{ server: "vault", tools: ["read_notes"] }]);
  // eve's maker may use crm and vault; vault signs in each user, so it is hers alone. Asked with no script of its own,
  // it builds the pipeline page (its instructions).
  await agent(owner, "maker", "Builds pages", {
    servers: ["crm", "vault"],
    instructions: [
      `/tool artifact_write {"html":"Pipeline for the room","mcp":${crm}}`,
      '/tool artifact_publish {"title":"Pipeline","draft_id":"{{draft}}","new_artifact":true}',
    ].join("\n"),
  });
  await addToChat(owner, "maker");

  // finn asks eve's agent for a page on vault: refused before anything is saved, saying why.
  await send(member, `@maker /tool artifact_write {"html":"Notes for finn","mcp":${vault}}`);
  await expect(agentReply(member, "maker", /artifact_write failed: .*Not saved: the page calls vault/)).toBeVisible();
  // On crm it is made and published, a new page of eve's.
  await send(
    member,
    `@maker /tool artifact_write {"html":"Deals for finn","mcp":${crm}}\n/tool artifact_publish {"title":"Deals for finn","draft_id":"{{draft}}","new_artifact":true}`,
  );
  await expect(agentReply(owner, "maker", /artifact_publish: Published/)).toContainText("Deals for finn");
  const made = (await call<{ id: string; title: string }[]>(owner, "GET", "/api/artifacts")).find((artifact) => artifact.title === "Deals for finn");
  expect(made).toBeTruthy();
  // Its live calls reach only crm, whatever it declares.
  const live = await call<{ ok: boolean; error?: { code: string; message: string } }>(member, "POST", `/api/artifacts/${made!.id}/mcp`, {
    version: 1,
    mode: "read",
    server: "vault",
    tool: "read_notes",
    input: {},
  });
  expect(live).toMatchObject({ ok: false, error: { code: "not_granted", message: expect.stringContaining("not one of the servers this page may call") } });
  // A new version of it, on finn's ask, is refused: changing a page the chat has is for eve's own message.
  await send(
    member,
    `@maker /tool artifact_write {"html":"Deals, finn's way"}\n/tool artifact_publish {"title":"Deals for finn","draft_id":"{{draft}}","artifact_id":"${made!.id}"}`,
  );
  await expect(agentReply(member, "maker", /artifact_publish failed: .*changing a page the chat already has/)).toBeVisible();
  expect((await call<{ latest: number }>(owner, "GET", `/api/artifacts/${made!.id}`)).latest).toBe(1);

  // pi on finn's message is new-only too: no version of eve's page, by id.
  await send(
    member,
    `@pi /tool artifact_write {"html":"Deals, pi for finn"}\n/tool artifact_publish {"title":"Deals for finn","draft_id":"{{draft}}","artifact_id":"${made!.id}"}`,
  );
  await expect(piReply(member, /artifact_publish failed: .*changing a page the chat already has/)).toBeVisible();
  expect((await call<{ latest: number }>(owner, "GET", `/api/artifacts/${made!.id}`)).latest).toBe(1);
  // eve's own draft, from pi's run on her message, is not finn's run's to publish, nor listed for it.
  await send(owner, '@pi /tool artifact_write {"html":"Eve private salary notes"}');
  const saved = await piReply(owner, /artifact_write: Saved as draft "\w+"/).last().innerText();
  const draftId = /Saved as draft "(\w+)"/.exec(saved)![1];
  await send(member, `@pi /tool artifact_publish {"title":"Salary","draft_id":"${draftId}","new_artifact":true}`);
  await expect(piReply(member, /artifact_publish failed: .*is not one this turn wrote/)).toBeVisible();
  await send(member, "@pi /tool artifact_drafts {}");
  await expect(piReply(member, /artifact_drafts: This chat has no drafts/)).toBeVisible();
  expect(await artifactTitles(owner)).not.toContain("Salary");

  // A hand-off: finn's own agent asks maker, which builds the pipeline page.
  await agent(member, "relay", "Passes asks on", { instructions: "/say @maker please build the pipeline page" });
  await addToChat(member, "relay");
  await send(member, "@relay go");
  await expect(agentReply(owner, "maker", /artifact_publish: Published/).filter({ hasText: "Pipeline" })).toBeVisible();

  // pi too, on finn's agent's hand-off: with no script in the hand-off, pi follows eve's system prompt.
  await call(owner, "PUT", "/api/me/system-prompt", {
    text: [`/tool artifact_write {"html":"Summary by pi","mcp":${crm}}`, '/tool artifact_publish {"title":"Summary by pi","draft_id":"{{draft}}","new_artifact":true}'].join("\n"),
  });
  try {
    await agent(member, "asker", "Asks pi", { instructions: "/say @pi please sum it up as a page" });
    await addToChat(member, "asker");
    await send(member, "@asker go");
    await expect.poll(() => artifactTitles(owner), { timeout: 30_000 }).toContain("Summary by pi");
  } finally {
    await call(owner, "PUT", "/api/me/system-prompt", { text: "" });
  }
  expect(await artifactTitles(owner)).toEqual(expect.arrayContaining(["Deals for finn", "Pipeline", "Summary by pi"]));
  await shot(member, "more-7-pages-for-anyone");
});
