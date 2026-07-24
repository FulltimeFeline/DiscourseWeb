// The 13 accent swatches. "system" is the app default (`--accent` from
// theme.css). Selecting one writes the hex into the shared `preferences.accent`,
// which reflects onto `--accent` live.

export interface AccentSwatch {
  id: string;
  label: string;
  /** Hex for the swatch + the value written to preferences; null = app default. */
  hex: string | null;
}

// "Default" restores the theme value.
export const ACCENTS: AccentSwatch[] = [
  { id: "system", label: "Default", hex: null },
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

/** The default `--accent` from theme.css, used when "Default" is picked. Must
 *  match theme.css so the "Default" swatch isn't a duplicate of "Blue". */
export const DEFAULT_ACCENT = "#9059f1";
