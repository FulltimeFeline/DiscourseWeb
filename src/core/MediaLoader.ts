// Resolves Matrix media (mxc:// URLs / MediaSource objects) into object URLs the
// browser can render.
//
// The SDK already persists media bytes in its IndexedDB store (the disk tier);
// on top of that we add a memory cache of object URLs plus in-flight
// de-duplication so a burst of rows requesting the same avatar hits the
// network/store once. Encrypted media must go through the boxed MediaSource
// (not the bare URL), so callers pass the MediaRef carrying both.

import { MediaSource, type ClientInterface } from "@/matrix";

type Bytes = Uint8Array | ArrayBuffer | number[];

function toBlob(bytes: Bytes, mimetype?: string): Blob {
  const view: ArrayBufferView =
    bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes as ArrayBuffer | number[]);
  return new Blob([view as BlobPart], mimetype ? { type: mimetype } : undefined);
}

interface Request {
  /** Boxed FFI MediaSource, or an mxc string we wrap with MediaSource.fromUrl. */
  source: unknown;
  mxc: string;
  mimetype?: string;
  /** Thumbnail pixel size; omit for full content. */
  thumbnail?: { width: number; height: number };
}

/** Full-content object URLs to keep resident before evicting the oldest. */
const FULL_CACHE_BUDGET = 192 * 1024 * 1024;
/** Never evict this many most-recently-used entries (open lightbox, playing video). */
const FULL_CACHE_KEEP = 3;
/** Grace period before an evicted URL is revoked, for elements still holding it. */
const REVOKE_DELAY_MS = 60_000;
/**
 * A thumbnail-keyed entry this big is really a full file: `fetchBytes` falls
 * back to the full content when the server can't thumbnail (the common avatar
 * path on some homeservers). Classifying by request shape alone would leave
 * those permanently resident — exactly the unbounded growth this cache bounds.
 */
const LARGE_ENTRY_BYTES = 1024 * 1024;

interface CacheEntry {
  url: string;
  bytes: number;
  /** Belongs to the evictable tier: full content, or an oversized thumbnail. */
  full: boolean;
  used: number;
}

export class MediaLoader {
  private cache = new Map<string, CacheEntry>();
  private inflight = new Map<string, Promise<string | undefined>>();
  /** Evicted URLs awaiting their delayed revoke: timer → url. */
  private pendingRevokes = new Map<ReturnType<typeof setTimeout>, string>();

  constructor(private client: ClientInterface) {}

  private key(mxc: string, thumb?: { width: number; height: number }): string {
    return thumb ? `${mxc}@${thumb.width}x${thumb.height}` : mxc;
  }

  /** True if `s` is a live FFI MediaSource (not a plain object / freed handle). */
  private isFfiSource(s: unknown): boolean {
    try {
      return !!s && MediaSource.instanceOf(s as never);
    } catch {
      return false;
    }
  }

  /**
   * Fetch bytes for a request, with two layers of resilience:
   *  - if the stored FFI source is stale/invalid, retry via MediaSource.fromUrl
   *  - if a thumbnail request fails (server/media without thumbnails), fall
   *    back to the full content so avatars/images still render.
   */
  private async fetchBytes(req: Request): Promise<Bytes> {
    // Prefer a live FFI MediaSource (encrypted media carries file keys). If the
    // stored source is a plain object or a handle the SDK has since freed, it is
    // useless, so fall straight through to wrapping the mxc URL. Track whether
    // the primary source is already the mxc-derived one so we don't retry it
    // twice.
    const useStored = this.isFfiSource(req.source);
    const primary = useStored ? req.source : req.mxc ? MediaSource.fromUrl(req.mxc) : req.source;
    // A fresh, independent MediaSource for the retry path (unencrypted media).
    const fresh = !useStored || !req.mxc ? undefined : () => MediaSource.fromUrl(req.mxc);

    const getContent = async (source: unknown): Promise<Bytes> =>
      (await this.client.getMediaContent(source as never)) as Bytes;
    const getThumb = async (source: unknown): Promise<Bytes> =>
      (await this.client.getMediaThumbnail(
        source as never,
        BigInt(req.thumbnail!.width),
        BigInt(req.thumbnail!.height),
      )) as Bytes;

    // Try the variant with the primary source; if that throws and we have a
    // stored FFI source (which may be stale), retry with a fresh mxc-wrapped one.
    const tryVariant = async (fn: (s: unknown) => Promise<Bytes>): Promise<Bytes> => {
      try {
        return await fn(primary);
      } catch (err) {
        if (fresh) {
          console.warn("media source retry via mxc", req.mxc, err);
          return await fn(fresh());
        }
        throw err;
      }
    };

    if (req.thumbnail) {
      try {
        return await tryVariant(getThumb);
      } catch (err) {
        // Thumbnails aren't supported for this server/media, so fall back to the
        // full content. This is the common avatar failure path.
        console.warn("media thumbnail failed, falling back to content", req.mxc, err);
        return await tryVariant(getContent);
      }
    }
    return await tryVariant(getContent);
  }

