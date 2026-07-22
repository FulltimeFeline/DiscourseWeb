// Per-session provisioning for the custom-emoji / sticker / power-level-tag
// stores. The three stores exist (Core/CustomEmojiStore, Core/StickerStore,
// features/emotes/PowerLevelTags) but nothing constructs them per warm session,
// so `:shortcode:` emotes, custom-emote reactions, sticker packs, and role tags
// stay inactive. This module wires exactly one of each per session (keyed by
// userId, like verificationManagerFor / incomingCallStoreFor), feeds the
// CustomEmojiStore its space rail, kicks a first refresh a few seconds after
// creation, and exposes React hooks plus an EmojiSource builder for the composer.

import { useEffect } from "react";
import type { MatrixSession } from "@/core/MatrixSession";
import { CustomEmojiStore } from "@/core/CustomEmojiStore";
import { StickerStore } from "@/core/StickerStore";
import { useStore } from "@/core/reactive";
import { PowerLevelTagStore } from "./PowerLevelTags";
import { buildHtmlBody } from "./inlineEmotes";
import { glyphForShortcode, searchEmoji } from "@/features/pickers/emojiData";
import type { EmojiSource } from "@/features/timeline/Composer";
import type { EmojiSuggestion } from "@/features/timeline/composerAutocomplete";

// --- per-session bundle -------------------------------------------------------

interface EmojiSessionBundle {
  customEmoji: CustomEmojiStore;
  stickers: StickerStore;
  powerTags: PowerLevelTagStore;
  /** Await a fresh joined-spaces snapshot (before aggregating packs). */
  refreshSpaces: () => Promise<void>;
  /** Timers to clear on dispose. */
  timers: number[];
}

const bundles = new Map<string, EmojiSessionBundle>();

/**
 * A synchronous spaces cache. `CustomEmojiStore.setSpacesProvider` must be
 * synchronous, but the space list is only reachable asynchronously via
 * `session.spaceService.joinedSpaces()`. We keep the last snapshot here and
 * refresh it in the background. `joinedSpaces()` returns empty until sliding
 * sync has streamed the space list, so we retry fast at startup (the 60s poll
 * used to leave the snapshot empty for up to a minute, meaning no server emote
 * packs). Returns the sync getter plus an awaitable refresh (used on picker-open).
 */
function makeSpacesProvider(
  session: MatrixSession,
  timers: number[],
  onFilled: () => void,
): { get: () => { id: string; name: string }[]; refresh: () => Promise<void> } {
  let snapshot: { id: string; name: string }[] = [];
  let notified = false;

  const refresh = async () => {
    try {
      const spaces = await session.spaceService?.joinedSpaces();
      if (spaces) {
        snapshot = spaces.map((s) => ({ id: s.roomId, name: s.displayName }));
        // The first time spaces appear (shortly after a reload), aggregate packs
        // so custom emotes render in messages without opening the picker.
        if (!notified && snapshot.length > 0) {
          notified = true;
          onFilled();
        }
      }
    } catch {
      // keep the previous snapshot on transient failure
    }
  };

  // Prime immediately, then retry every 2s until spaces appear (or ~30s), then
  // settle into a slow 60s poll.
  void refresh();
  let tries = 0;
  const fast = window.setInterval(() => {
    void refresh().then(() => {
      tries++;
      if (snapshot.length > 0 || tries >= 15) {
        clearInterval(fast);
        timers.push(window.setInterval(() => void refresh(), 60_000));
      }
    });
  }, 2_000);
  timers.push(fast);

  return { get: () => snapshot, refresh };
}

function bundleFor(session: MatrixSession): EmojiSessionBundle {
  let b = bundles.get(session.userId);
  if (b) return b;

  const timers: number[] = [];
  const customEmoji = new CustomEmojiStore(session);
  const stickers = new StickerStore(session);
  const powerTags = new PowerLevelTagStore(session);

  // When the space list first fills after a reload, aggregate immediately so
  // custom emotes render in messages (not just the picker).
  const spaces = makeSpacesProvider(session, timers, () => {
    void customEmoji.refreshIfStale(true);
    void stickers.refresh();
  });
  customEmoji.setSpacesProvider(spaces.get);

  // Also kick a first aggregation ~2s after creation, so personal / opted-in /
  // current-room packs load even for accounts with no spaces.
  timers.push(
    window.setTimeout(() => {
      void customEmoji.refreshIfStale();
      void stickers.refresh();
    }, 2_000),
  );

  b = { customEmoji, stickers, powerTags, refreshSpaces: spaces.refresh, timers };
  bundles.set(session.userId, b);
  return b;
}

