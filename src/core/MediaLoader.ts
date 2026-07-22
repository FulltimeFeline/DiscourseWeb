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

export class MediaLoader {
  private cache = new Map<string, string>(); // key → object URL
  private inflight = new Map<string, Promise<string | undefined>>();

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
    return this.cache.get(this.key(mxc, thumb));
  }

  async load(req: Request): Promise<string | undefined> {
    if (!req.mxc && !req.source) return undefined;
    const key = this.key(req.mxc, req.thumbnail);
    const hit = this.cache.get(key);
    if (hit) return hit;
    const pending = this.inflight.get(key);
    if (pending) return pending;

    const task = (async () => {
      try {
        const bytes = await this.fetchBytes(req);
        const url = URL.createObjectURL(toBlob(bytes, req.mimetype));
        this.cache.set(key, url);
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
    for (const url of this.cache.values()) URL.revokeObjectURL(url);
    this.cache.clear();
    this.inflight.clear();
  }
}
