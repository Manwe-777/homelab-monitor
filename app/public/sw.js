// Shows the alerts the monitor pushes. One registration per monitor, see src/lib/push.js
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

const appUrl = new URL("./", self.location.href).href;

self.addEventListener("push", (event) => {
  let alert = {};
  try {
    alert = event.data ? event.data.json() : {};
  } catch {
    alert = { title: "Homelab alert", body: event.data?.text() || "" };
  }

  const where = [alert.monitorName, alert.channelName].filter(Boolean).join(" · ");
  event.waitUntil(
    self.registration.showNotification(alert.title || "Homelab alert", {
      body: [alert.body, where].filter(Boolean).join("\n"),
      tag: alert.check ? `${alert.monitor}/${alert.channel}/${alert.check}` : alert.id,
      renotify: true,
      requireInteraction: alert.state === "down",
      icon: new URL("icon-192.png", appUrl).href,
      badge: new URL("badge-96.png", appUrl).href,
      timestamp: alert.ts,
      data: { url: `${appUrl}?monitor=${alert.monitor || ""}&tab=history` },
    })
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = event.notification.data?.url || appUrl;

  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clients) => {
      const open = clients.find((client) => client.url.startsWith(appUrl));
      if (open) {
        open.postMessage({ type: "open", url });
        return open.focus();
      }
      return self.clients.openWindow(url);
    })
  );
});
