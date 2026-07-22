// `:shortcode:` autocomplete plus closing-colon auto-replace for the composer.
// Pure functions the composer wires to its text field.

import type { CustomEmojiStore, Emote } from "@/core/CustomEmojiStore";
import { glyphForShortcode, isKnownUnicodeShortcode, matchShortcodes } from "@/features/pickers/emojiData";

/** A suggestion row. Custom inserts `:shortcode: `; unicode inserts a glyph. */
export type EmojiSuggestion =
  | { kind: "custom"; shortcode: string; mxc: string; body?: string }
  | { kind: "unicode"; shortcode: string; glyph: string };

const MAX_SUGGESTIONS = 8;
const CUSTOM_CAP = 6;
const UNICODE_CAP = 6;

/**
 * Given the full text and the caret index, detect an active `:code` query and
 * return the query string plus its start index, or undefined. The colon must be
 * at a word start (start of text or preceded by whitespace) and followed by at
 * least 2 shortcode characters. Suppressed when an `@` mention query is active
 * before the caret (a `@word` with no whitespace between it and the caret).
 */
export function detectColonQuery(
  text: string,
  caret: number,
): { query: string; start: number } | undefined {
  // Suppress while an @-mention query is active.
  const beforeCaret = text.slice(0, caret);
  const mentionMatch = beforeCaret.match(/(^|\s)@[^\s]*$/);
  if (mentionMatch) return undefined;

  // Find the last colon before the caret that begins a word.
  const m = beforeCaret.match(/(^|\s):([a-z0-9_+\-.]*)$/i);
  if (!m) return undefined;
  const query = m[2];
  if (query.length < 2) return undefined;
  const start = caret - query.length - 1; // index of the ':'
  return { query, start };
}

/**
 * Build the suggestion list for a `:code` query: custom emotes first (prefix,
 * then contains, cap 6) then unicode shortcode matches (cap 6), truncated to 8.
 */
export function emojiSuggestions(
  query: string,
  store?: CustomEmojiStore,
): EmojiSuggestion[] {
  const out: EmojiSuggestion[] = [];
  const seenGlyphs = new Set<string>();
  if (store) {
    const custom: Emote[] = store.autocomplete(query, CUSTOM_CAP);
    for (const e of custom) {
      out.push({ kind: "custom", shortcode: e.shortcode, mxc: e.url, body: e.body });
    }
  }
  const unicode = matchShortcodes(query, UNICODE_CAP);
  for (const u of unicode) {
    if (seenGlyphs.has(u.glyph)) continue;
    seenGlyphs.add(u.glyph);
    out.push({ kind: "unicode", shortcode: u.shortcode, glyph: u.glyph });
  }
  return out.slice(0, MAX_SUGGESTIONS);
}

/**
 * Closing-colon auto-replace: when the user just typed the closing `:` of a
 * complete, known unicode shortcode, swap `:code:` for the glyph inline. Custom
 * emotes stay as `:token:`. Guarded so `10:30:` and `@user:server` survive.
 *
 * Given text + caret (positioned right AFTER the just-typed `:`), returns the
 * replacement `{ text, caret }` or undefined if nothing should change.
 */
export function tryClosingColonReplace(
  text: string,
  caret: number,
): { text: string; caret: number } | undefined {
  if (caret === 0 || text[caret - 1] !== ":") return undefined;
  const before = text.slice(0, caret - 1);
  // Match a `:code` ending at the char before the closing colon, colon at a
  // word start, code has no digits-only "time" shape and isn't preceded by a
  // non-space word char (guards `10:30:` and `@user:server`).
  const m = before.match(/(^|\s):([a-z0-9_+\-]+)$/i);
  if (!m) return undefined;
  const code = m[2];
  // Reject pure-numeric codes (time-like) and unknown shortcodes.
  if (/^\d+$/.test(code)) return undefined;
  if (!isKnownUnicodeShortcode(code)) return undefined;
  const glyph = glyphForShortcode(code);
  if (!glyph) return undefined;
  const colonStart = caret - 1 - code.length - 1; // index of the opening ':'
  const next = text.slice(0, colonStart) + glyph + text.slice(caret);
  return { text: next, caret: colonStart + glyph.length };
}

/**
 * Apply a suggestion to the text: replace the active `:query` (from
 * detectColonQuery) with the suggestion. Custom becomes `:shortcode: ` (kept as a
 * token, converted at send); unicode becomes the glyph. Returns `{ text, caret }`.
 */
export function applySuggestion(
  text: string,
  colonStart: number,
  caretEnd: number,
  suggestion: EmojiSuggestion,
): { text: string; caret: number } {
  const insert =
    suggestion.kind === "custom" ? `:${suggestion.shortcode}: ` : suggestion.glyph;
  const next = text.slice(0, colonStart) + insert + text.slice(caretEnd);
  return { text: next, caret: colonStart + insert.length };
}