  /** Returns a cached object URL synchronously if present. */
  cached(mxc: string, thumb?: { width: number; height: number }): string | undefined {
    const hit = this.cache.get(this.key(mxc, thumb));
    if (!hit) return undefined;
    hit.used = performance.now();
    return hit.url;
  }

  /**
   * Keep the full-content tier under budget. Full files are the expensive ones
   * (a 40MB video each); thumbnails are small and stay resident. The most
   * recently used few are never evicted — one of them is on screen.
   */
  private evictFullContent(): void {
    const full = [...this.cache.entries()].filter(([, e]) => e.full);
    let total = full.reduce((sum, [, e]) => sum + e.bytes, 0);
    if (total <= FULL_CACHE_BUDGET) return;
    full.sort((a, b) => a[1].used - b[1].used);
    for (const [key, entry] of full.slice(0, Math.max(0, full.length - FULL_CACHE_KEEP))) {
      if (total <= FULL_CACHE_BUDGET) break;
      this.cache.delete(key);
      total -= entry.bytes;
      // Delay the revoke: an <img>/<video> may still be reading this URL.
      const timer: ReturnType<typeof setTimeout> = setTimeout(() => {
        this.pendingRevokes.delete(timer);
        URL.revokeObjectURL(entry.url);
      }, REVOKE_DELAY_MS);
      this.pendingRevokes.set(timer, entry.url);
    }
  }

  async load(req: Request): Promise<string | undefined> {
    if (!req.mxc && !req.source) return undefined;
    const key = this.key(req.mxc, req.thumbnail);
    const hit = this.cache.get(key);
    if (hit) {
      hit.used = performance.now();
      return hit.url;
    }
    const pending = this.inflight.get(key);
    if (pending) return pending;

    const task = (async () => {
      try {
        const bytes = await this.fetchBytes(req);
        const blob = toBlob(bytes, req.mimetype);
        const url = URL.createObjectURL(blob);
        // Measure the blob rather than trusting the request: a failed thumbnail
        // falls back to the full file under a thumbnail key, so size — not the
        // request shape — decides whether it joins the evictable tier.
        const full = !req.thumbnail || blob.size >= LARGE_ENTRY_BYTES;
        this.cache.set(key, { url, bytes: blob.size, full, used: performance.now() });
        if (full) this.evictFullContent();
        return url;
      } catch (err) {
        console.warn("media load failed", req.mxc, err);
        return undefined;
      } finally {
        this.inflight.delete(key);
      }
    })();
    this.inflight.set(key, task);
    return task;
  }

  /** Convenience for avatars: thumbnail at a square pixel size. */
  avatar(
    mxc: string | undefined,
    source: unknown,
    size = 56,
  ): Promise<string | undefined> {
    if (!mxc) return Promise.resolve(undefined);
    return this.load({ source, mxc, thumbnail: { width: size, height: size } });
  }

  /** Warm a set of avatar thumbnails (sidebar prewarming). */
  async prewarmAvatars(refs: { mxc: string; source?: unknown }[], size = 56): Promise<void> {
    await Promise.all(
      refs.map((r) =>
        this.load({ source: r.source, mxc: r.mxc, thumbnail: { width: size, height: size } }),
      ),
    );
  }

  dispose(): void {
    for (const [timer, url] of this.pendingRevokes) {
      clearTimeout(timer);
      URL.revokeObjectURL(url);
    }
    this.pendingRevokes.clear();
    for (const entry of this.cache.values()) URL.revokeObjectURL(entry.url);
    this.cache.clear();
    this.inflight.clear();
  }
}
