// pi's settings form, as plain functions the tests run (src/agents/PiPage.tsx draws it).

import type { AgentServerInfo } from "../../shared/agents.ts";
import type { PiSettings } from "../../shared/pi-settings.ts";

/** What the form edits: the owner's system prompt (pi's instructions) and pi's settings. */
export interface PiForm {
  instructions: string;
  /** pi's servers for shared chats; null while it keeps the default (those that do not sign in each user). */
  shared: ReadonlySet<string> | null;
  review: boolean;
}

export function piForm(instructions: string, settings: PiSettings): PiForm {
  return { instructions, shared: settings.sharedServers ? new Set(settings.sharedServers) : null, review: settings.reviewBeforePosting === true };
}

/** The servers pi reads for others in shared chats, as the form has them: its list, else those that do not sign in each user. */
export function piShared(form: PiForm, servers: readonly AgentServerInfo[]): Set<string> {
  return new Set(form.shared ?? servers.filter((server) => !server.signsIn).map((server) => server.name));
}

/** The form with `server` turned on or off for shared chats: from then on an explicit list. */
export function togglePiShared(form: PiForm, servers: readonly AgentServerInfo[], server: string, on: boolean): PiForm {
  const next = piShared(form, servers);
  if (on) next.add(server);
  else next.delete(server);
  return { ...form, shared: next };
}

/**
 * pi's settings as the form saves them: an explicit list only when it differs from the default (so a server added to
 * the deployment later starts as the default says), and review only when on.
 */
export function piSettingsOf(form: PiForm, servers: readonly AgentServerInfo[]): PiSettings {
  const shared = [...piShared(form, servers)].sort();
  const byDefault = [...piShared({ ...form, shared: null }, servers)].sort();
  const listed = form.shared !== null && shared.join("\n") !== byDefault.join("\n");
  return { ...(listed && { sharedServers: shared }), ...(form.review && { reviewBeforePosting: true }) };
}

/** Whether two forms would save differently. */
export function piFormChanged(a: PiForm, b: PiForm, servers: readonly AgentServerInfo[]): boolean {
  return a.instructions.trim() !== b.instructions.trim() || JSON.stringify(piSettingsOf(a, servers)) !== JSON.stringify(piSettingsOf(b, servers));
}

/** What a server's row warns of: one that signs in as the owner, on for shared chats, shows others what pi reads there. */
export function piServerWarning(server: AgentServerInfo, shared: boolean): string | undefined {
  return server.signsIn && shared ? "Anyone in a chat you share can make pi read this as you, and sees what it reads." : undefined;
}
