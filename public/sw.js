// The app's service worker: it shows the push notifications the Worker sends (worker/push/) while the app is closed,
// and a click opens the chat or page the push names. It caches nothing.

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

/** A path in this app, never another site: a push says where to go, and only the app's own paths are followed. */
function appPath(url) {
  return typeof url === "string" && url.startsWith("/") && !url.startsWith("//") ? url : "/";
}

self.addEventListener("push", (event) => {
  let message = {};
  try {
    message = event.data ? event.data.json() : {};
  } catch {
    // Not JSON: show the generic notice.
  }
  const title = typeof message.title === "string" ? message.title : "Something new";
  event.waitUntil(
    self.registration.showNotification(title, {
      body: typeof message.body === "string" ? message.body : "",
      tag: typeof message.tag === "string" ? message.tag : undefined,
      data: { url: appPath(message.url) },
    }),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = appPath(event.notification.data && event.notification.data.url);
  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      const open = windows.find((client) => new URL(client.url).origin === self.location.origin);
      if (!open) return self.clients.openWindow(url);
      // The app moves there itself (src/push.ts), without a reload.
      open.postMessage({ type: "open", url });
      return open.focus();
    })(),
  );
});
