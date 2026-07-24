// The accent swatches. "Default" is the app accent (the icon purple baked
// into theme.css); "System" follows the OS accent via the CSS `AccentColor`
// keyword and is only offered where the browser supports it. Selecting a
// swatch writes its value into the shared `preferences.accent`, which
// reflects onto `--accent` live.

import { DEFAULT_ACCENT, SYSTEM_ACCENT, systemAccentSupported } from "../../core/Preferences";

export { DEFAULT_ACCENT, SYSTEM_ACCENT, systemAccentSupported };

export interface AccentSwatch {
  id: string;
  label: string;
  /** Hex (or the SYSTEM_ACCENT sentinel) written to preferences; null = app default. */
  hex: string | null;
}

export const ACCENTS: AccentSwatch[] = [
  { id: "default", label: "Default", hex: null },
  { id: "system", label: "System", hex: SYSTEM_ACCENT },
  { id: "blue", label: "Blue", hex: "#3b82f6" },
  { id: "indigo", label: "Indigo", hex: "#6366f1" },
  { id: "purple", label: "Purple", hex: "#a855f7" },
  { id: "pink", label: "Pink", hex: "#ec4899" },
  { id: "red", label: "Red", hex: "#ef4444" },
  { id: "orange", label: "Orange", hex: "#f97316" },
  { id: "yellow", label: "Yellow", hex: "#eab308" },
  { id: "green", label: "Green", hex: "#22c55e" },
  { id: "teal", label: "Teal", hex: "#14b8a6" },
  { id: "mint", label: "Mint", hex: "#2dd4bf" },
  { id: "brown", label: "Brown", hex: "#a16207" },
  { id: "graphite", label: "Graphite", hex: "#6b7280" },
];
