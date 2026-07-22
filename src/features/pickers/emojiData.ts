// Unicode emoji dataset, self-hosted via the bundled `emojibase-data` npm
// package (no external CDN, per this project's CSP constraints).
//
// Imports emojibase's compact english dataset (small, ~1600 glyphs) plus its
// shortcode table. Both are static JSON bundled at build time.
//
// Requires the `emojibase-data` dependency (types ship with the package). If it
// is ever swapped for `@emoji-mart/data`, only this module changes: the rest of
// the picker consumes the normalized `EmojiDef` shape below.

// emojibase compact record shape (a subset of what the package emits).
interface CompactEmoji {
  annotation?: string;
  label?: string; // some builds label the annotation differently
  hexcode: string; // "1F600"
  group?: number; // category index 0..10 (see GROUP_ORDER)
  order?: number;
  tags?: string[];
  /** The actual emoji glyph character (emojibase compact field). */
  unicode?: string;
  emoji?: string; // some datasets use `emoji`
  /** Shortcodes embedded in the compact record (present in emojibase builds). */
  shortcodes?: string[];
  skins?: CompactEmoji[];
}

// Imported for their side of the contract only; resolved at build time.
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore -- provided by the `emojibase-data` package (see package.json)
import rawCompact from "emojibase-data/en/compact.json";
// Shortcode preset keyed by hexcode → shortcode | shortcode[]. Used only as a
// fallback when the compact record itself carries no `shortcodes` array.
// @ts-ignore -- provided by the `emojibase-data` package (see package.json)
import rawShortcodes from "emojibase-data/en/shortcodes/emojibase.json";

const compact = rawCompact as CompactEmoji[];
const shortcodeTable = rawShortcodes as Record<string, string | string[]>;

/** A normalized emoji entry the picker + autocomplete consume. */
export interface EmojiDef {
  /** The rendered glyph, e.g. "😀". */
  glyph: string;
  /** Unicode name / label, used for name search. */
  label: string;
  /** Primary shortcode WITHOUT colons, e.g. "grinning". */
  shortcode: string;
  /** All shortcodes (for `:code:` matching). */
  shortcodes: string[];
  /** Search tags. */
  tags: string[];
  /** Category id (see EMOJI_CATEGORIES). */
  category: string;
}

/** The categories, in fixed order, each with an emoji tab icon. */
export interface EmojiCategory {
  id: string;
  title: string;
  /** A representative glyph used as the tab-bar icon. */
  icon: string;
}

// emojibase groups (https://emojibase.dev): index → our category.
const GROUP_ORDER: { group: number; id: string; title: string; icon: string }[] = [
  { group: 0, id: "smileys", title: "Smileys & Emotion", icon: "😀" },
  { group: 1, id: "people", title: "People & Body", icon: "👋" },
  { group: 3, id: "animals", title: "Animals & Nature", icon: "🐻" },
  { group: 4, id: "food", title: "Food & Drink", icon: "🍔" },
  { group: 5, id: "travel", title: "Travel & Places", icon: "✈️" },
  { group: 6, id: "activities", title: "Activities", icon: "⚽️" },
  { group: 7, id: "objects", title: "Objects", icon: "💡" },
  { group: 8, id: "symbols", title: "Symbols", icon: "❤️" },
  { group: 9, id: "flags", title: "Flags", icon: "🏳️" },
];

export const EMOJI_CATEGORIES: EmojiCategory[] = GROUP_ORDER.map((g) => ({
  id: g.id,
  title: g.title,
  icon: g.icon,
}));

function normalizeShortcode(raw: string): string {
  return raw.replace(/:/g, "").toLowerCase();
}

function shortcodesFor(e: CompactEmoji): string[] {
  // Prefer the shortcodes embedded in the compact record; fall back to the
  // separate preset table keyed by hexcode.
  if (Array.isArray(e.shortcodes) && e.shortcodes.length) {
    return e.shortcodes.map(normalizeShortcode).filter(Boolean);
  }
  const entry = shortcodeTable?.[e.hexcode];
  if (!entry) return [];
  const arr = Array.isArray(entry) ? entry : [entry];
  return arr.map(normalizeShortcode).filter(Boolean);
}

