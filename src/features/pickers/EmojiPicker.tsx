// The standard emoji picker.
//
// - Single continuous scroll of titled sections. Custom emoticon packs render
//   above the unicode categories; a "Frequently Used" recents section sits at
//   the very top when non-empty.
// - A bottom category/pack tab bar jumps to a section on tap and the highlight
//   follows the scroll (IntersectionObserver on section headers).
// - Search matches by unicode name/shortcode/tags (contains) plus custom emote
//   shortcode/body; empty results show an empty state.
// - onPick returns a unicode glyph or a custom emote { mxc, shortcode }.

import { useEffect, useMemo, useRef, useState } from "react";
import { Store, useStore } from "@/core/reactive";
import type { CustomEmojiStore, Emote, EmotePack } from "@/core/CustomEmojiStore";
import {
  EMOJI_BY_CATEGORY,
  searchEmoji,
  type EmojiDef,
} from "./emojiData";
import { recentEmoji, rememberEmoji } from "./usage";
import { EmoteImage } from "./EmoteImage";
import { Icon } from "@/ui/Icon";
import "./EmojiPicker.css";

// A stable empty Store so useStore is called unconditionally when customEmoji
// is absent (hooks rule).
const EMPTY_VERSION = new Store<number>(0);

export type EmojiPick =
  | { kind: "unicode"; glyph: string }
  | { kind: "custom"; mxc: string; shortcode: string };

export interface EmojiPickerProps {
  /** Custom-emote store. When provided, custom packs render above unicode. */
  customEmoji?: CustomEmojiStore;
  /** Fired on selection. Unicode glyphs are also recorded to recents. */
  onPick: (pick: EmojiPick) => void;
  /** Whether the surface supports custom emotes (composer/reaction: true). */
  allowCustom?: boolean;
}

interface Section {
  id: string;
  title: string;
  icon: React.ReactNode;
  kind: "recents" | "custom" | "unicode";
  unicode?: EmojiDef[];
  emotes?: Emote[];
  pack?: EmotePack;
}

