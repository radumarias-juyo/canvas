import { api } from "./api.ts";

/**
 * Web Push in this browser: once the user allowed notifications, the app registers its service worker (public/sw.js)
 * and subscribes with the Worker's VAPID key, so a notice reaches them while the app is closed. Without push in the
 * browser, or on the Worker (no VAPID secrets), it does nothing: the app's own notices still show while it is open.
 */
const supported = typeof navigator !== "undefined" && "serviceWorker" in navigator && typeof window !== "undefined" && "PushManager" in window;

let enabling: Promise<void> | undefined;

/** Subscribe this browser, once per page load; a subscription made for another key is replaced. Failures are logged. */
export function enablePush(): Promise<void> {
  if (!supported) return Promise.resolve();
  enabling ??= subscribe().catch((error: unknown) => {
    enabling = undefined;
    console.warn("push:", error);
  });
  return enabling;
}

async function subscribe(): Promise<void> {
  const key = await api.pushKey();
  if (!key) return;
  const registration = await navigator.serviceWorker.register("/sw.js");
  const serverKey = fromBase64url(key);
  let subscription = await registration.pushManager.getSubscription();
  if (subscription && !sameKey(subscription.options.applicationServerKey, serverKey)) {
    await subscription.unsubscribe();
    subscription = null;
  }
  subscription ??= await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: serverKey });
  await api.subscribePush(subscription.toJSON());
}

/** A click on a pushed notification, in an open window: the service worker asks it to go to `url` (an app path). */
export function onPushOpen(navigate: (path: string) => void): () => void {
  if (!supported) return () => {};
  const listener = (event: MessageEvent) => {
    const data = event.data as { type?: unknown; url?: unknown } | null;
    if (data?.type === "open" && typeof data.url === "string" && data.url.startsWith("/") && !data.url.startsWith("//")) navigate(data.url);
  };
  navigator.serviceWorker.addEventListener("message", listener);
  return () => navigator.serviceWorker.removeEventListener("message", listener);
}

/** Show a notice as the system's notification from the open app: through the service worker where there is one (Android shows only those). */
export async function showNotification(title: string, options: NotificationOptions & { onClick: () => void }): Promise<void> {
  const { onClick, ...shown } = options;
  try {
    const shownHere = new Notification(title, shown);
    shownHere.onclick = () => {
      window.focus();
      onClick();
      shownHere.close();
    };
  } catch {
    const registration = supported ? await navigator.serviceWorker.getRegistration() : undefined;
    await registration?.showNotification(title, { ...shown, data: { url: "/" } });
  }
}

function fromBase64url(value: string): Uint8Array<ArrayBuffer> {
  const base64 = value
    .replace(/-/g, "+")
    .replace(/_/g, "/")
    .padEnd(Math.ceil(value.length / 4) * 4, "=");
  return Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
}

function sameKey(current: ArrayBuffer | null, key: Uint8Array): boolean {
  if (!current) return false;
  const bytes = new Uint8Array(current);
  return bytes.length === key.length && bytes.every((byte, i) => byte === key[i]);
}
