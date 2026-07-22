// Composer autocomplete: trailing-token detection for @-mentions and :emoji:,
// plus inline unicode-shortcode auto-replace. Everything operates on the
// trailing token at the caret; the trigger char must be at a word start (field
// start or preceded by whitespace); lists cap at 6 (mentions) and 8 (emoji).

export interface MemberLike {
  userId: string;
  displayName?: string;
  /** Lowercased, accent-folded display name for fast matching. */
  foldedName: string;
  avatarUrl?: string;
}

export interface MentionMatch {
  member: MemberLike;
}

export interface EmojiSuggestion {
  /** `:shortcode:` for custom emotes or unicode; label shown in the row. */
  label: string;
  /** For unicode: the glyph to insert. For custom: the `:shortcode:` token. */
  insert: string;
  /** mxc URL for a custom emote image (renders via a loader), else undefined. */
  mxc?: string;
}

const MENTION_CAP = 6;
const EMOJI_CAP = 8;

/** Fold once for matching: lowercase and strip diacritics. */
export function fold(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "");
}

function isShortcodeChar(c: string): boolean {
  return /[a-z0-9_+-]/i.test(c);
}

function wordStart(text: string, at: number): boolean {
  return at === 0 || /\s/.test(text[at - 1]);
}

/** The trailing `@token` at the caret, or undefined. */
export function mentionQuery(text: string, caret: number): { at: number; query: string } | undefined {
  const upto = text.slice(0, caret);
  const at = upto.lastIndexOf("@");
  if (at === -1) return undefined;
  if (!wordStart(upto, at)) return undefined;
  const token = upto.slice(at + 1);
  if (/\s/.test(token)) return undefined;
  return { at, query: token };
}

/** The trailing `:token` at the caret (2 or more shortcode chars), or undefined. */
export function emojiQuery(text: string, caret: number): { at: number; query: string } | undefined {
  const upto = text.slice(0, caret);
  const at = upto.lastIndexOf(":");
  if (at === -1) return undefined;
  if (!wordStart(upto, at)) return undefined;
  const token = upto.slice(at + 1);
  if (token.length < 2) return undefined;
  if (![...token].every(isShortcodeChar)) return undefined;
  return { at, query: token };
}

/** Filter members by folded name or mxid substring, excluding self, cap 6. */
export function matchMentions(
  members: MemberLike[],
  query: string,
  ownUserId: string,
): MentionMatch[] {
  const q = fold(query);
  const out: MentionMatch[] = [];
  for (const m of members) {
    if (m.userId === ownUserId) continue;
    if (q === "" || m.foldedName.includes(q) || m.userId.toLowerCase().includes(q)) {
      out.push({ member: m });
      if (out.length >= MENTION_CAP) break;
    }
  }
  return out;
}

/**
 * Build the emoji suggestion list: custom-emote prefix matches, then unicode,
 * then custom-emote contains matches, capped at 8. Both sources are pluggable
 * and either may be undefined.
 */
export function buildEmojiSuggestions(
  query: string,
  sources: {
    customEmotes?: (q: string) => { prefix: EmojiSuggestion[]; contains: EmojiSuggestion[] };
    unicode?: (q: string, limit: number) => EmojiSuggestion[];
  },
): EmojiSuggestion[] {
  const custom = sources.customEmotes?.(query) ?? { prefix: [], contains: [] };
  const unicode = sources.unicode?.(query, MENTION_CAP) ?? [];
  return [...custom.prefix, ...unicode, ...custom.contains].slice(0, EMOJI_CAP);
}

/** Replace the trailing @token with a matrix.to markdown mention and a space. */
export function applyMention(
  text: string,
  caret: number,
  at: number,
  member: MemberLike,
): { text: string; caret: number } {
  const name = member.displayName || member.userId;
  const link = `[${name}](https://matrix.to/#/${member.userId})`;
  const before = text.slice(0, at);
  const after = text.slice(caret);
  const inserted = `${link} `;
  return { text: before + inserted + after, caret: before.length + inserted.length };
}

/** Replace the trailing :token with the emoji insert and a space. */
export function applyEmoji(
  text: string,
  caret: number,
  at: number,
  suggestion: EmojiSuggestion,
): { text: string; caret: number } {
  const before = text.slice(0, at);
  const after = text.slice(caret);
  const inserted = `${suggestion.insert} `;
  return { text: before + inserted + after, caret: before.length + inserted.length };
}

/**
 * Inline auto-replace: when a closing `:` was just typed completing an exact
 * unicode shortcode at a word start, swap `:name:` for the glyph. Single-char
 * growth only, so pastes aren't rewritten. Returns undefined if nothing to do.
 * `lookup` maps a bare shortcode (no colons) to its glyph, else undefined.
 */
export function autoReplaceShortcode(
  oldText: string,
  newText: string,
  caret: number,
  lookup: (shortcode: string) => string | undefined,
): { text: string; caret: number } | undefined {
  if (newText.length - oldText.length !== 1) return undefined; // single-char growth only
  if (caret === 0 || newText[caret - 1] !== ":") return undefined;
  const upto = newText.slice(0, caret - 1);
  const open = upto.lastIndexOf(":");
  if (open === -1) return undefined;
  if (!wordStart(upto, open)) return undefined;
  const name = upto.slice(open + 1);
  if (name.length < 2 || ![...name].every(isShortcodeChar)) return undefined;
  const glyph = lookup(name);
  if (!glyph) return undefined;
  const before = newText.slice(0, open);
  const after = newText.slice(caret);
  return { text: before + glyph + after, caret: before.length + glyph.length };
}
