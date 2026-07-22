// Outgoing-blurhash helper. The core `@/core/blurhash` module owns the decode
// side (placeholder rendering for received media); this module owns encode for
// outgoing images: downsample to a ~32px thumbnail, then DCT-encode with
// componentsX=4, componentsY=3. The SDK requires a blurhash on `sendImage`, so
// the send path falls back to a plain file send when encoding fails.
//
// Re-exports the decode/data-URL helper from core so media components have a
// single import surface without duplicating the decode logic.

import { encode } from "blurhash";

export { blurhashToDataURL, clampMediaSize } from "@/core/blurhash";

const ENCODE_MAX = 32; // downsample longest edge to this before encoding
const COMPONENTS_X = 4;
const COMPONENTS_Y = 3;

/**
 * Encode an image (bitmap or blob) to a blurhash string. Downsamples to a
 * ~32px thumbnail first so encoding stays cheap. Returns undefined on any
 * failure (callers fall back to a file send).
 */
export async function encodeBlurhash(
  source: ImageBitmap | Blob,
): Promise<string | undefined> {
  try {
    const bitmap =
      source instanceof ImageBitmap ? source : await createImageBitmap(source);
    const { width, height } = fitWithin(bitmap.width, bitmap.height, ENCODE_MAX);
    const canvas = makeCanvas(width, height);
    const ctx = canvas.getContext("2d") as
      | CanvasRenderingContext2D
      | OffscreenCanvasRenderingContext2D
      | null;
    if (!ctx) return undefined;
    ctx.drawImage(bitmap, 0, 0, width, height);
    const data = ctx.getImageData(0, 0, width, height);
    if (!(source instanceof ImageBitmap)) bitmap.close?.();
    return encode(data.data, data.width, data.height, COMPONENTS_X, COMPONENTS_Y);
  } catch {
    return undefined;
  }
}

function fitWithin(w: number, h: number, max: number): { width: number; height: number } {
  if (w <= 0 || h <= 0) return { width: max, height: max };
  const ratio = Math.min(max / w, max / h, 1);
  return { width: Math.max(1, Math.round(w * ratio)), height: Math.max(1, Math.round(h * ratio)) };
}

function makeCanvas(w: number, h: number): HTMLCanvasElement | OffscreenCanvas {
  if (typeof OffscreenCanvas !== "undefined") return new OffscreenCanvas(w, h);
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  return c;
}
