// Local web notifications for incoming messages: show a banner for a new message
// when the tab is hidden and the preference allows; suppress the focused room
// and our own messages; dedup by event id; ignore stale events (>120s). Clicking
// focuses the tab and opens the room via app.selectRoom.
//
// This is the FOREGROUND path only (Notification API). Background delivery via
// Web Push (VAPID) + a Service Worker lives in webPush.ts.

import type { AppState } from "@/app/AppState";
import { preferences } from "@/core/Preferences";

export interface IncomingMessage {
  roomId: string;
  eventId: string;
  /** Room display name for the banner title. */
  roomName: string;
  /** Sender display name (or id). */
  senderName: string;
  /** One-line rendered body. */
  body: string;
  /** Event origin timestamp (ms). */
  timestampMs: number;
  isOwn: boolean;
  /** Resolved http(s) avatar URL for the room/sender icon, if any. */
  iconUrl?: string;
}

/** Preview levels: full / sender-only / none. */
export type PreviewLevel = "full" | "senderOnly" | "none";

const STALE_MS = 120_000;

export class WebNotifications {
  private shown = new Map<string, Notification>(); // eventId → live Notification
  private seen = new Set<string>(); // eventIds we've already handled (dedup)
  private previewLevel: PreviewLevel = "full";
  private sound = true;
  private calls = new Map<string, Notification>(); // roomId → live call banner

  constructor(private app: AppState) {}

  get supported(): boolean {
    return typeof Notification !== "undefined";
  }

  get permission(): NotificationPermission {
    return this.supported ? Notification.permission : "denied";
  }

  setPreviewLevel(level: PreviewLevel): void {
    this.previewLevel = level;
  }

  setSound(on: boolean): void {
    this.sound = on;
  }

  /** Request permission; safe to call on a user gesture. Returns granted?. */
  async requestPermission(): Promise<boolean> {
    if (!this.supported) return false;
    if (Notification.permission === "granted") return true;
    if (Notification.permission === "denied") return false;
    try {
      return (await Notification.requestPermission()) === "granted";
    } catch {
      return false;
    }
  }

  /** True when a banner should be shown for this message right now. */
  private shouldNotify(msg: IncomingMessage): boolean {
    if (!this.supported || this.permission !== "granted") return false;
    if (!preferences.get("showDesktopNotifications")) return false;
    if (msg.isOwn) return false;
    if (this.seen.has(msg.eventId)) return false;
    // Stale-event guard (ignore events older than 120s).
    if (Date.now() - msg.timestampMs > STALE_MS) return false;
    // Suppress the focused room while the tab is visible. Other rooms still
    // notify even when the tab is focused.
    if (document.visibilityState === "visible") {
      if (this.app.state.selectedRoomId === msg.roomId) return false;
    }
    return true;
  }

  /** Show a banner for an incoming message, applying all suppression rules. */
  notifyMessage(msg: IncomingMessage): void {
    if (!this.shouldNotify(msg)) {
      this.seen.add(msg.eventId);
      return;
    }
    this.seen.add(msg.eventId);

    const { title, body } = this.render(msg);
    let notification: Notification;
    try {
      notification = new Notification(title, {
        body,
        tag: msg.roomId, // collapse multiple messages from a room
        icon: msg.iconUrl,
        silent: !this.sound,
        // renotify requires a tag; keep the room's banner fresh.
        data: { roomId: msg.roomId, eventId: msg.eventId },
      });
    } catch {
      return;
    }
    this.shown.set(msg.eventId, notification);
    notification.onclick = () => {
      try {
        window.focus();
      } catch {
        /* focus may be blocked */
      }
      this.app.selectRoom(msg.roomId);
      notification.close();
    };
    notification.onclose = () => this.shown.delete(msg.eventId);
  }

  /** One-shot banner for a new room invite (deduped per room). */
  notifyInvite(inv: { roomId: string; roomName: string; inviterName: string }): void {
    if (!this.supported || this.permission !== "granted") return;
    if (!preferences.get("showDesktopNotifications")) return;
    const key = `invite:${inv.roomId}`;
    if (this.seen.has(key)) return;
    this.seen.add(key);
    const body = this.previewLevel === "none" ? "You have a new invite" : `${inv.inviterName} invited you`;
    try {
      const n = new Notification(inv.roomName, { body, tag: key, silent: !this.sound, data: { roomId: inv.roomId } });
      n.onclick = () => {
        try {
          window.focus();
        } catch {
          /* focus may be blocked */
        }
        this.app.selectRoom(inv.roomId);
        n.close();
      };
    } catch {
      /* construction can throw if permission was revoked mid-flight */
    }
  }

  /** Banner for an ongoing call in a room (tap to join); deduped by roomId. */
  notifyCall(call: { roomId: string; roomName: string }): void {
    if (!this.supported || this.permission !== "granted") return;
    if (!preferences.get("showDesktopNotifications")) return;
    if (document.visibilityState === "visible" && this.app.state.selectedRoomId === call.roomId) return;
    if (this.calls.has(call.roomId)) return;
    try {
      const n = new Notification(call.roomName, {
        body: "Ongoing call — tap to join",
        tag: `call:${call.roomId}`,
        silent: !this.sound,
        data: { roomId: call.roomId },
      });
      this.calls.set(call.roomId, n);
      n.onclick = () => {
        try {
          window.focus();
        } catch {
          /* focus may be blocked */
        }
        window.dispatchEvent(new CustomEvent("discourse:open-call", { detail: { roomId: call.roomId } }));
        n.close();
      };
      n.onclose = () => this.calls.delete(call.roomId);
    } catch {
      /* ignore */
    }
  }

  /** Dismiss a room's call banner when the call ends. */
  clearCall(roomId: string): void {
    this.calls.get(roomId)?.close();
    this.calls.delete(roomId);
  }

  private render(msg: IncomingMessage): { title: string; body: string } {
    switch (this.previewLevel) {
      case "none":
        return { title: msg.roomName, body: "New message" };
      case "senderOnly":
        return { title: msg.roomName, body: `${msg.senderName} sent a message` };
      case "full":
      default: {
        // For a DM/1:1 the room name usually equals the sender, so keep it plain.
        const title = msg.roomName === msg.senderName ? msg.senderName : msg.roomName;
        const body =
          msg.roomName === msg.senderName ? msg.body : `${msg.senderName}: ${msg.body}`;
        return { title, body };
      }
    }
  }

  /** Clear a room's delivered banner (call when the room is read/opened). */
  clearRoom(roomId: string): void {
    for (const [eventId, n] of this.shown) {
      if ((n.data as { roomId?: string })?.roomId === roomId) {
        n.close();
        this.shown.delete(eventId);
      }
    }
  }

  dispose(): void {
    for (const n of this.shown.values()) n.close();
    this.shown.clear();
    this.seen.clear();
  }
}

/** App-badge helpers (installed PWA); no-ops where unsupported. */
export function setAppBadge(count: number): void {
  const nav = navigator as Navigator & {
    setAppBadge?: (n?: number) => Promise<void>;
    clearAppBadge?: () => Promise<void>;
  };
  try {
    if (count > 0) void nav.setAppBadge?.(count);
    else void nav.clearAppBadge?.();
  } catch {
    /* unsupported */
  }
}
