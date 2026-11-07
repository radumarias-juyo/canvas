// What the flows do as people: sign in, open chats, write in them, and look at what came back. Setup that is not the
// flow under test (an agent with a workflow, a run started by hand) goes through the app's own API, as the person.

import { expect, type Browser, type Locator, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { MCP_PORT } from "./ports.ts";

const SCREENS = fileURLToPath(new URL("./screens/", import.meta.url));
mkdirSync(SCREENS, { recursive: true });

export interface Person {
  page: Page;
}

/** A person in a browser of their own, signed in with the demo sign-in form. */
export async function signIn(browser: Browser, name: string): Promise<Person> {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto("/");
  await page.getByLabel("Your name").fill(name);
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page.getByRole("button", { name: "+ New chat" })).toBeVisible();
  return { page };
}

type Method = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

/** The app's API, as `page`'s person: JSON bodies, from the app's own origin (the Worker refuses other sites). */
export async function call<T = Record<string, unknown>>(page: Page, method: Method, path: string, body?: unknown): Promise<T> {
  const headers = { origin: new URL(page.url()).origin, "content-type": "application/json" };
  const response = await page.request.fetch(path, { method, headers, ...(body !== undefined && { data: body }) });
  const text = await response.text();
  expect(response.ok(), `${method} ${path}: ${response.status()} ${text}`).toBe(true);
  return (text ? JSON.parse(text) : {}) as T;
}

/** A new chat from the sidebar's button; its id. */
export async function newChat(page: Page): Promise<string> {
  const before = page.url();
  await page.getByRole("button", { name: "+ New chat" }).click();
  await expect(page).not.toHaveURL(before);
  await expect(page).toHaveURL(/\/c\/[a-z0-9]+$/);
  await expect(page.locator("form.composer textarea")).toBeVisible();
  return new URL(page.url()).pathname.split("/").pop()!;
}

/** Write a message in the open chat and send it. */
export async function send(page: Page, text: string): Promise<void> {
  const box = page.locator("form.composer textarea");
  // Enter sends nothing until the chat's socket is open.
  await expect(box).not.toHaveAttribute("placeholder", "Connecting…");
  await box.fill(text);
  await box.press("Enter");
  await expect(box).toHaveValue("");
}

/** A reply of the roster agent `name` that says `text`. */
export function agentReply(page: Page, name: string, text: string | RegExp): Locator {
  return page.locator(".agent-reply").filter({ has: page.getByText(`@${name}`, { exact: true }) }).filter({ hasText: text });
}

/** One of pi's replies that says `text`. */
export function piReply(page: Page, text: string | RegExp): Locator {
  return page.locator(".assistant").filter({ hasText: text });
}

/** The owner brings one of their agents into the open chat from the people bar. */
export async function addToChat(page: Page, agent: string): Promise<void> {
  await page.getByRole("button", { name: "Agents in this chat" }).click();
  const list = page.getByRole("dialog", { name: "Add agents to this chat" });
  await list.locator("li").filter({ hasText: `@${agent}` }).getByRole("button", { name: "Add" }).click();
  await expect(page.locator(".chat-notice", { hasText: `You added @${agent} to the chat` })).toBeVisible();
  await list.getByRole("button", { name: "Close" }).click();
}

/** The crm stand-in's deals and the writes it took. */
export async function crmState(page: Page): Promise<{ deals: { id: string; stage: string }[]; writes: { tool: string; input: unknown }[] }> {
  return (await page.request.get(`http://127.0.0.1:${MCP_PORT}/state`)).json();
}

/** A screenshot for the lead to look at, at the context's scale. */
export async function shot(page: Page, name: string): Promise<void> {
  await page.screenshot({ path: `${SCREENS}${name}.png` });
}
