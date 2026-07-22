// Outgoing image/video processing via canvas, createImageBitmap, and an off-DOM
// <video>. Everything runs on the main thread for simplicity and portability
// (createImageBitmap already decodes off the UI thread internally). A Web Worker
// would be faster for the heaviest work, but keeping it inline avoids a
// build/bundler dependency and the images this composer handles are user-picked
// (occasional, not a hot path). The one discipline: never hold a full-res
// bitmap longer than needed (bitmaps are `.close()`d).
//
// GPS/EXIF: a canvas re-encode drops all metadata, so stripping GPS is free, but
// it also flattens animation, so animated GIF/APNG pass through untouched.

import { encodeBlurhash } from "./blurhash";

export interface ProcessedImage {
  /** Re-encoded (or original, for animated) bytes to upload. */
  bytes: ArrayBuffer;
  mimetype: string;
  width: number;
  height: number;
  isAnimated: boolean;
}

export interface Thumbnail {
  bytes: ArrayBuffer;
  mimetype: string;
  width: number;
  height: number;
}

export interface VideoAttributes {
  durationSecs: number;
  width: number;
  height: number;
  poster?: Thumbnail;
}

const THUMB_MAX = 800; // longest thumbnail edge in px
const THUMB_JPEG_QUALITY = 0.75;

/** True for formats a canvas re-encode would flatten (animation loss). */
function isAnimatedType(mime: string): boolean {
  return mime === "image/gif" || mime === "image/apng" || mime === "image/webp";
}

async function blobFromCanvas(
  canvas: HTMLCanvasElement | OffscreenCanvas,
  type: string,
  quality?: number,
): Promise<Blob> {
  if ("convertToBlob" in canvas) {
    return canvas.convertToBlob({ type, quality });
  }
  return new Promise<Blob>((resolve, reject) => {
    (canvas as HTMLCanvasElement).toBlob(
      (b) => (b ? resolve(b) : reject(new Error("toBlob failed"))),
      type,
      quality,
    );
  });
}

function makeCanvas(w: number, h: number): HTMLCanvasElement | OffscreenCanvas {
  if (typeof OffscreenCanvas !== "undefined") return new OffscreenCanvas(w, h);
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  return c;
}

function fitWithin(w: number, h: number, max: number): { width: number; height: number } {
  if (w <= 0 || h <= 0) return { width: max, height: max };
  const ratio = Math.min(max / w, max / h, 1);
  return { width: Math.max(1, Math.round(w * ratio)), height: Math.max(1, Math.round(h * ratio)) };
}

/** True if a canvas image data has any non-opaque pixel (→ send as PNG). */
function hasAlpha(data: ImageData): boolean {
  const a = data.data;
  for (let i = 3; i < a.length; i += 4) if (a[i] < 255) return true;
  return false;
}

/**
 * Read intrinsic pixel dimensions of an image blob. Cheap: decodes to a bitmap.
 */
export async function imageDimensions(
  blob: Blob,
): Promise<{ width: number; height: number } | undefined> {
  try {
    const bmp = await createImageBitmap(blob);
    const dims = { width: bmp.width, height: bmp.height };
    bmp.close?.();
    return dims;
  } catch {
    return undefined;
  }
}

/**
 * Process an outgoing image: strip metadata via canvas re-encode (unless
 * animated, which passes through), returning bytes, dimensions, and mimetype.
 * `stripLocation` toggles the re-encode. Browsers can't preserve EXIF through a
 * canvas, so when strip is off we pass the original bytes through unchanged and
 * just read dimensions.
 */
