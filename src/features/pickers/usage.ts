// Recents and usage tracking, persisted in localStorage.
//
// Formats are kept plain-glyph so a future skin-tone selector can't corrupt
// them. All access is defensive: localStorage may be unavailable (private
// mode), so every read/write is wrapped.

function readString(key: string): string {
  try {
    return localStorage.getItem(key) ?? "";
  } catch {
    return "";
  }
}

function writeString(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* storage full / unavailable */
  }
}

// --- Emoji recents ("Frequently Used") -----------------------------------

const RECENT_EMOJI_KEY = "recentEmoji";
const RECENT_EMOJI_MAX = 24;

/** Most-recent-first, de-duplicated, max 24 unicode glyphs. */
export function recentEmoji(): string[] {
  const raw = readString(RECENT_EMOJI_KEY).trim();
  if (!raw) return [];
  return raw.split(/\s+/).filter(Boolean).slice(0, RECENT_EMOJI_MAX);
}

/** Record a glyph as used; moves it to the front. */
export function rememberEmoji(glyph: string): void {
  if (!glyph) return;
  const list = [glyph, ...recentEmoji().filter((g) => g !== glyph)].slice(
    0,
    RECENT_EMOJI_MAX,
  );
  writeString(RECENT_EMOJI_KEY, list.join(" "));
}

// --- Reaction usage (quick-react palette) --------------------------------

const REACTION_USAGE_KEY = "reactionUsage";

/** Default quick reactions (seed set). */
export const DEFAULT_QUICK_REACTIONS = [
  "👍",
  "❤️",
  "😂",
  "🎉",
  "😮",
  "😢",
  "🔥",
  "👀",
];

// True-emoji test so text keys ("+1", "lol") never render blank in the palette.
const EMOJI_RE = /\p{Extended_Pictographic}/u;
function isTrueEmoji(key: string): boolean {
  return EMOJI_RE.test(key);
}

function readReactionCounts(): Record<string, number> {
  try {
    const parsed = JSON.parse(readString(REACTION_USAGE_KEY) || "{}");
    return typeof parsed === "object" && parsed ? parsed : {};
  } catch {
    return {};
  }
}

/** Record a unicode reaction key (mxc/custom keys are not recorded). */
export function rememberReaction(key: string): void {
  if (!key || !isTrueEmoji(key)) return;
  const counts = readReactionCounts();
  counts[key] = (counts[key] ?? 0) + 1;
  writeString(REACTION_USAGE_KEY, JSON.stringify(counts));
}

/**
 * Top-N most-used unicode reactions, filtered to true emoji, padded with the
 * default set so the palette is always full.
 */
export function topReactions(n = 5): string[] {
  const counts = readReactionCounts();
  const used = Object.entries(counts)
    .filter(([k]) => isTrueEmoji(k))
    .sort((a, b) => b[1] - a[1])
    .map(([k]) => k);
  const out: string[] = [];
  for (const k of [...used, ...DEFAULT_QUICK_REACTIONS]) {
    if (!out.includes(k)) out.push(k);
    if (out.length >= n) break;
  }
  return out.slice(0, n);
}

// --- Sticker recents ------------------------------------------------------

const RECENT_STICKERS_KEY = "recentStickers";
const RECENT_STICKERS_MAX = 16;

/** Most-recent-first shortcodes of recently sent personal stickers, max 16. */
export function recentStickers(): string[] {
  const raw = readString(RECENT_STICKERS_KEY).trim();
  if (!raw) return [];
  return raw.split(/\s+/).filter(Boolean).slice(0, RECENT_STICKERS_MAX);
}

export function rememberSticker(shortcode: string): void {
  if (!shortcode) return;
  const list = [
    shortcode,
    ...recentStickers().filter((s) => s !== shortcode),
  ].slice(0, RECENT_STICKERS_MAX);
  writeString(RECENT_STICKERS_KEY, list.join(" "));
}