const groupToId = new Map(GROUP_ORDER.map((g) => [g.group, g.id]));

// Build the flat, ordered emoji list once. Group 2 ("component", skin-tone
// modifiers) is excluded (no skin-tone grid). Entries without a group or glyph
// are dropped.
export const ALL_EMOJI: EmojiDef[] = (() => {
  const out: EmojiDef[] = [];
  for (const e of compact) {
    const glyph = e.unicode ?? e.emoji;
    if (!glyph || e.group == null) continue;
    const category = groupToId.get(e.group);
    if (!category) continue; // skips component group + anything unmapped
    const label = e.annotation ?? e.label ?? "";
    const shortcodes = shortcodesFor(e);
    const shortcode = shortcodes[0] ?? normalizeShortcode(label);
    out.push({
      glyph,
      label,
      shortcode,
      shortcodes: shortcodes.length ? shortcodes : [shortcode],
      tags: e.tags ?? [],
      category,
    });
  }
  return out;
})();

/** Emoji grouped by category, in EMOJI_CATEGORIES order (picker sections). */
export const EMOJI_BY_CATEGORY: { category: EmojiCategory; emoji: EmojiDef[] }[] =
  EMOJI_CATEGORIES.map((category) => ({
    category,
    emoji: ALL_EMOJI.filter((e) => e.category === category.id),
  })).filter((s) => s.emoji.length > 0);

// --- Search + shortcode lookup -------------------------------------------

const byShortcode = new Map<string, EmojiDef>();
for (const e of ALL_EMOJI) {
  for (const code of e.shortcodes) {
    if (!byShortcode.has(code)) byShortcode.set(code, e);
  }
}

/** Exact glyph for a complete unicode shortcode (no colons), else undefined. */
export function glyphForShortcode(code: string): string | undefined {
  return byShortcode.get(code.toLowerCase())?.glyph;
}

/** True if `code` (no colons) is a complete, known unicode shortcode. */
export function isKnownUnicodeShortcode(code: string): boolean {
  return byShortcode.has(code.toLowerCase());
}

/**
 * Name/label/shortcode search: prefix matches first, then contains. Matches
 * over label, tags, and shortcodes (case-insensitive). Returns up to `limit`.
 */
export function searchEmoji(needle: string, limit = 60): EmojiDef[] {
  const q = needle.trim().toLowerCase();
  if (!q) return [];
  const prefix: EmojiDef[] = [];
  const contains: EmojiDef[] = [];
  for (const e of ALL_EMOJI) {
    const hay = [e.label, ...e.shortcodes, ...e.tags];
    let matched: "prefix" | "contains" | null = null;
    for (const h of hay) {
      const lower = h.toLowerCase();
      if (lower.startsWith(q)) {
        matched = "prefix";
        break;
      }
      if (matched == null && lower.includes(q)) matched = "contains";
    }
    if (matched === "prefix") prefix.push(e);
    else if (matched === "contains") contains.push(e);
    if (prefix.length >= limit) break;
  }
  return [...prefix, ...contains].slice(0, limit);
}

/**
 * Shortcode-only matches for the `:code:` composer autocomplete. Prefix-first
 * then contains, over shortcodes only. Returns `{glyph, shortcode}` rows.
 */
export function matchShortcodes(
  needle: string,
  limit = 6,
): { glyph: string; shortcode: string }[] {
  const q = needle.replace(/:/g, "").trim().toLowerCase();
  if (!q) return [];
  const prefix: EmojiDef[] = [];
  const contains: EmojiDef[] = [];
  const seen = new Set<string>();
  for (const e of ALL_EMOJI) {
    if (seen.has(e.glyph)) continue;
    let matched: "prefix" | "contains" | null = null;
    for (const code of e.shortcodes) {
      if (code.startsWith(q)) {
        matched = "prefix";
        break;
      }
      if (matched == null && code.includes(q)) matched = "contains";
    }
    if (matched === "prefix") {
      prefix.push(e);
      seen.add(e.glyph);
    } else if (matched === "contains") {
      contains.push(e);
      seen.add(e.glyph);
    }
  }
  return [...prefix, ...contains]
    .slice(0, limit)
    .map((e) => ({ glyph: e.glyph, shortcode: e.shortcode }));
}
