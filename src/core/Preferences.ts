// User preferences, persisted to localStorage. Every persisted `pref.*` key
// lives here so Settings screens and feature code read one typed store.
// Appearance keys are also reflected onto the document root as data-attributes
// and CSS variables.

import { Store } from "./reactive";

export type ThemeSetting = "system" | "light" | "dark";
export type MessageDensity = "comfortable" | "compact";

/** The app accent — the icon purple. Must match `--accent` in theme.css. */
export const DEFAULT_ACCENT = "#9059f1";
/** Sentinel stored in `accent` for "follow the OS accent color". */
export const SYSTEM_ACCENT = "system";
/** Whether the browser can resolve the OS accent (CSS `AccentColor` keyword). */
export const systemAccentSupported =
  typeof CSS !== "undefined" && CSS.supports("color", "AccentColor");

export interface Prefs {
  // Appearance
  theme: ThemeSetting;
  accent: string; // hex, or SYSTEM_ACCENT to follow the OS accent
  tintedWindow: boolean; // accent-wash the window surfaces (off = plain gray)
  messageDensity: MessageDensity;
  fontScale: number; // 0.85–1.4
  // Chat behaviour
  sendOnEnter: boolean;
  showTypingIndicators: boolean;
  sendTypingNotifications: boolean;
  renderReactions: boolean;
  coloredSenderNames: boolean;
  animatedEmotes: boolean;
  groupingWindowMinutes: number;
  jumboEmoji: boolean;
  // Media
  autoplayGifs: boolean;
  autoplayVideos: boolean;
  dataSaver: boolean; // don't auto-load full-res media
  // Privacy
  sendReadReceipts: boolean;
  sendPresence: boolean;
  // Notifications
  soundOnMessage: boolean;
  showDesktopNotifications: boolean;
}

const DEFAULTS: Prefs = {
  theme: "system",
  accent: DEFAULT_ACCENT,
  tintedWindow: true,
  messageDensity: "comfortable",
  fontScale: 1,
  sendOnEnter: true,
  showTypingIndicators: true,
  sendTypingNotifications: true,
  renderReactions: true,
  coloredSenderNames: true,
  animatedEmotes: true,
  groupingWindowMinutes: 5,
  jumboEmoji: true,
  autoplayGifs: true,
  autoplayVideos: false,
  dataSaver: false,
  sendReadReceipts: true,
  sendPresence: true,
  soundOnMessage: true,
  showDesktopNotifications: true,
};

const KEY = "discourse.prefs.v1";

function load(): Prefs {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return { ...DEFAULTS };
    const prefs = { ...DEFAULTS, ...(JSON.parse(raw) as Partial<Prefs>) };
    // The light theme option is disabled; migrate previously stored values.
    if (prefs.theme === "light") prefs.theme = "dark";
    // Pre-cat-icon default accent: stored hex meant "Default", follow it.
    if (prefs.accent === "#c65cf5") prefs.accent = DEFAULT_ACCENT;
    return prefs;
  } catch {
    return { ...DEFAULTS };
  }
}

class PreferencesStore extends Store<Prefs> {
  constructor() {
    super(load());
    this.apply(this.value);
  }

  get<K extends keyof Prefs>(key: K): Prefs[K] {
    return this.value[key];
  }

  patch(patch: Partial<Prefs>): void {
    const next = { ...this.value, ...patch };
    localStorage.setItem(KEY, JSON.stringify(next));
    this.set(next);
    this.apply(next);
  }

  /** Reflect appearance prefs onto the document (theme, accent, density, scale). */
  private apply(p: Prefs): void {
    const root = document.documentElement;
    // Light mode is disabled for now: "system" resolves to dark instead of
    // following the OS. Restore the matchMedia branch to re-enable it.
    const resolved = p.theme === "system" ? "dark" : p.theme;
    root.setAttribute("data-theme", resolved);
    root.setAttribute("data-density", p.messageDensity);
    // "system" resolves to the OS accent where the browser exposes it.
    const accent =
      p.accent === SYSTEM_ACCENT
        ? systemAccentSupported
          ? "AccentColor"
          : DEFAULT_ACCENT
        : p.accent;
    root.style.setProperty("--accent", accent);
    // Multiplies every color-mix tint amount in theme.css: 1 = accent-washed
    // surfaces, 0 = plain grays.
    root.style.setProperty("--tint-on", p.tintedWindow ? "1" : "0");
    root.style.setProperty("--font-scale", String(p.fontScale));
    if (p.messageDensity === "compact") {
      root.style.setProperty("--row-padding-y", "2px");
      root.style.setProperty("--row-gap", "0px");
    } else {
      root.style.setProperty("--row-padding-y", "6px");
      root.style.setProperty("--row-gap", "2px");
    }
  }
}

/** Global singleton; preferences are account-independent. */
export const preferences = new PreferencesStore();

// React to system theme changes when following the system.
window
  .matchMedia("(prefers-color-scheme: light)")
  .addEventListener("change", () => {
    if (preferences.get("theme") === "system") {
      preferences.patch({}); // re-applies with the new system value
    }
  });