export async function processImage(
  blob: Blob,
  stripLocation: boolean,
): Promise<ProcessedImage | undefined> {
  const mime = blob.type || "image/png";
  const animated = isAnimatedType(mime);

  // Animated, or strip disabled: pass original bytes through (no flattening,
  // and for strip-off, preserve metadata by not re-encoding).
  if (animated || !stripLocation) {
    const dims = await imageDimensions(blob);
    if (!dims) return undefined;
    return {
      bytes: await blob.arrayBuffer(),
      mimetype: mime,
      width: dims.width,
      height: dims.height,
      isAnimated: animated,
    };
  }

  // Strip on, static image: re-encode through a canvas (drops all metadata).
  try {
    const bmp = await createImageBitmap(blob);
    const canvas = makeCanvas(bmp.width, bmp.height);
    const ctx = canvas.getContext("2d") as CanvasRenderingContext2D | null;
    if (!ctx) {
      bmp.close?.();
      return undefined;
    }
    ctx.drawImage(bmp, 0, 0);
    const imgData = ctx.getImageData(0, 0, bmp.width, bmp.height);
    const alpha = hasAlpha(imgData);
    const outType = alpha ? "image/png" : "image/jpeg";
    const out = await blobFromCanvas(canvas, outType, alpha ? undefined : 0.92);
    const dims = { width: bmp.width, height: bmp.height };
    bmp.close?.();
    return {
      bytes: await out.arrayBuffer(),
      mimetype: outType,
      width: dims.width,
      height: dims.height,
      isAnimated: false,
    };
  } catch {
    return undefined;
  }
}

/**
 * Build an 800px thumbnail (JPEG@0.75, PNG if alpha) with orientation baked in.
 */
export async function makeThumbnail(
  blob: Blob,
  maxPixelSize = THUMB_MAX,
): Promise<Thumbnail | undefined> {
  try {
    const bmp = await createImageBitmap(blob);
    const { width, height } = fitWithin(bmp.width, bmp.height, maxPixelSize);
    const canvas = makeCanvas(width, height);
    const ctx = canvas.getContext("2d") as CanvasRenderingContext2D | null;
    if (!ctx) {
      bmp.close?.();
      return undefined;
    }
    ctx.drawImage(bmp, 0, 0, width, height);
    const imgData = ctx.getImageData(0, 0, width, height);
    const alpha = hasAlpha(imgData);
    const outType = alpha ? "image/png" : "image/jpeg";
    const out = await blobFromCanvas(canvas, outType, alpha ? undefined : THUMB_JPEG_QUALITY);
    bmp.close?.();
    return { bytes: await out.arrayBuffer(), mimetype: outType, width, height };
  } catch {
    return undefined;
  }
}

/** Encode a blurhash for an outgoing image (undefined means fall back to file send). */
export async function imageBlurhash(blob: Blob): Promise<string | undefined> {
  return encodeBlurhash(blob);
}

/**
 * Extract video attributes off-DOM: duration, natural (orientation-corrected)
 * dimensions, and a poster frame seeked ~1s in (avoids a black frame 0).
 */
export async function videoAttributes(blob: Blob): Promise<VideoAttributes | undefined> {
  const url = URL.createObjectURL(blob);
  const video = document.createElement("video");
  video.muted = true;
  video.preload = "metadata";
  video.src = url;
  try {
    await new Promise<void>((resolve, reject) => {
      video.onloadedmetadata = () => resolve();
      video.onerror = () => reject(new Error("video metadata load failed"));
    });
    const duration = Number.isFinite(video.duration) ? video.duration : 0;
    const width = video.videoWidth;
    const height = video.videoHeight;

    let poster: Thumbnail | undefined;
    try {
      poster = await capturePoster(video, Math.min(1, Math.max(0, duration - 0.1)));
    } catch {
      poster = undefined;
    }
    return { durationSecs: duration, width, height, poster };
  } catch {
    return undefined;
  } finally {
    video.src = "";
    URL.revokeObjectURL(url);
  }
}

async function capturePoster(video: HTMLVideoElement, atSecs: number): Promise<Thumbnail | undefined> {
  await new Promise<void>((resolve, reject) => {
    video.onseeked = () => resolve();
    video.onerror = () => reject(new Error("seek failed"));
    try {
      video.currentTime = atSecs;
    } catch {
      reject(new Error("seek unsupported"));
    }
  });
  const { width, height } = fitWithin(video.videoWidth, video.videoHeight, THUMB_MAX);
  const canvas = makeCanvas(width, height);
  const ctx = canvas.getContext("2d") as CanvasRenderingContext2D | null;
  if (!ctx) return undefined;
  ctx.drawImage(video, 0, 0, width, height);
  const out = await blobFromCanvas(canvas, "image/jpeg", THUMB_JPEG_QUALITY);
  return { bytes: await out.arrayBuffer(), mimetype: "image/jpeg", width, height };
}
