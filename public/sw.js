// Service worker: receives web-push events and shows notifications.
// Registered from app/layout.tsx (client-side) on every app load.

self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("push", (event) => {
  let data = {};
  if (event.data) {
    try {
      data = event.data.json();
    } catch {
      data = { title: "Church Alert", body: event.data.text() };
    }
  }
  const title = data.title || "Church Alert";
  const options = {
    body: data.body || "",
    icon: "/icon-192.png",
    badge: "/icon-192.png",
    tag: data.tag || "church-alert",
    renotify: true,
    requireInteraction: !!data.isPanic,
    data: { url: data.url || "/" },
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const targetUrl = (event.notification.data && event.notification.data.url) || "/";
  event.waitUntil(
    self.clients
      .matchAll({ type: "window", includeUncontrolled: true })
      .then((windowClients) => {
        const target = new URL(targetUrl, self.location.origin);
        // Prefer a tab already on the right URL.
        for (const client of windowClients) {
          try {
            const url = new URL(client.url);
            if (url.pathname === target.pathname) return client.focus();
          } catch {
            /* unparseable URL — skip */
          }
        }
        // Otherwise focus any tab and navigate it to the target URL.
        for (const client of windowClients) {
          if ("focus" in client) {
            const focused = client.focus();
            if ("navigate" in client) {
              return Promise.resolve(focused).then(() =>
                client.navigate(target.href).catch(() => focused)
              );
            }
            return focused;
          }
        }
        if (self.clients.openWindow) return self.clients.openWindow(target.href);
      })
  );
});
