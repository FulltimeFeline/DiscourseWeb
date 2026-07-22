// Discourse web push service worker. Shows a notification for each incoming
// Matrix push (delivered by the homeserver's push gateway, e.g. sygnal's
// webpush pushkin) and focuses/opens the app to the room on click.
//
// The gateway sends the Matrix push-gateway "notification" object. For E2EE
// rooms it typically carries only room_id/event_id/counts (no plaintext), so we
// fall back to a generic body in that case.

/* eslint-disable no-restricted-globals */

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

self.addEventListener("push", (event) => {
  let payload = {};
  try {
    payload = event.data ? event.data.json() : {};
  } catch {
    payload = {};
  }
  const n = payload.notification || payload;
  const roomName = n.room_name || n.sender_display_name || "Discourse";
  const hasBody = n.content && typeof n.content.body === "string";
  const body = hasBody
    ? (n.sender_display_name ? `${n.sender_display_name}: ${n.content.body}` : n.content.body)
    : n.sender_display_name
      ? `${n.sender_display_name} sent a message`
      : "New activity";

  event.waitUntil(
    self.registration.showNotification(roomName, {
      body,
      tag: n.room_id || "discourse",
      icon: "/icon.png",
      badge: "/icon.png",
      data: { roomId: n.room_id, eventId: n.event_id },
    }),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const roomId = event.notification.data && event.notification.data.roomId;
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clients) => {
      for (const client of clients) {
        if ("focus" in client) {
          client.focus();
          client.postMessage({ type: "discourse:navigate", roomId });
          return undefined;
        }
      }
      if (self.clients.openWindow) {
        const url = roomId ? `/?room=${encodeURIComponent(roomId)}` : "/";
        return self.clients.openWindow(url);
      }
      return undefined;
    }),
  );
});
