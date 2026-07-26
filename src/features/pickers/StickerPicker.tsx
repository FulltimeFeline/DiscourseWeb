// The sticker picker. Two sources in one picker: personal packs (StickerStore)
// and room/space pack stickers (CustomEmojiStore.stickerPacks, only when a
// `sendPackSticker` handler is present). Recents at the top, follow-scroll pack
// tab bar, contains-search.
//
// Tapping a sticker fires the send callback and keeps the panel up for
// chaining. Personal stickers are recorded to recents.

import { useEffect, useMemo, useRef, useState } from "react";
import { Store, useStore } from "@/core/reactive";
import type { CustomEmojiStore, Emote, EmotePack } from "@/core/CustomEmojiStore";
import type { Sticker, StickerContent, StickerStore } from "@/core/StickerStore";
import { recentStickers, rememberSticker } from "./usage";
import { EmoteImage } from "./EmoteImage";
import { Icon } from "@/ui/Icon";
import "./StickerPicker.css";

const EMPTY_VERSION = new Store<number>(0);

export interface StickerPickerProps {
  /** Personal sticker store (packs from account data). */
  stickerStore: StickerStore;
  /** Custom-emote store for room/space sticker packs (optional). */
  customEmoji?: CustomEmojiStore;
  /** Send a personal sticker (m.sticker). */
  onSendPersonal: (content: StickerContent, sticker: Sticker) => void;
  /**
   * Send a room-pack (MSC2545) sticker by its emote. When absent, room packs
   * are hidden. Recovering missing w/h `info` before send is the handler's job.
   */
  onSendPackSticker?: (emote: Emote) => void;
}

interface Section {
  id: string;
  title: string;
  icon: React.ReactNode;
  personal?: Sticker[];
  pack?: EmotePack;
}

