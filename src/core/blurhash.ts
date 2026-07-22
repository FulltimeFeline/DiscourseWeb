// Blurhash placeholder helper. Decodes an attachment's blurhash into a tiny
// image shown while the real thumbnail downloads, via the `blurhash` package:
// decode to a small canvas and cache the resulting data URL per hash (keyed by
// hash + target size).
//
// Decoding is cheap but not free, so we memoise: a given blurhash string always
// yields the same placeholder. Data URLs are used (not object URLs) so there is
// nothing to revoke.

import { decode } from "blurhash";

const cache = new Map<string, string>();

/**
 * Decode a blurhash to a small data-URL image usable as a CSS background or
 * <img> src. `punch` controls contrast. Returns undefined if decoding fails or
 * the environment has no canvas (SSR).
 */
export function blurhashToDataURL(
  hash: string | undefined,
  width = 32,
  height = 32,
  punch = 1,
): string | undefined {
  if (!hash) return undefined;
  const key = `${hash}@${width}x${height}`;
  const hit = cache.get(key);
  if (hit) return hit;
  try {
    const pixels = decode(hash, width, height, punch);
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    if (!ctx) return undefined;
    const imageData = ctx.createImageData(width, height);
    imageData.data.set(pixels);
    ctx.putImageData(imageData, 0, 0);
    const url = canvas.toDataURL();
    cache.set(key, url);
    return url;
  } catch {
    return undefined;
  }
}

/**
 * Clamp intrinsic media dimensions to a display box, preserving aspect ratio.
 * Images max 360x280, stickers 160x160; unknown dimensions fall back to a
 * sensible default box.
 */
export function clampMediaSize(
  width: number | undefined,
  height: number | undefined,
  opts: { maxWidth: number; maxHeight: number; fallbackWidth?: number; fallbackHeight?: number } = {
    maxWidth: 360,
    maxHeight: 280,
  },
): { width: number; height: number } {
  const fw = opts.fallbackWidth ?? opts.maxWidth;
  const fh = opts.fallbackHeight ?? Math.round(opts.maxHeight * 0.66);
  if (!width || !height || width <= 0 || height <= 0) {
    return { width: fw, height: fh };
  }
  const ratio = Math.min(opts.maxWidth / width, opts.maxHeight / height, 1);
  return { width: Math.round(width * ratio), height: Math.round(height * ratio) };
}