/**
 * Force a fresh aggregation of custom-emote + sticker packs, awaiting a fresh
 * joined-spaces snapshot FIRST (so server/space packs are included even if the
 * background snapshot is still empty). Called when the picker opens.
 */
export async function refreshEmotePacks(session: MatrixSession): Promise<void> {
  const b = bundleFor(session);
  await b.refreshSpaces();
  await Promise.all([b.customEmoji.refreshIfStale(true), b.stickers.refresh()]);
}

// --- accessors ----------------------------------------------------------------

export function customEmojiFor(session: MatrixSession): CustomEmojiStore {
  return bundleFor(session).customEmoji;
}

export function stickerStoreFor(session: MatrixSession): StickerStore {
  return bundleFor(session).stickers;
}

export function powerTagsFor(session: MatrixSession): PowerLevelTagStore {
  return bundleFor(session).powerTags;
}

/**
 * Tear down a session's emoji stores + timers. The integrator MUST call this on
 * logout (from AppState's session teardown), alongside disposeVerificationManager
 * / disposeIncomingCallStore / disposeRoomListScope.
 */
export function disposeEmojiSession(session: MatrixSession): void {
  const b = bundles.get(session.userId);
  if (!b) return;
  for (const t of b.timers) {
    clearTimeout(t);
    clearInterval(t);
  }
  bundles.delete(session.userId);
}

// --- React hooks --------------------------------------------------------------

/** Subscribe to custom-emote index rebuilds; returns the session's store. */
export function useCustomEmoji(session: MatrixSession): CustomEmojiStore {
  const store = customEmojiFor(session);
  useStore(store.version);
  return store;
}

/** Subscribe to sticker-pack changes; returns the session's store. */
export function useStickerStore(session: MatrixSession): StickerStore {
  const store = stickerStoreFor(session);
  useStore(store.version);
  return store;
}

/**
 * The PowerLevelTagStore isn't observable (it caches per-room lazily), so this
 * just returns the instance. Consumers resolve tags via `roleForSync` after
 * calling `ensure(roomId)`.
 */
export function usePowerTags(session: MatrixSession): PowerLevelTagStore {
  return powerTagsFor(session);
}

// --- EmojiSource builder (composer) ------------------------------------------

/**
 * Build the `EmojiSource` the Composer expects: custom-emote autocomplete
 * (prefix/contains split), unicode-emoji autocomplete, bare-shortcode → glyph
 * lookup for inline auto-replace, and the MSC2545 HTML-body builder. Ensures the
 * room's own emote pack is loaded (`ensureRoomPack`) so its emotes are usable
 * the moment the composer mounts.
 */
export function emojiSourceFor(session: MatrixSession, roomId: string): EmojiSource {
  const store = customEmojiFor(session);
  // Make the room's own pack available; fire-and-forget (rebuild bumps version).
  void store.ensureRoomPack(roomId);

  const toSuggestion = (e: {
    shortcode: string;
    url: string;
    body?: string;
  }): EmojiSuggestion => ({
    // Custom emotes stay tokens (`:code:`) and are converted to HTML at send.
    label: `:${e.shortcode}:`,
    insert: `:${e.shortcode}:`,
    mxc: e.url,
  });

  return {
    customEmotes: (q: string) => {
      const query = q.replace(/:/g, "").trim().toLowerCase();
      if (!query) return { prefix: [], contains: [] };
      const prefix: EmojiSuggestion[] = [];
      const contains: EmojiSuggestion[] = [];
      const seen = new Set<string>();
      for (const e of store.autocomplete(query, 12)) {
        if (seen.has(e.url)) continue;
        seen.add(e.url);
        (e.shortcode.startsWith(query) ? prefix : contains).push(toSuggestion(e));
      }
      return { prefix, contains };
    },
    unicode: (q: string, limit: number): EmojiSuggestion[] => {
      const query = q.replace(/:/g, "").trim();
      if (!query) return [];
      return searchEmoji(query, limit).map((e) => ({
        label: e.label,
        insert: e.glyph,
      }));
    },
    shortcodeLookup: (shortcode: string) => glyphForShortcode(shortcode),
    customHtml: (text: string) => buildHtmlBody(text, store)?.html,
  };
}
