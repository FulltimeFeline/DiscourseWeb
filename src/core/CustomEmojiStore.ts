// Custom emoji / emote (MSC2545) discovery + caching.
//
// Aggregates emote packs from four sources into `packs`, plus two derived
// indexes (`byShortcode`, `byUrl`). Backed by:
//   - personal:    `im.ponies.user_emotes` account data (emoticon-usage only)
//   - space packs: `im.ponies.room_emotes` STATE in every joined space
//   - opted-in:    rooms listed in `im.ponies.emote_rooms` account data
//   - session:     any room opened this session (`ensureRoomPack`)
//
// Arbitrary room state has no FFI reader in this SDK build, so per-room reads
// use `session.restGet(...)` against the client-server API (full-state
// discovery + per-key polling, on a cost-controlled cadence).
//
// A `Store<number>` version counter lets React views subscribe to refreshes
// (increment on every index rebuild).

import type { MatrixSession } from "./MatrixSession";
import { Store } from "./reactive";

export type EmoteUsage = "emoticon" | "sticker";

export interface Emote {
  /** Shortcode WITHOUT colons. */
  shortcode: string;
  /** mxc:// url. */
  url: string;
  body?: string;
  /** Empty = usable as BOTH emoticon and sticker (MSC2545). */
  usage: EmoteUsage[];
  info?: { w?: number; h?: number; mimetype?: string; size?: number };
  /** Owning pack id (stable per source+stateKey). */
  packId: string;
}

export interface EmotePack {
  id: string;
  displayName: string;
  avatarUrl?: string;
  emotes: Emote[];
  /** Ordering hint: 0 = personal, 1 = space/room packs. */
  order: number;
}

/** Injected by the session scope so the store sees the current space rail. */
export type SpacesProvider = () => { id: string; name: string }[];

