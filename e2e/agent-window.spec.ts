// An agent's window end to end (shared/agent-window.ts), on the scripted model: its owner (wendy) opens it from the
// people bar while a turn works, steers that turn, gives it a turn of her own from the window, and stops it there; a
// member (walt) gets no window on her agent, only on his own agent's seat in her chat, which she cannot open. A turn
// keeps working while a flow looks at it through the crm stand-in's hold tool, released by the flow (e2e/stand-in.ts).
// People and agents of their own, so the file runs alone or with the others. Each flow ends on a screenshot in
// e2e/screens/.

import { expect, test, type Locator, type Page } from "@playwright/test";
import { addToChat, agentReply, call, newChat, send, shot, signIn, type Person } from "./app.ts";
import { MCP_PORT } from "./ports.ts";

test.describe.configure({ mode: "serial" });

let wendy: Person;
let walt: Person;
/** wendy's chat with her agent, which she shares with walt (flow d on). */
let chatId: string;
/** The agents' ids: wendy's "steady", and walt's "seatling" (flow e). */
let steadyId: string;
let seatlingId: string;

/** The stand-in's holds waiting now. */
async function holding(page: Page): Promise<string[]> {
  return ((await (await page.request.get(`http://127.0.0.1:${MCP_PORT}/state`)).json()) as { holding: string[] }).holding;
}

/** Let the hold `key` answer. */
async function release(page: Page, key: string): Promise<void> {
  expect((await page.request.post(`http://127.0.0.1:${MCP_PORT}/release?key=${key}`)).ok()).toBe(true);
}

/** An agent's badge in the people bar, which opens its menu. */
const badge = (page: Page, name: string) => page.locator(".people-bar").getByRole("button", { name: new RegExp(`^@${name},`) });

/** Open an agent's window from its menu in the people bar. */
async function openWindow(page: Page, name: string): Promise<Locator> {
  await badge(page, name).click();
  await page.getByRole("button", { name: "Open its window" }).click();
  const window = page.locator("aside.agent-window");
  await expect(window.getByText(`@${name}`, { exact: true })).toBeVisible();
  return window;
}

/** A request to the app's API as `page`'s person, answered with its status (call() expects success). */
async function status(page: Page, method: "GET" | "POST", path: string, body?: unknown): Promise<number> {
  const headers = { origin: new URL(page.url()).origin, "content-type": "application/json" };
  return (await page.request.fetch(path, { method, headers, ...(body !== undefined && { data: body }) })).status();
}

test.beforeAll(async ({ browser }) => {
  [wendy, walt] = await Promise.all([signIn(browser, "wendy"), signIn(browser, "walt")]);
  const steady = await call<{ id: string }>(wendy.page, "POST", "/api/agents", {
    name: "steady",
    job: "Looks the deals up",
    instructions: "Answer in a sentence.",
    servers: ["crm"],
  });
  steadyId = steady.id;
});

