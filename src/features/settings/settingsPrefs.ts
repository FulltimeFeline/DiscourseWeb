// Supplementary preferences for the Settings surface.
//
// The shared `core/Preferences.ts` store (do-not-edit) already carries the
// appearance and a subset of behaviour keys that feature code reads live.
// Several other keys have no home in that store (coloured sender names,
// timeline avatars, read-receipt display, unencrypted warning, EXIF stripping,
// notification preview mode, accessibility flags, dev flags). Rather than edit
// the shared store, those live here in a parallel localStorage-backed store
// with the same subscribe/patch/reset contract. Settings reads and writes both;
// feature code that needs one of these keys imports `settingsPrefs`.
//
// TODO: fold these into core/Preferences.ts so there is a single prefs store.
// Until then this covers the gap without touching the do-not-edit file.

import { Store } from "@/core/reactive";

export type NotificationPreview = "full" | "senderOnly" | "none";

export interface SettingsPrefs {
  // Appearance (not in shared store)
  coloredSenderNames: boolean;
  showAvatarsInTimeline: boolean;
  // Chat behaviour (not in shared store)
  use24HourTime: boolean;
  alwaysShowTimestamps: boolean;
  showReadReceipts: boolean; // display others' receipts
  // Privacy (not in shared store)
  warnUnencrypted: boolean;
  stripLocationMetadata: boolean;
  // Storage
  autoDownloadImages: boolean;
  // Notifications (local presentation prefs)
  notificationPreview: NotificationPreview;
  notificationSound: boolean;
  // Accessibility
  reduceTimelineMotion: boolean;
  largerTapTargets: boolean;
  confirmBeforeDeleting: boolean;
  sendMessageHaptic: boolean;
  // Advanced / dev
  showEventIds: boolean;
}

export const SETTINGS_DEFAULTS: SettingsPrefs = {
  coloredSenderNames: true,
  showAvatarsInTimeline: true,
  use24HourTime: false,
  alwaysShowTimestamps: false,
  showReadReceipts: true,
  warnUnencrypted: true,
  stripLocationMetadata: true,
  autoDownloadImages: true,
  notificationPreview: "full",
  notificationSound: true,
  reduceTimelineMotion: false,
  largerTapTargets: false,
  confirmBeforeDeleting: false,
  sendMessageHaptic: true,
  showEventIds: false,
};

const KEY = "discourse.settings-prefs.v1";

function load(): SettingsPrefs {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return { ...SETTINGS_DEFAULTS };
    return { ...SETTINGS_DEFAULTS, ...(JSON.parse(raw) as Partial<SettingsPrefs>) };
  } catch {
    return { ...SETTINGS_DEFAULTS };
  }
}

class SettingsPrefsStore extends Store<SettingsPrefs> {
  constructor() {
    super(load());
    this.apply(this.value);
  }

  get<K extends keyof SettingsPrefs>(key: K): SettingsPrefs[K] {
    return this.value[key];
  }

  patch(patch: Partial<SettingsPrefs>): void {
    const next = { ...this.value, ...patch };
    localStorage.setItem(KEY, JSON.stringify(next));
    this.set(next);
    this.apply(next);
  }

  resetToDefaults(): void {
    localStorage.setItem(KEY, JSON.stringify(SETTINGS_DEFAULTS));
    this.set({ ...SETTINGS_DEFAULTS });
    this.apply(SETTINGS_DEFAULTS);
  }

  /** Reflect the accessibility-ish flags that affect layout onto the root. */
  private apply(p: SettingsPrefs): void {
    const root = document.documentElement;
    // In-app reduce-motion OR the system media query.
    const sysReduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    root.setAttribute("data-reduce-motion", String(p.reduceTimelineMotion || sysReduce));
    root.setAttribute("data-tap-targets", p.largerTapTargets ? "large" : "normal");
    root.setAttribute("data-timeline-avatars", String(p.showAvatarsInTimeline));
    root.setAttribute("data-colored-names", String(p.coloredSenderNames));
  }
}

export const settingsPrefs = new SettingsPrefsStore();

// Re-apply layout attrs if the user flips the system reduce-motion setting.
window
  .matchMedia("(prefers-reduced-motion: reduce)")
  .addEventListener("change", () => settingsPrefs.patch({}));