const MXC_INVALID = /[\s"'<>&]/;
function validMxc(url: unknown): url is string {
  return typeof url === "string" && url.startsWith("mxc://") && !MXC_INVALID.test(url);
}

const PERSONAL_EVENT = "im.ponies.user_emotes";
const EMOTE_ROOMS_EVENT = "im.ponies.emote_rooms";
const ROOM_EMOTES_TYPE = "im.ponies.room_emotes";

const FULL_REFRESH_MS = 5 * 60 * 1000; // throttle full aggregation to 5 min
const ROOM_FULL_REFETCH_MS = 45 * 60 * 1000; // full room state refetch cadence

// Per-room cache: known state keys + last full-state fetch time, and the last
// resolved pack per state key.
interface RoomCache {
  stateKeys: Set<string>;
  lastFullFetch: number;
  packs: Map<string, EmotePack>; // stateKey → pack
}

function parseEmotePack(
  packId: string,
  content: any,
  order: number,
): EmotePack | undefined {
  if (!content || typeof content !== "object") return undefined;
  const images = content.images ?? content.emoticons; // MSC2545 uses `images`
  if (!images || typeof images !== "object") return undefined;
  const packUsage: EmoteUsage[] = normalizeUsage(content.pack?.usage);
  const emotes: Emote[] = [];
  for (const [rawCode, raw] of Object.entries<any>(images)) {
    if (!raw || !validMxc(raw.url)) continue;
    const shortcode = rawCode.replace(/:/g, "").toLowerCase();
    if (!shortcode) continue;
    const usage = raw.usage ? normalizeUsage(raw.usage) : packUsage;
    emotes.push({
      shortcode,
      url: raw.url,
      body: typeof raw.body === "string" ? raw.body : undefined,
      usage,
      info: raw.info
        ? {
            w: raw.info.w,
            h: raw.info.h,
            mimetype: raw.info.mimetype,
            size: raw.info.size,
          }
        : undefined,
      packId,
    });
  }
  if (emotes.length === 0) return undefined;
  return {
    id: packId,
    displayName:
      typeof content.pack?.display_name === "string" && content.pack.display_name
        ? content.pack.display_name
        : "Emotes",
    avatarUrl: validMxc(content.pack?.avatar_url) ? content.pack.avatar_url : undefined,
    emotes,
    order,
  };
}

function normalizeUsage(raw: unknown): EmoteUsage[] {
  if (!Array.isArray(raw)) return [];
  const out: EmoteUsage[] = [];
  for (const u of raw) {
    if (u === "emoticon" || u === "sticker") out.push(u);
  }
  return out;
}

/** True if the emote is usable as an emoticon (empty usage = both). */
export function isEmoticon(e: Emote): boolean {
  return e.usage.length === 0 || e.usage.includes("emoticon");
}
/** True if the emote is usable as a sticker (empty usage = both). */
export function isStickerEmote(e: Emote): boolean {
  return e.usage.length === 0 || e.usage.includes("sticker");
}

export class CustomEmojiStore {
  /** Bump on every index rebuild; views subscribe via useStore. */
  readonly version = new Store<number>(0);

  /** Aggregated packs: personal first, then room/space packs. */
  packs: EmotePack[] = [];
  /** shortcode → Emote (emoticon-usage only, personal prioritized). */
  byShortcode = new Map<string, Emote>();
  /** mxc url → Emote (any usage; backs image-reaction labelling). */
  byUrl = new Map<string, Emote>();

  private spacesProvider: SpacesProvider = () => [];

  private personalPack?: EmotePack;
  private roomCaches = new Map<string, RoomCache>(); // roomId → cache
  private optedInRoomIds = new Set<string>();
  private sessionRoomIds = new Set<string>();

  private lastFullRefresh = 0;
  private lastSpaceKey = "";
  private inflight?: Promise<void>;

  constructor(private session: MatrixSession) {}

  /** Wire the space-rail accessor (do not couple to room-list state). */
  setSpacesProvider(provider: SpacesProvider): void {
    this.spacesProvider = provider;
  }

  // --- Public lookups ------------------------------------------------------

  /** Look up an emoticon by shortcode (no colons). */
  lookup(shortcode: string): Emote | undefined {
    return this.byShortcode.get(shortcode.toLowerCase());
  }

  /** Resolve an mxc reaction/inline url back to its emote (for labels). */
  lookupByUrl(url: string): Emote | undefined {
    return this.byUrl.get(url);
  }

  /**
   * Autocomplete query over custom EMOTICONS: prefix matches first, then
   * contains, matching shortcode or body (colons stripped).
   */
  autocomplete(needle: string, limit = 6): Emote[] {
    const q = needle.replace(/:/g, "").trim().toLowerCase();
    if (!q) return [];
    const prefix: Emote[] = [];
    const contains: Emote[] = [];
    const seen = new Set<string>();
    for (const e of this.byShortcode.values()) {
      if (seen.has(e.url)) continue;
      const code = e.shortcode;
      const body = (e.body ?? "").toLowerCase();
      if (code.startsWith(q)) {
        prefix.push(e);
        seen.add(e.url);
      } else if (code.includes(q) || body.includes(q)) {
        contains.push(e);
        seen.add(e.url);
      }
    }
    return [...prefix, ...contains].slice(0, limit);
  }

  /** Emoticon packs with ≥1 emoticon (for the emoji picker, above unicode). */
  emoticonPacks(): EmotePack[] {
    return this.packs
      .map((p) => ({ ...p, emotes: p.emotes.filter(isEmoticon) }))
      .filter((p) => p.emotes.length > 0);
  }

  /** Packs with ≥1 sticker-usage emote (for the sticker picker). */
  stickerPacks(): EmotePack[] {
    return this.packs
      .map((p) => ({ ...p, emotes: p.emotes.filter(isStickerEmote) }))
      .filter((p) => p.emotes.length > 0);
  }

  /**
   * Given a plain message body, map any `:token:` that matches a locally-known
   * emote to its emote (fallback render path).
   */
  knownEmotesIn(body: string): Map<string, Emote> {
    const out = new Map<string, Emote>();
    const re = /:([a-z0-9_+\-.]+):/gi;
    let m: RegExpExecArray | null;
    while ((m = re.exec(body))) {
      const code = m[1].toLowerCase();
      const e = this.byShortcode.get(code);
      if (e) out.set(`:${m[1]}:`, e);
    }
    return out;
  }

  // --- Refresh -------------------------------------------------------------

  /**
   * Full aggregation, throttled to one pass / 5 min UNLESS the space set
   * changed (a change bypasses the throttle) or `force` is set. Concurrent
   * callers await the in-flight pass. Safe to call on every picker open.
   */
  async refreshIfStale(force = false): Promise<void> {
    const spaces = this.spacesProvider();
    const spaceKey = spaces.map((s) => s.id).sort().join(",");
    const spaceChanged = spaceKey !== this.lastSpaceKey;
    const stale = Date.now() - this.lastFullRefresh > FULL_REFRESH_MS;

    if (this.inflight) return this.inflight;
    if (!force && !spaceChanged && !stale) return;

    this.lastSpaceKey = spaceKey;
    this.inflight = this.doRefresh(spaces).finally(() => {
      this.inflight = undefined;
      this.lastFullRefresh = Date.now();
    });
    return this.inflight;
  }

  private async doRefresh(spaces: { id: string; name: string }[]): Promise<void> {
    await Promise.all([
      this.loadPersonal(),
      this.loadOptedInRoomList(),
    ]);

    const roomIds = new Set<string>([
      ...spaces.map((s) => s.id),
      ...this.optedInRoomIds,
      ...this.sessionRoomIds,
    ]);

    await Promise.all([...roomIds].map((id) => this.refreshRoom(id)));
    this.rebuild();
  }

  /** One fetch per room per session when a timeline opens. */
  async ensureRoomPack(roomId: string): Promise<void> {
    if (this.sessionRoomIds.has(roomId) && this.roomCaches.has(roomId)) return;
    this.sessionRoomIds.add(roomId);
    await this.refreshRoom(roomId);
    this.rebuild();
  }

  // --- Source loaders ------------------------------------------------------

  private async loadPersonal(): Promise<void> {
    try {
      const raw = await this.session.client.accountData(PERSONAL_EVENT);
      if (!raw) {
        this.personalPack = undefined;
        return;
      }
      const content = JSON.parse(raw);
      // Only emoticon-usage images belong to the personal "My Emoji" pack;
      // sticker entries in the same event are the StickerStore's.
      const emoticonOnly = { ...content, images: {} as Record<string, any> };
      for (const [code, img] of Object.entries<any>(content.images ?? {})) {
        const usage = normalizeUsage(img?.usage);
        if (usage.length === 0 || usage.includes("emoticon")) {
          emoticonOnly.images[code] = img;
        }
      }
      const pack = parseEmotePack("personal", emoticonOnly, 0);
      if (pack) pack.displayName = "My Emoji";
      this.personalPack = pack;
    } catch {
      this.personalPack = undefined;
    }
  }

  private async loadOptedInRoomList(): Promise<void> {
    try {
      const raw = await this.session.client.accountData(EMOTE_ROOMS_EVENT);
      this.optedInRoomIds = new Set();
      if (!raw) return;
      const content = JSON.parse(raw);
      for (const roomId of Object.keys(content.rooms ?? {})) {
        this.optedInRoomIds.add(roomId);
      }
    } catch {
      this.optedInRoomIds = new Set();
    }
  }

  /**
   * Refresh a single room's packs. Full-state discovery on first fetch or every
   * 45 min (discovers packs under new state keys); otherwise cheap per-key
   * polls for the known keys.
   */
  private async refreshRoom(roomId: string): Promise<void> {
    const cache = this.roomCaches.get(roomId);
    const needFull = !cache || Date.now() - cache.lastFullFetch > ROOM_FULL_REFETCH_MS;
    if (needFull) {
      await this.fetchRoomFullState(roomId);
    } else {
      await this.pollRoomKeys(roomId, cache);
    }
  }

  private async fetchRoomFullState(roomId: string): Promise<void> {
    let events: unknown;
    try {
      events = await this.session.restGet(
        `_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/state`,
      );
    } catch (err) {
      console.warn(`[emotes] state fetch FAILED for ${roomId}`, err);
      return;
    }
    if (!Array.isArray(events)) {
      console.warn(`[emotes] state fetch for ${roomId} returned non-array:`, events);
      return; // failed → keep any cached pack
    }
    const stateKeys = new Set<string>();
    const packs = new Map<string, EmotePack>();
    for (const ev of events) {
      if (ev?.type !== ROOM_EMOTES_TYPE) continue;
      const stateKey = ev.state_key ?? "";
      stateKeys.add(stateKey); // record even empty packs for cheap polling
      const pack = parseEmotePack(`${roomId}#${stateKey}`, ev.content, 1);
      if (pack) packs.set(stateKey, pack);
    }
    this.roomCaches.set(roomId, {
      stateKeys,
      lastFullFetch: Date.now(),
      packs,
    });
  }

  private async pollRoomKeys(roomId: string, cache: RoomCache): Promise<void> {
    await Promise.all(
      [...cache.stateKeys].map(async (stateKey) => {
        // A raw fetch (not restGet) so we can distinguish 404 (absent) from a
        // transport failure (keep the cached pack; a timeout must never be
        // treated as an empty pack).
        const result = await this.rawStateFetch(roomId, stateKey);
        if (result === "absent") {
          cache.packs.delete(stateKey);
        } else if (result === "failed") {
          // keep cached pack
        } else {
          const pack = parseEmotePack(`${roomId}#${stateKey}`, result, 1);
          if (pack) cache.packs.set(stateKey, pack);
          else cache.packs.delete(stateKey);
        }
      }),
    );
  }

  /**
   * Raw per-key state read distinguishing 404 (absent) from transport failure.
   * Returns the parsed content object, "absent" (404), or "failed".
   */
  private async rawStateFetch(
    roomId: string,
    stateKey: string,
  ): Promise<any | "absent" | "failed"> {
    const base = await this.session.apiBase();
    if (!base) return "failed";
    const token = this.session.session()?.accessToken;
    const url = `${base.replace(/\/$/, "")}/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/state/${ROOM_EMOTES_TYPE}/${encodeURIComponent(stateKey)}`;
    try {
      const res = await fetch(url, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      if (res.status === 404) return "absent";
      if (!res.ok) return "failed";
      return await res.json();
    } catch {
      return "failed";
    }
  }

  // --- Index rebuild -------------------------------------------------------

  private rebuild(): void {
    const roomPacks: EmotePack[] = [];
    for (const cache of this.roomCaches.values()) {
      for (const pack of cache.packs.values()) roomPacks.push(pack);
    }
    roomPacks.sort((a, b) => a.displayName.localeCompare(b.displayName));

    const packs: EmotePack[] = [];
    if (this.personalPack) packs.push(this.personalPack);
    packs.push(...roomPacks);
    this.packs = packs;

    const byShortcode = new Map<string, Emote>();
    const byUrl = new Map<string, Emote>();
    // Personal first (already at packs[0]) so it wins shortcode collisions.
    for (const pack of packs) {
      for (const e of pack.emotes) {
        byUrl.set(e.url, e);
        if (isEmoticon(e) && !byShortcode.has(e.shortcode)) {
          byShortcode.set(e.shortcode, e);
        }
      }
    }
    this.byShortcode = byShortcode;
    this.byUrl = byUrl;
    this.version.update((n) => n + 1);
  }

  // --- Editing (room/space default pack, state key "") ---------------------

  /**
   * Add an emote to a room's default (state key "") pack. Read-modify-write:
   * a READ FAILURE ABORTS (writing over an unread pack would wipe everyone's
   * emotes). Returns true on success. Caller must have already uploaded the
   * mxc and computed the shortcode.
   */
  async addToRoomPack(
    roomId: string,
    emote: { shortcode: string; url: string; body?: string; usage: EmoteUsage[]; info?: Emote["info"] },
  ): Promise<{ ok: boolean; forbidden?: boolean; error?: string }> {
    const current = await this.rawStateFetch(roomId, "");
    if (current === "failed") {
      return { ok: false, error: "Couldn't read the current emote pack." };
    }
    const content = current === "absent" ? { images: {} } : { ...current };
    content.images = { ...(content.images ?? {}) };
    content.images[emote.shortcode] = {
      url: emote.url,
      body: emote.body,
      usage: emote.usage,
      info: emote.info,
    };
    return this.putRoomPack(roomId, content);
  }

  /** Current emotes in a room's default pack (for the settings editor). */
  async roomPackEmotes(roomId: string): Promise<Emote[]> {
    const content = await this.rawStateFetch(roomId, "");
    if (content === "failed" || content === "absent") return [];
    return parseEmotePack(`${roomId}#`, content, 1)?.emotes ?? [];
  }

  /** Remove an emote (by shortcode) from a room's default pack. */
  async removeFromRoomPack(
    roomId: string,
    shortcode: string,
  ): Promise<{ ok: boolean; forbidden?: boolean; error?: string }> {
    const current = await this.rawStateFetch(roomId, "");
    if (current === "failed") {
      return { ok: false, error: "Couldn't read the current emote pack." };
    }
    if (current === "absent") return { ok: true };
    const content = { ...current, images: { ...(current.images ?? {}) } };
    delete content.images[shortcode];
    return this.putRoomPack(roomId, content);
  }

  private async putRoomPack(
    roomId: string,
    content: any,
  ): Promise<{ ok: boolean; forbidden?: boolean; error?: string }> {
    const base = await this.session.apiBase();
    const token = this.session.session()?.accessToken;
    if (!base || !token) return { ok: false, error: "No session." };
    const url = `${base.replace(/\/$/, "")}/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/state/${ROOM_EMOTES_TYPE}/`;
    try {
      const res = await fetch(url, {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(content),
      });
      if (res.status === 403) {
        return { ok: false, forbidden: true, error: "You don't have permission to edit emotes here." };
      }
      if (!res.ok) return { ok: false, error: `Write failed (${res.status}).` };
      // Local refetch so pickers update immediately.
      await this.fetchRoomFullState(roomId);
      this.rebuild();
      return { ok: true };
    } catch {
      return { ok: false, error: "Write failed." };
    }
  }
}
