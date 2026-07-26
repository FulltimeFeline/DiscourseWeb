// Text rendering helpers: markdown inline render (cached per raw body), jumbo
// emoji detection, and locale-aware timestamps.

import { marked } from "marked";
import { preferences } from "@/core/Preferences";
import { settingsPrefs } from "@/features/settings/settingsPrefs";
import { sanitizeHtml } from "./sanitize";

const bodyCache = new Map<string, string>();

marked.setOptions({ gfm: true, breaks: true });

/**
 * Render a plain-text body as inline markdown (bold/italic/code/links/quotes),
 * auto-linking bare URLs, and sanitise. Cached per raw string (bounded).
 */
export function renderMarkdown(body: string): string {
  const hit = bodyCache.get(body);
  if (hit != null) return hit;
  let html: string;
  try {
    html = marked.parse(body, { async: false }) as string;
  } catch {
    html = escapeHtml(body);
  }
  const clean = sanitizeHtml(html);
  if (bodyCache.size > 500) bodyCache.clear();
  bodyCache.set(body, clean);
  return clean;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

// Emoji detection (including ZWJ sequences and variation selectors) for jumbo sizing.
const EMOJI_RE =
  /(?:\p{Emoji_Presentation}|\p{Extended_Pictographic})(?:‍(?:\p{Emoji_Presentation}|\p{Extended_Pictographic}))*️?/gu;

/** True when the body is <=8 emoji and nothing else (jumbo rendering). */
export function isJumboEmoji(body: string): boolean {
  if (!preferences.get("jumboEmoji")) return false;
  const trimmed = body.trim();
  if (!trimmed) return false;
  const stripped = trimmed.replace(EMOJI_RE, "").replace(/\s/g, "");
  if (stripped.length > 0) return false;
  const count = (trimmed.match(EMOJI_RE) ?? []).length;
  return count >= 1 && count <= 8;
}

// --- timestamps ------------------------------------------------------------

function isToday(ts: number): boolean {
  const d = new Date(ts);
  const now = new Date();
  return (
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate()
  );
}

// hourCycle rather than hour12:false — the latter resolves to h24 in some
// locales and renders midnight as 24:05.
const timeOpts = (): Intl.DateTimeFormatOptions =>
  settingsPrefs.get("use24HourTime")
    ? { hour: "2-digit", minute: "2-digit", hourCycle: "h23" }
    : { hour: "2-digit", minute: "2-digit", hour12: true };

/** Header timestamp: hh:mm today, "MMM d, hh:mm" earlier. */
export function formatHeaderTime(ts: number): string {
  const d = new Date(ts);
  if (isToday(ts)) return d.toLocaleTimeString([], timeOpts());
  return d.toLocaleString([], { month: "short", day: "numeric", ...timeOpts() });
}

/** Grouped-row gutter timestamp: hh:mm. */
export function formatShortTime(ts: number): string {
  return new Date(ts).toLocaleTimeString([], timeOpts());
}

/** Full weekday and date for the day divider. */
export function formatDayDivider(ts: number): string {
  return new Date(ts).toLocaleDateString([], {
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
  });
}

/** "1:05" duration text from seconds. */
export function formatDuration(seconds: number | undefined): string {
  if (seconds == null || !isFinite(seconds)) return "";
  const s = Math.round(seconds);
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}:${r.toString().padStart(2, "0")}`;
}

/** Human file size ("1.2 MB"). */
export function formatSize(bytes: number | undefined): string {
  if (bytes == null) return "";
  const units = ["B", "KB", "MB", "GB"];
  let n = bytes;
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n.toFixed(n < 10 && i > 0 ? 1 : 0)} ${units[i]}`;
}
