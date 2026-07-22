// Render a message body with inline MSC2545 custom emotes (mxc <img>) plus
// `:shortcode:` substitution, with jumbo sizing when the message is emote-only.
//
// Resolution order for the token-to-mxc map:
//   1. `<img data-mx-emoticon>` (or marker-less mxc imgs with `:code:` alt) in
//      the formatted HTML body.
//   2. Fallback: locally-known emotes matched against `:tokens:` in the plain
//      body (when the HTML never arrived).
// Until an image loads, the literal `:token:` is shown (handled by EmoteImage's
// empty alt and the browser's own load lifecycle; we keep the token as alt text).

import { useMemo } from "react";
import type { CustomEmojiStore } from "@/core/CustomEmojiStore";
import { EmoteImage } from "../pickers/EmoteImage";
import {
  isEmoteOnly,
  parseInlineEmotes,
  segmentBody,
  type EmoteSegment,
} from "./inlineEmotes";
import "./EmoteText.css";

export interface EmoteTextProps {
  /** Plain text body (keeps `:token:` text). */
  body: string;
  /** Formatted HTML body, if the event carried org.matrix.custom.html. */
  html?: string;
  /** Local emote store for the fallback token map. */
  customEmoji?: CustomEmojiStore;
  /** Base inline cap height in px (default 20); jumbo is ~44px. */
  size?: number;
  className?: string;
}

const JUMBO_MAX = 6;

export function EmoteText({ body, html, customEmoji, size = 20, className }: EmoteTextProps) {
  const segments = useMemo<EmoteSegment[]>(() => {
    const tokenMap = new Map<string, string>();
    if (html) {
      for (const [token, mxc] of parseInlineEmotes(html)) tokenMap.set(token, mxc);
    }
    // Fallback: fill in any tokens the HTML didn't cover from local emotes.
    if (customEmoji) {
      for (const [token, emote] of customEmoji.knownEmotesIn(body)) {
        if (!tokenMap.has(token.toLowerCase())) tokenMap.set(token.toLowerCase(), emote.url);
      }
    }
    return segmentBody(body, tokenMap);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [body, html, customEmoji, customEmoji?.version.value]);

  const emoteCount = segments.filter((s) => s.type === "emote").length;
  const jumbo = isEmoteOnly(segments) && emoteCount <= JUMBO_MAX;
  const px = jumbo ? 44 : size;

  return (
    <span className={"emote-text" + (className ? ` ${className}` : "")}>
      {segments.map((seg, i) =>
        seg.type === "text" ? (
          <span key={i}>{seg.text}</span>
        ) : (
          <EmoteImage
            key={i}
            mxc={seg.mxc}
            alt={`:${seg.shortcode}:`}
            title={`:${seg.shortcode}:`}
            size={px}
            className={"emote-text__img" + (jumbo ? " emote-text__img--jumbo" : "")}
          />
        ),
      )}
    </span>
  );
}
