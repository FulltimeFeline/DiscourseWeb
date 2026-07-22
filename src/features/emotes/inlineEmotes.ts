// MSC2545 inline-emote parsing and HTML-body generation (pure functions).
// Shared by EmoteText (incoming render) and the composer send path.

import type { CustomEmojiStore } from "@/core/CustomEmojiStore";

const MXC_INVALID = /[\s"'<>&]/;
export function isValidMxc(url: string): boolean {
  return url.startsWith("mxc://") && !MXC_INVALID.test(url);
}

/**
 * Parse an MSC2545 formatted (HTML) body into a `:shortcode: → mxc` map.
 * Accepts `<img data-mx-emoticon>` OR any mxc `<img>` whose alt/title is a bare
 * `:shortcode:` (some clients omit the marker attribute).
 */
export function parseInlineEmotes(html: string): Map<string, string> {
  const out = new Map<string, string>();
  if (!html) return out;
  const imgRe = /<img\b[^>]*>/gi;
  let m: RegExpExecArray | null;
  while ((m = imgRe.exec(html))) {
    const tag = m[0];
    const src = attr(tag, "src");
    if (!src || !src.startsWith("mxc://")) continue;
    const hasMarker = /\bdata-mx-emoticon\b/i.test(tag);
    const alt = attr(tag, "alt") ?? attr(tag, "title") ?? "";
    const code = alt.match(/^:([a-z0-9_+\-.]+):$/i)?.[0];
    if (hasMarker) {
      const token = code ?? (alt ? `:${alt.replace(/:/g, "")}:` : undefined);
      if (token) out.set(token.toLowerCase(), src);
    } else if (code) {
      out.set(code.toLowerCase(), src);
    }
  }
  return out;
}

function attr(tag: string, name: string): string | undefined {
  const m = tag.match(new RegExp(`\\b${name}\\s*=\\s*"([^"]*)"`, "i"));
  return m ? decodeHtml(m[1]) : undefined;
}

function decodeHtml(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** A rendered inline segment: literal text or an emote image. */
export type EmoteSegment =
  | { type: "text"; text: string }
  | { type: "emote"; token: string; mxc: string; shortcode: string };

/**
 * Split a plain body into text + emote segments, given a `token → mxc` map
 * (from parseInlineEmotes and/or the local knownEmotes fallback).
 */
export function segmentBody(
  body: string,
  tokenToMxc: Map<string, string>,
): EmoteSegment[] {
  if (tokenToMxc.size === 0) return [{ type: "text", text: body }];
  // Build a regex over the known tokens (they are `:code:` strings).
  const tokens = [...tokenToMxc.keys()];
  const codes = tokens.map((t) => t.replace(/^:|:$/g, ""));
  const re = new RegExp(`:(${codes.map(escapeRe).join("|")}):`, "gi");
  const segments: EmoteSegment[] = [];
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body))) {
    if (m.index > last) segments.push({ type: "text", text: body.slice(last, m.index) });
    const token = m[0].toLowerCase();
    const mxc = tokenToMxc.get(token);
    if (mxc) {
      segments.push({ type: "emote", token: m[0], mxc, shortcode: m[1] });
    } else {
      segments.push({ type: "text", text: m[0] });
    }
    last = m.index + m[0].length;
  }
  if (last < body.length) segments.push({ type: "text", text: body.slice(last) });
  return segments;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** True if the segments contain at least one emote and no non-whitespace text. */
export function isEmoteOnly(segments: EmoteSegment[]): boolean {
  let emoteCount = 0;
  for (const s of segments) {
    if (s.type === "emote") emoteCount++;
    else if (s.text.trim() !== "") return false;
  }
  return emoteCount > 0;
}

/**
 * Build the MSC2545 formatted (HTML) body for a plain message: scan for known
 * `:shortcode:` tokens and swap each for
 * `<img data-mx-emoticon src alt title height="32">`. Returns undefined when no
 * known emote is present (send a plain message then). Everything is
 * HTML-escaped and the mxc url is validated.
 */
export function buildHtmlBody(
  plain: string,
  store: CustomEmojiStore,
): { html: string; hasEmotes: boolean } | undefined {
  const re = /:([a-z0-9_+\-.]+):/gi;
  let found = false;
  let out = "";
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(plain))) {
    const emote = store.lookup(m[1]);
    if (!emote || !isValidMxc(emote.url)) continue;
    found = true;
    out += escapeHtml(plain.slice(last, m.index));
    const code = escapeHtml(`:${emote.shortcode}:`);
    out += `<img data-mx-emoticon src="${escapeHtml(emote.url)}" alt="${code}" title="${code}" height="32" />`;
    last = m.index + m[0].length;
  }
  if (!found) return undefined;
  out += escapeHtml(plain.slice(last));
  return { html: out, hasEmotes: true };
}
