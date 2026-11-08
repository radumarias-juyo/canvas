// The draft card edited in place: a linked word of the instructions opens its row's picker, a row changed rewrites its
// sentence, and a step edited changes its row. Runs after agents.spec.ts in the same suite, as a person of its own.
// With DRAFT_SHOTS set to a folder, it also saves the card in light and dark, on a desktop and a phone, there.

import { expect, test, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";
import type { AgentDefinition } from "../shared/agents.ts";
import { call, newChat, send, signIn, type Person } from "./app.ts";

test.describe.configure({ mode: "serial" });

let cleo: Person;
const propose = (input: Record<string, unknown>) => `/tool agent_propose ${JSON.stringify(input)}`;
const SHOTS = process.env.DRAFT_SHOTS;

/** The card in four looks, when DRAFT_SHOTS asks for them. */
async function shots(page: Page, name: string): Promise<void> {
  if (!SHOTS) return;
  mkdirSync(SHOTS, { recursive: true });
  const card = page.getByRole("article", { name: "Agent @deal-brief" });
  for (const [size, viewport] of [
    ["desktop", { width: 1280, height: 900 }],
    ["phone", { width: 390, height: 844 }],
  ] as const) {
    await page.setViewportSize(viewport);
    for (const scheme of ["light", "dark"] as const) {
      // No motion: the phone's menu is shut at once, not mid-slide in the picture.
      await page.emulateMedia({ colorScheme: scheme, reducedMotion: "reduce" });
      await page.mouse.move(0, 0);
      await card.scrollIntoViewIfNeeded();
      await card.screenshot({ path: `${SHOTS}/${name}-${size}-${scheme}.png` });
    }
  }
  await page.setViewportSize({ width: 1280, height: 860 });
  await page.emulateMedia({ colorScheme: "light", reducedMotion: "no-preference" });
}

test.beforeAll(async ({ browser }) => {
  cleo = await signIn(browser, "cleo");
});

test("j. the draft card edits in place: its rows and its sentences stay in step", async () => {
  const { page } = cleo;
  await newChat(page);
  await send(
    page,
    propose({
      name: "deal-brief",
      job: "Where the open deals stand, before the day starts",
      instructions: "1. Every day at 07:00, look at the deals in crm.\n2. Work out which deals moved.\n3. Tell me in the chat.",
      servers: ["crm"],
      trigger: { kind: "schedule", at: "07:00", tz: "UTC" },
      workflow: [
        { kind: "look", server: "crm", tool: "list_deals", input: {} },
        { kind: "work", prompt: "Which deals moved?" },
        { kind: "tell", to: ["owner"], via: "chat" },
      ],
      assumed: ["trigger"],
    }),
  );
  const card = page.getByRole("article", { name: "Agent @deal-brief" });
  await expect(card).toBeVisible();
  // The guessed schedule's words are linked, dashed.
  const time = card.locator("button.agent-link.assumed", { hasText: "07:00" });
  await expect(time).toBeVisible();
  await expect(card.locator("button.agent-link", { hasText: "crm" })).toBeVisible();
  await shots(page, "card");

  // The linked time opens the Runs row's picker in place.
  await time.click();
  const picker = card.locator("form.row-picker");
  await expect(picker).toBeVisible();
  await picker.locator('input[type="time"]').fill("08:30");
  await picker.getByRole("button", { name: "Weekdays" }).click();
  await shots(page, "picker");
  await picker.getByRole("button", { name: "Save" }).click();
  await expect(picker).toHaveCount(0);
  // Its sentence says the new schedule; the row does too, and is no longer a guess.
  await expect(card.locator(".agent-card-steps li").first()).toContainText("Every weekday at 08:30, look at the deals in crm.");
  const runs = card.locator(".agent-glance-row").filter({ hasText: "Runs" });
  await expect(runs).toContainText("Weekdays at 08:30");
  await expect(runs.locator(".pill.assumed")).toHaveCount(0);
  await expect(card).toContainText("the sentence that said it now says the new value");
  await shots(page, "rewritten");

  // A row no sentence names: a short line is added instead.
  await card.locator(".agent-glance-row").filter({ hasText: "Tells" }).getByRole("button", { name: /Change/ }).click();
  await picker.getByLabel("A notification to you").check();
  await picker.getByRole("button", { name: "Save" }).click();
  await expect(card).toContainText("a short line at the end of the instructions");

  // A step edited moves its row: the time in its sentence is the schedule's.
  const first = card.locator(".agent-card-steps li").first();
  await first.hover();
  await first.getByRole("button", { name: /Edit/ }).click();
  const box = card.getByRole("textbox", { name: "Step 1" });
  await box.fill("Every weekday at 06:15, look at the deals in crm.");
  await shots(page, "step-edit");
  await card.locator("form.agent-step-edit").getByRole("button", { name: "Save" }).click();
  await expect(runs).toContainText("Weekdays at 06:15");
  await expect(card).toContainText("its steps follow the new sentence");

  // Its steps are compiled again from the new words: the work step says what step 2 says now, and the tell goes as
  // the Tells line says (by a notification).
  const second = card.locator(".agent-card-steps li").nth(1);
  await second.hover();
  await second.getByRole("button", { name: /Edit/ }).click();
  await card.getByRole("textbox", { name: "Step 2" }).fill("Work out which deals moved, and why.");
  await card.locator("form.agent-step-edit").getByRole("button", { name: "Save" }).click();
  await expect(card).toContainText("Its steps follow the new sentence.");
  const agents = await call<AgentDefinition[]>(page, "GET", "/api/agents");
  expect(agents.find((agent) => agent.name === "deal-brief")?.workflow).toEqual([
    { kind: "look", server: "crm", tool: "list_deals", input: {} },
    { kind: "work", prompt: "Work out which deals moved, and why.\nTell me in the chat." },
    { kind: "tell", to: ["owner"], via: "notify" },
  ]);
});