export function StickerPicker({
  stickerStore,
  customEmoji,
  onSendPersonal,
  onSendPackSticker,
}: StickerPickerProps) {
  const [query, setQuery] = useState("");
  const [activeId, setActiveId] = useState("");
  const scrollRef = useRef<HTMLDivElement>(null);
  const headerRefs = useRef(new Map<string, HTMLElement>());

  useStore(stickerStore.version);
  useStore(customEmoji?.version ?? EMPTY_VERSION);

  // Callers pass a fresh inline arrow for onSendPackSticker, so depend on its
  // presence rather than its identity — refresh() bumps version and would
  // otherwise re-run this effect forever.
  const wantPacks = !!onSendPackSticker;
  useEffect(() => {
    void stickerStore.refresh();
    if (wantPacks) void customEmoji?.refreshIfStale();
  }, [stickerStore, customEmoji, wantPacks]);

  const [recents, setRecents] = useState<Sticker[]>([]);
  useEffect(() => {
    const codes = recentStickers();
    const resolved = codes
      .map((c) => stickerStore.lookup(c))
      .filter((s): s is Sticker => !!s);
    setRecents(resolved);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stickerStore, stickerStore.version.value]);

  const sections = useMemo<Section[]>(() => {
    const out: Section[] = [];
    if (recents.length > 0) {
      out.push({
        id: "recents",
        title: "Recently Used",
        icon: <Icon name="clock" />,
        personal: recents,
      });
    }
    for (const pack of stickerStore.packs) {
      out.push({
        id: `personal:${pack.name}`,
        title: pack.name,
        icon: pack.stickers[0] ? (
          <EmoteImage mxc={pack.stickers[0].url} size={18} />
        ) : (
          <Icon name="star" />
        ),
        personal: pack.stickers,
      });
    }
    if (onSendPackSticker && customEmoji) {
      for (const pack of customEmoji.stickerPacks()) {
        out.push({
          id: `pack:${pack.id}`,
          title: pack.displayName,
          icon: pack.avatarUrl ? (
            <EmoteImage mxc={pack.avatarUrl} size={18} />
          ) : pack.emotes[0] ? (
            <EmoteImage mxc={pack.emotes[0].url} size={18} />
          ) : (
            <Icon name="star" />
          ),
          pack,
        });
      }
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recents, stickerStore, stickerStore.version.value, customEmoji, customEmoji?.version.value, onSendPackSticker]);

  useEffect(() => {
    const root = scrollRef.current;
    if (!root) return;
    const observer = new IntersectionObserver(
      (entries) => {
        let best: { id: string; top: number } | undefined;
        for (const entry of entries) {
          const id = entry.target.getAttribute("data-section-id");
          if (!id || !entry.isIntersecting) continue;
          const top = entry.boundingClientRect.top;
          if (!best || top < best.top) best = { id, top };
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
    const personal = stickerStore.search(q);
    const packMatches: Emote[] =
      onSendPackSticker && customEmoji
        ? customEmoji
            .stickerPacks()
            .flatMap((p) => p.emotes)
            .filter(
              (e) =>
                e.shortcode.toLowerCase().includes(q.toLowerCase()) ||
                (e.body ?? "").toLowerCase().includes(q.toLowerCase()),
            )
        : [];
    return { personal, packMatches };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, stickerStore, customEmoji, onSendPackSticker, customEmoji?.version.value]);

  function contentFor(s: Sticker): StickerContent {
    return {
      body: s.body,
      url: s.url,
      info: s.info,
    };
  }
  function sendPersonal(s: Sticker) {
    rememberSticker(s.shortcode);
    setRecents(recentStickers().map((c) => stickerStore.lookup(c)).filter((x): x is Sticker => !!x));
    onSendPersonal(contentFor(s), s);
  }

  function jumpTo(id: string) {
    headerRefs.current.get(id)?.scrollIntoView({ block: "start" });
    setActiveId(id);
  }
  const registerHeader = (id: string) => (el: HTMLElement | null) => {
    if (el) headerRefs.current.set(id, el);
    else headerRefs.current.delete(id);
  };

  const isEmpty = sections.length === 0;

  return (
    <div className="sticker-picker">
      <div className="sticker-picker__search">
        <input
          type="text"
          placeholder="Search stickers"
          value={query}
          autoCorrect="off"
          spellCheck={false}
          onChange={(e) => setQuery(e.target.value)}
          aria-label="Search stickers"
        />
        {query && (
          <button
            className="sticker-picker__clear"
            aria-label="Clear search"
            onClick={() => setQuery("")}
          >
            <Icon name="x" size={14} />
          </button>
        )}
      </div>

      <div className="sticker-picker__scroll" ref={scrollRef}>
        {isEmpty ? (
          <div className="sticker-picker__empty">
            No stickers yet — make some in Settings → Stickers.
          </div>
        ) : results ? (
          results.personal.length === 0 && results.packMatches.length === 0 ? (
            <div className="sticker-picker__empty">No stickers found</div>
          ) : (
            <section className="sticker-picker__section">
              <div className="sticker-picker__grid">
                {results.personal.map((s) => (
                  <button
                    key={`p:${s.shortcode}`}
                    className="sticker-picker__cell"
                    title={`:${s.shortcode}:`}
                    onClick={() => sendPersonal(s)}
                  >
                    <EmoteImage mxc={s.url} size={64} alt={s.body} />
                  </button>
                ))}
                {results.packMatches.map((e) => (
                  <button
                    key={`e:${e.url}`}
                    className="sticker-picker__cell"
                    title={`:${e.shortcode}:`}
                    onClick={() => onSendPackSticker?.(e)}
                  >
                    <EmoteImage mxc={e.url} size={64} alt={`:${e.shortcode}:`} />
                  </button>
                ))}
              </div>
            </section>
          )
        ) : (
          sections.map((s) => (
            <section key={s.id} className="sticker-picker__section">
              <h4
                className="sticker-picker__header"
                data-section-id={s.id}
                ref={registerHeader(s.id)}
              >
                {s.title}
              </h4>
              <div className="sticker-picker__grid">
                {s.personal?.map((st) => (
                  <button
                    key={`p:${st.shortcode}`}
                    className="sticker-picker__cell"
                    title={`:${st.shortcode}:`}
                    onClick={() => sendPersonal(st)}
                  >
                    <EmoteImage mxc={st.url} size={64} alt={st.body} />
                  </button>
                ))}
                {s.pack?.emotes.map((e) => (
                  <button
                    key={`e:${e.url}`}
                    className="sticker-picker__cell"
                    title={`:${e.shortcode}:`}
                    onClick={() => onSendPackSticker?.(e)}
                  >
                    <EmoteImage mxc={e.url} size={64} alt={`:${e.shortcode}:`} />
                  </button>
                ))}
              </div>
            </section>
          ))
        )}
      </div>

      {!isEmpty && !results && (
        <div className="sticker-picker__tabs" role="tablist">
          {sections.map((s) => (
            <button
              key={s.id}
              role="tab"
              aria-selected={activeId === s.id}
              className={
                "sticker-picker__tab" + (activeId === s.id ? " sticker-picker__tab--active" : "")
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