export function EmojiPicker({ customEmoji, onPick, allowCustom = true }: EmojiPickerProps) {
  const [query, setQuery] = useState("");
  const [activeId, setActiveId] = useState<string>("");
  const scrollRef = useRef<HTMLDivElement>(null);
  const headerRefs = useRef(new Map<string, HTMLElement>());

  // Subscribe to custom-emote refreshes.
  useStore(customEmoji?.version ?? EMPTY_VERSION);

  // Refresh on open.
  useEffect(() => {
    if (allowCustom) void customEmoji?.refreshIfStale();
  }, [customEmoji, allowCustom]);

  const [recents, setRecents] = useState<string[]>(() => recentEmoji());

  const sections = useMemo<Section[]>(() => {
    const out: Section[] = [];
    if (recents.length > 0) {
      out.push({
        id: "recents",
        title: "Frequently Used",
        icon: <Icon name="clock" />,
        kind: "recents",
      });
    }
    if (allowCustom && customEmoji) {
      for (const pack of customEmoji.emoticonPacks()) {
        out.push({
          id: `pack:${pack.id}`,
          title: pack.displayName,
          icon: pack.avatarUrl ? (
            <EmoteImage mxc={pack.avatarUrl} size={18} />
          ) : (
            <Icon name="star" />
          ),
          kind: "custom",
          emotes: pack.emotes,
          pack,
        });
      }
    }
    for (const { category, emoji } of EMOJI_BY_CATEGORY) {
      out.push({
        id: `cat:${category.id}`,
        title: category.title,
        icon: <span aria-hidden>{category.icon}</span>,
        kind: "unicode",
        unicode: emoji,
      });
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recents, allowCustom, customEmoji, customEmoji?.version.value]);

  // Follow-scroll active tab: the last header to cross the top line wins.
  useEffect(() => {
    const root = scrollRef.current;
    if (!root) return;
    const observer = new IntersectionObserver(
      (entries) => {
        // Choose the top-most intersecting header (smallest boundingTop at or below root top).
        let best: { id: string; top: number } | undefined;
        for (const entry of entries) {
          const id = entry.target.getAttribute("data-section-id");
          if (!id) continue;
          if (entry.isIntersecting) {
            const top = entry.boundingClientRect.top;
            if (!best || top < best.top) best = { id, top };
          }
        }
        if (best) setActiveId(best.id);
      },
      { root, rootMargin: "0px 0px -85% 0px", threshold: 0 },
    );
    for (const el of headerRefs.current.values()) observer.observe(el);
    return () => observer.disconnect();
  }, [sections]);

  const results = useMemo(() => {
    const q = query.trim();
    if (!q) return null;
    const unicode = searchEmoji(q, 60);
    const custom =
      allowCustom && customEmoji
        ? customEmoji.autocomplete(q, 40)
        : [];
    return { unicode, custom };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, allowCustom, customEmoji, customEmoji?.version.value]);

  function pickUnicode(glyph: string) {
    rememberEmoji(glyph);
    setRecents(recentEmoji());
    onPick({ kind: "unicode", glyph });
  }
  function pickCustom(e: Emote) {
    onPick({ kind: "custom", mxc: e.url, shortcode: e.shortcode });
  }

  function jumpTo(id: string) {
    const el = headerRefs.current.get(id);
    el?.scrollIntoView({ block: "start" });
    setActiveId(id);
  }

  const registerHeader = (id: string) => (el: HTMLElement | null) => {
    if (el) headerRefs.current.set(id, el);
    else headerRefs.current.delete(id);
  };

  return (
    <div className="emoji-picker">
      <div className="emoji-picker__search">
        <input
          type="text"
          placeholder="Search emoji"
          value={query}
          autoCorrect="off"
          autoCapitalize="none"
          spellCheck={false}
          onChange={(e) => setQuery(e.target.value)}
          aria-label="Search emoji"
        />
        {query && (
          <button
            className="emoji-picker__clear"
            aria-label="Clear search"
            onClick={() => setQuery("")}
          >
            <Icon name="x" size={14} />
          </button>
        )}
      </div>

      <div className="emoji-picker__scroll" ref={scrollRef}>
        {results ? (
          results.unicode.length === 0 && results.custom.length === 0 ? (
            <div className="emoji-picker__empty">No emoji found</div>
          ) : (
            <>
              {results.custom.length > 0 && (
                <section className="emoji-picker__section">
                  <div className="emoji-picker__grid">
                    {results.custom.map((e) => (
                      <button
                        key={`c:${e.url}`}
                        className="emoji-picker__cell"
                        title={`:${e.shortcode}:`}
                        onClick={() => pickCustom(e)}
                      >
                        <EmoteImage mxc={e.url} size={26} alt={`:${e.shortcode}:`} />
                      </button>
                    ))}
                  </div>
                </section>
              )}
              <section className="emoji-picker__section">
                <div className="emoji-picker__grid">
                  {results.unicode.map((e) => (
                    <button
                      key={`u:${e.glyph}`}
                      className="emoji-picker__cell emoji-picker__cell--glyph"
                      title={e.label}
                      onClick={() => pickUnicode(e.glyph)}
                    >
                      {e.glyph}
                    </button>
                  ))}
                </div>
              </section>
            </>
          )
        ) : (
          sections.map((s) => (
            <section key={s.id} className="emoji-picker__section">
              <h4
                className="emoji-picker__header"
                data-section-id={s.id}
                ref={registerHeader(s.id)}
              >
                {s.title}
              </h4>
              <div className="emoji-picker__grid">
                {s.kind === "recents" &&
                  recents.map((g) => (
                    <button
                      key={`r:${g}`}
                      className="emoji-picker__cell emoji-picker__cell--glyph"
                      onClick={() => pickUnicode(g)}
                    >
                      {g}
                    </button>
                  ))}
                {s.kind === "unicode" &&
                  s.unicode!.map((e) => (
                    <button
                      key={`u:${e.glyph}`}
                      className="emoji-picker__cell emoji-picker__cell--glyph"
                      title={e.label}
                      onClick={() => pickUnicode(e.glyph)}
                    >
                      {e.glyph}
                    </button>
                  ))}
                {s.kind === "custom" &&
                  s.emotes!.map((e) => (
                    <button
                      key={`c:${e.url}`}
                      className="emoji-picker__cell"
                      title={`:${e.shortcode}:`}
                      onClick={() => pickCustom(e)}
                    >
                      <EmoteImage mxc={e.url} size={26} alt={`:${e.shortcode}:`} />
                    </button>
                  ))}
              </div>
            </section>
          ))
        )}
      </div>

      {!results && (
        <div className="emoji-picker__tabs" role="tablist">
          {sections.map((s) => (
            <button
              key={s.id}
              role="tab"
              aria-selected={activeId === s.id}
              className={
                "emoji-picker__tab" + (activeId === s.id ? " emoji-picker__tab--active" : "")
              }
              title={s.title}
              onClick={() => jumpTo(s.id)}
            >
              {s.icon}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
