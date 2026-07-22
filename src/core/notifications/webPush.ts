// Background push via the Web Push API + a Matrix push gateway (e.g. sygnal's
// webpush pushkin). This is DEPLOYMENT-GATED: it only activates when the app is
// built with a VAPID public key, a gateway URL, and a webpush app id. Without
// them it's a no-op (foreground banners via WebNotifications still work).
//
// The FFI `HttpPusherData` can't carry the webpush p256dh/auth subscription
// keys sygnal needs, so we register the pusher via REST POST /pushers/set.
//
// Required build-time env (Vite):
//   VITE_VAPID_PUBLIC_KEY   base64url VAPID public key (matches the gateway)
//   VITE_PUSH_GATEWAY_URL   the gateway's /_matrix/push/v1/notify URL
//   VITE_PUSH_APP_ID        the webpush app id configured in the gateway

import type { MatrixSession } from "@/core/MatrixSession";

const VAPID = import.meta.env.VITE_VAPID_PUBLIC_KEY as string | undefined;
const GATEWAY = import.meta.env.VITE_PUSH_GATEWAY_URL as string | undefined;
const APP_ID = import.meta.env.VITE_PUSH_APP_ID as string | undefined;

export function webPushConfigured(): boolean {
  return !!(VAPID && GATEWAY && APP_ID);
}

function urlBase64ToUint8Array(base64: string): Uint8Array {
  const padding = "=".repeat((4 - (base64.length % 4)) % 4);
  const b64 = (base64 + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(b64);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

/**
 * Register the service worker, subscribe to push, and register the pusher with
 * the homeserver. Best-effort and idempotent; returns true if a pusher was set.
 */
export async function registerWebPush(session: MatrixSession): Promise<boolean> {
  if (!webPushConfigured()) return false;
  if (!("serviceWorker" in navigator) || !("PushManager" in window)) return false;
  if (typeof Notification === "undefined" || Notification.permission !== "granted") return false;
  try {
    const reg = await navigator.serviceWorker.register("/sw.js");
    await navigator.serviceWorker.ready;
    const sub =
      (await reg.pushManager.getSubscription()) ??
      (await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(VAPID!) as BufferSource,
      }));
    const json = sub.toJSON();
    const endpoint = json.endpoint;
    const p256dh = json.keys?.p256dh;
    const auth = json.keys?.auth;
    if (!endpoint || !p256dh || !auth) return false;

    const base = await session.apiBase();
    const token = session.session()?.accessToken;
    if (!base || !token) return false;
    const res = await fetch(`${base.replace(/\/$/, "")}/_matrix/client/v3/pushers/set`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        app_id: APP_ID,
        kind: "http",
        pushkey: endpoint,
        app_display_name: "Discourse Web",
        device_display_name: "Web",
        lang: "en",
        append: false,
        data: {
          url: GATEWAY,
          format: "event_id_only",
          // sygnal webpush reads the subscription keys from the pusher data.
          endpoint,
          auth,
          p256dh,
          default_payload: {},
        },
      }),
    });
    return res.ok;
  } catch {
    return false;
  }
}
