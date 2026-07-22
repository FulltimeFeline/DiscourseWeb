// Personal sticker storage + sending.
//
// Personal stickers live in the `im.ponies.user_emotes` account-data event
// (shared with the personal custom-emoji pack). Ownership: an entry is "ours"
// (a sticker) iff its `usage` contains "sticker" OR it carries the
// `es.discourse.pack` tag. Foreign custom-emoji entries in the same event MUST
// be preserved verbatim on save: never imported, rewritten, or clobbered.
//
// Sending emits an `m.sticker` event via `room.sendRaw("m.sticker", content)`.

import type { MatrixSession } from "./MatrixSession";
import { Store } from "./reactive";

const USER_EMOTES_EVENT = "im.ponies.user_emotes";
const DISCOURSE_PACK_TAG = "es.discourse.pack";
const DEFAULT_PACK = "My Stickers";

export interface Sticker {
  /** Shortcode WITHOUT colons (unique among our own entries). */
  shortcode: string;
  url: string;
  body: string;
  /** Discourse pack grouping name. */
  pack: string;
  info?: { w?: number; h?: number; mimetype?: string; size?: number };
}

export interface StickerPack {
  name: string;
  stickers: Sticker[];
}

/** m.sticker content shape. */
export interface StickerContent {
  body: string;
  url: string;
  info?: { w?: number; h?: number; mimetype?: string; size?: number };
}

function isOursEntry(entry: any): boolean {
  if (!entry || typeof entry !== "object") return false;
  const usage = Array.isArray(entry.usage) ? entry.usage : [];
  return usage.includes("sticker") || DISCOURSE_PACK_TAG in entry;
}

export class StickerStore {
  readonly version = new Store<number>(0);

  /** Our own stickers, grouped into display packs. */
  packs: StickerPack[] = [];

  /** The last raw server content (so save can preserve foreign entries). */
  private serverContent: any = { images: {} };
  private loaded = false;

  constructor(private session: MatrixSession) {}

  /** Load personal stickers from account data (idempotent-ish; re-reads). */
  async refresh(): Promise<void> {
    try {
      const raw = await this.session.client.accountData(USER_EMOTES_EVENT);
      this.serverContent = raw ? JSON.parse(raw) : { images: {} };
    } catch {
      this.serverContent = { images: {} };
    }
    this.loaded = true;
    this.rebuild();
  }

  private rebuild(): void {
    const images = this.serverContent.images ?? {};
    const byPack = new Map<string, Sticker[]>();
    for (const [code, entry] of Object.entries<any>(images)) {
      if (!isOursEntry(entry) || typeof entry.url !== "string") continue;
      const packName =
        typeof entry[DISCOURSE_PACK_TAG] === "string" && entry[DISCOURSE_PACK_TAG]
          ? entry[DISCOURSE_PACK_TAG]
          : DEFAULT_PACK;
      const sticker: Sticker = {
        shortcode: code.replace(/:/g, ""),
        url: entry.url,
        body: typeof entry.body === "string" ? entry.body : code,
        pack: packName,
        info: entry.info,
      };
      const list = byPack.get(packName) ?? [];
      list.push(sticker);
      byPack.set(packName, list);
    }
    this.packs = [...byPack.entries()].map(([name, stickers]) => ({ name, stickers }));
    this.version.update((n) => n + 1);
  }

  /** Flat list of our stickers (for search). */
  allStickers(): Sticker[] {
    return this.packs.flatMap((p) => p.stickers);
  }

  /** Lookup a personal sticker by shortcode (for recents). */
  lookup(shortcode: string): Sticker | undefined {
    return this.allStickers().find((s) => s.shortcode === shortcode);
  }

  /** Case-insensitive contains search over shortcode + body. */
  search(needle: string): Sticker[] {
    const q = needle.trim().toLowerCase();
    if (!q) return [];
    return this.allStickers().filter(
      (s) => s.shortcode.toLowerCase().includes(q) || s.body.toLowerCase().includes(q),
    );
  }

  // --- Sending -------------------------------------------------------------

  /**
   * Send a sticker as an `m.sticker` event into a room. Missing w/h `info` is
   * NOT recovered here (do that before calling if you have the bytes); callers
   * for personal stickers should also call `rememberSticker(shortcode)`.
   */
  async send(roomId: string, content: StickerContent): Promise<boolean> {
    const room = this.session.getRoom(roomId);
    if (!room) return false;
    try {
      await room.sendRaw("m.sticker", JSON.stringify(content));
      return true;
    } catch {
      return false;
    }
  }

  // --- Saving (foreign-entry preservation) ---------------------------------

  /**
   * Persist the given full sticker list. Drops only OUR own entries from the
   * server content, re-adds all local stickers, leaves foreign entries
   * verbatim, never overwrites a foreign shortcode. Adds a default
   * `pack.display_name` if absent.
   */
  async save(stickers: Sticker[]): Promise<boolean> {
    if (!this.loaded) await this.refresh();
    const images = { ...(this.serverContent.images ?? {}) };
    // Drop only our own entries.
    for (const [code, entry] of Object.entries<any>(images)) {
      if (isOursEntry(entry)) delete images[code];
    }
    // Re-add local stickers, avoiding collisions with foreign shortcodes.
    for (const s of stickers) {
      let code = s.shortcode;
      while (code in images && !isOursEntry(images[code])) code = `${code}_`;
      images[code] = {
        url: s.url,
        body: s.body,
        usage: ["sticker"],
        [DISCOURSE_PACK_TAG]: s.pack,
        info: s.info,
      };
    }
    const content = { ...this.serverContent, images };
    if (!content.pack) content.pack = {};
    if (!content.pack.display_name) content.pack.display_name = "Discourse";
    try {
      await this.session.client.setAccountData(USER_EMOTES_EVENT, JSON.stringify(content));
      this.serverContent = content;
      this.rebuild();
      return true;
    } catch {
      return false;
    }
  }
}