test("a. the owner opens her agent's window from the people bar and sees its running turn's steps", async () => {
  const { page } = wendy;
  chatId = await newChat(page);
  await addToChat(page, "steady");
  await send(page, '@steady /tool crm.hold {"key":"w1"}');
  await expect.poll(() => holding(page)).toContain("w1");
  const window = await openWindow(page, "steady");
  // The turn runs apart, in a fork of its own: shown with who asked, its step working.
  await expect(window.getByRole("button", { name: /Turn #\d+ · wendy/ })).toHaveAttribute("aria-pressed", "true");
  await expect(window.getByLabel("working")).toBeVisible();
  await expect(window).toContainText("crm › hold");
  await expect(window).toContainText("A turn apart from the chat");
  await shot(page, "window-a-running");
});

test("b. she steers the turn mid-way: it reads her words at its next step, and its reply says so", async () => {
  const { page } = wendy;
  const window = page.locator("aside.agent-window");
  const box = window.locator("textarea");
  await expect(box).toHaveAttribute("placeholder", "Steer @steady while it works…");
  await box.fill("/say Steered: only the mornings.");
  await window.getByRole("button", { name: "Steer" }).click();
  await expect(window.locator(".agent-window-note")).toContainText("Sent into the turn it is working on");
  // Read at its next step: once the call it waits on answers, her words are in its session, and its reply follows them.
  await release(page, "w1");
  await expect(agentReply(page, "steady", "Steered: only the mornings.")).toBeVisible();
  await expect(window.locator(".agent-window-input", { hasText: "Steered: only the mornings." })).toContainText("You, steering");
  // Her words are in no message of the chat: only the reply they led to.
  await expect(page.locator(".message.mine", { hasText: "only the mornings" })).toHaveCount(0);
  await shot(page, "window-b-steered");
});

test("c. an idle steer starts a private turn of hers, and only its reply posts to the chat", async () => {
  const { page } = wendy;
  const window = page.locator("aside.agent-window");
  const box = window.locator("textarea");
  await expect(box).toHaveAttribute("placeholder", "Tell @steady what to do…");
  await box.fill("/say From the window: Northwind first.");
  await window.getByRole("button", { name: "Send" }).click();
  await expect(window.locator(".agent-window-note")).toContainText("Started a turn of yours, apart from the chat");
  await expect(agentReply(page, "steady", "From the window: Northwind first.")).toBeVisible();
  await expect(window.getByRole("button", { name: /you, from here/ })).toBeVisible();
  await expect(page.locator(".message.mine", { hasText: "Northwind first" })).toHaveCount(0);
  await shot(page, "window-c-idle-turn");
});

test("d. Stop in the window stops the turn: nothing posts", async () => {
  const { page } = wendy;
  const window = page.locator("aside.agent-window");
  await send(page, '@steady /tool crm.hold {"key":"w2"}');
  await expect.poll(() => holding(page)).toContain("w2");
  const stop = window.getByRole("button", { name: "Stop", exact: true });
  await expect(stop).toBeVisible();
  await stop.click();
  await expect(stop).toHaveCount(0);
  await expect
    .poll(async () => (await call<{ turns: Record<string, { status: string }[]> }>(page, "GET", `/api/chats/${chatId}/agents`)).turns[steadyId]?.[0]?.status)
    .toBe("stopped");
  await release(page, "w2");
  await shot(page, "window-d-stopped");
  await expect(agentReply(page, "steady", "crm__hold")).toHaveCount(0);
  await window.getByRole("button", { name: "Close its window" }).click();
});

test("e. a member gets no window on the owner's agent: no entry, and the window and steer routes refuse him", async () => {
  const owner = wendy.page;
  await owner.getByRole("button", { name: "Share" }).click();
  await owner.getByRole("button", { name: "Create an invite link" }).click();
  const link = await owner.locator(".invite-link input").inputValue();
  await owner.keyboard.press("Escape");
  const member = walt.page;
  await member.goto(link);
  await member.getByRole("button", { name: "Join the chat" }).click();
  await expect(member).toHaveURL(new RegExp(`/c/${chatId}$`));
  await badge(member, "steady").click();
  const menu = member.locator(".agent-menu");
  await expect(menu).toContainText("@steady");
  await expect(menu.getByRole("button", { name: "Open its window" })).toHaveCount(0);
  await shot(member, "window-e-member-menu");
  await member.keyboard.press("Escape");
  expect(await status(member, "GET", `/api/chats/${chatId}/agents/${steadyId}/window`)).toBe(403);
  expect(await status(member, "POST", `/api/chats/${chatId}/agents/${steadyId}/steer`, { text: "/say not yours" })).toBe(403);
  // Its owner may.
  expect(await status(owner, "GET", `/api/chats/${chatId}/agents/${steadyId}/window`)).toBe(200);
});

test("f. a member opens the window of his own agent's seat in her chat, and steers it; she cannot open it", async () => {
  const member = walt.page;
  const owner = wendy.page;
  const seatling = await call<{ id: string }>(member, "POST", "/api/agents", {
    name: "seatling",
    job: "Walt's helper",
    instructions: "Answer in a sentence.",
    servers: ["crm"],
  });
  seatlingId = seatling.id;
  await call(member, "POST", `/api/chats/${chatId}/agents`, { agentId: seatlingId });
  await send(member, "@seatling /say Hello from walt's seat.");
  await expect(agentReply(member, "seatling", "Hello from walt's seat.")).toBeVisible();
  // Read from his own object, where its seat for this room is.
  const window = await openWindow(member, "seatling");
  await expect(window.getByRole("button", { name: "Shared with the chat" })).toBeVisible();
  await expect(window.getByRole("button", { name: /Turn #\d+/ })).toBeVisible();
  await window.locator("textarea").fill("/say From walt's window.");
  await window.getByRole("button", { name: "Send" }).click();
  await expect(window.locator(".agent-window-note")).toContainText("Started a turn of yours");
  await expect(agentReply(owner, "seatling", "From walt's window.")).toBeVisible();
  await expect(window.getByRole("button", { name: /you, from here/ })).toBeVisible();
  await shot(member, "window-f-seat");
  // The room's owner has no window on it.
  await badge(owner, "seatling").click();
  await expect(owner.locator(".agent-menu")).toContainText("@seatling");
  await expect(owner.locator(".agent-menu").getByRole("button", { name: "Open its window" })).toHaveCount(0);
  await owner.keyboard.press("Escape");
  expect(await status(owner, "GET", `/api/chats/${chatId}/agents/${seatlingId}/window`)).toBe(403);
  expect(await status(owner, "POST", `/api/chats/${chatId}/agents/${seatlingId}/steer`, { text: "/say not yours" })).toBe(403);
  expect(await status(member, "GET", `/api/chats/${chatId}/agents/${seatlingId}/window`)).toBe(200);
});
