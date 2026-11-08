// pi in a chat others are in reads for whom it answers (worker/agent/reach.ts), on the scripted model: dora signs in to
// vault (a server that signs in each user) and shares chats with eli. Runs after the other specs in the same suite, as
// people of its own.

import { expect, test, type Page } from "@playwright/test";
import { newChat, piReply, send, shot, signIn, type Person } from "./app.ts";

test.describe.configure({ mode: "serial" });

let dora: Person;
let eli: Person;
/** What vault's notes say: only dora may read it, and only her own messages read it. */
const NOTE = "Quarterly review on Friday";

/** An invite link to the open chat, from its owner's Share panel. */
async function inviteLink(page: Page): Promise<string> {
  await page.getByRole("button", { name: "Share", exact: true }).click();
  await page.getByRole("button", { name: "Create an invite link" }).click();
  const link = await page.locator(".invite-link input").inputValue();
  await page.keyboard.press("Escape");
  return link;
}

/** `person` joins the chat `chatId` by `link`. */
async function join(person: Person, link: string, chatId: string): Promise<void> {
  await person.page.goto(link);
  await person.page.getByRole("button", { name: "Join the chat" }).click();
  await expect(person.page).toHaveURL(new RegExp(`/c/${chatId}$`));
}

test.beforeAll(async ({ browser }) => {
  [dora, eli] = await Promise.all([signIn(browser, "dora"), signIn(browser, "eli")]);
  // The stand-in approves at once: dora is signed in to vault from here on.
  await dora.page.goto("/api/mcp/sign-in/vault");
  await dora.page.goto("/");
});

test("p1. a member sees none of what pi read with the owner's sign-in, and cannot make it read it", async () => {
  const owner = dora.page;
  const chat = await newChat(owner);
  await send(owner, "/say Hello.");
  await expect(piReply(owner, "Hello.")).toBeVisible();
  await join(eli, await inviteLink(owner), chat);
  const member = eli.page;

  await send(owner, "@pi /tool vault.read_notes {}\n/say Your notes are in.");
  const mine = piReply(owner, "Your notes are in.");
  await expect(mine).toBeVisible();
  // Her own steps show what vault returned.
  await expect(owner.locator(".assistant", { hasText: NOTE }).first()).toBeVisible();
  await expect(mine.locator(".source-chip")).toHaveText("from your vault");
  const theirs = piReply(member, "Your notes are in.");
  await expect(theirs).toBeVisible();
  await expect(theirs.locator(".source-chip")).toHaveText("from dora's vault");
  await expect(member.locator(".assistant", { hasText: "Shown only to the chat's owner" }).first()).toBeVisible();
  await expect(member.locator(".assistant", { hasText: NOTE })).toHaveCount(0);

  // eli's own @pi may not read vault: the call is refused, and eli still sees no note.
  await send(member, "@pi /tool vault.read_notes {}\n/say Done looking.");
  await expect(piReply(member, "Done looking.")).toBeVisible();
  await expect(member.locator(".assistant", { hasText: NOTE })).toHaveCount(0);
  await expect(piReply(owner, "Done looking.")).not.toContainText(NOTE);
  await shot(member, "p1-member");
});

test("p2. a reply pi built alone with the owner is held when someone joins before it ends", async () => {
  const owner = dora.page;
  const chat = await newChat(owner);
  // A chat is shared once it has a message.
  await send(owner, "/say Hi.");
  await expect(piReply(owner, "Hi.")).toBeVisible();
  const link = await inviteLink(owner);
  // Alone, every message is pi's. The read takes a few seconds: eli joins meanwhile.
  await send(owner, '/tool vault.read_notes_slowly {"ms":6000}\n/say Here is what your notes say.');
  await join(eli, link, chat);
  const member = eli.page;

  const show = owner.getByRole("button", { name: "Show to the chat" });
  await expect(show).toBeVisible({ timeout: 30_000 });
  await expect(piReply(owner, "Here is what your notes say.")).toBeVisible();
  await expect(member.getByText("shown only to the chat's owner for now")).toBeVisible();
  await expect(member.locator(".assistant", { hasText: "Here is what your notes say." })).toHaveCount(0);
  await expect(member.locator(".assistant", { hasText: NOTE })).toHaveCount(0);
  await shot(owner, "p2-held");

  // dora shows it: eli now has the reply (the result it read stays hers).
  await show.click();
  await expect(piReply(member, "Here is what your notes say.")).toBeVisible();
  await expect(member.locator(".assistant", { hasText: NOTE })).toHaveCount(0);
  await expect(owner.getByRole("button", { name: "Show to the chat" })).toHaveCount(0);
});
