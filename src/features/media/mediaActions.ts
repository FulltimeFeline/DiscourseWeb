// Save / copy a media attachment straight from a message (context menu) or the
// lightbox. Resolves the full-res (decrypted) blob URL via the MediaLoader,
// then triggers a download or writes an image to the clipboard.

import type { MediaLoader } from "@/core/MediaLoader";
import type { MediaRef } from "@/models/types";

async function resolve(loader: MediaLoader, ref: MediaRef, mimetype?: string): Promise<string | undefined> {
  return loader.load({ source: ref.source, mxc: ref.mxc, mimetype });
}

/** Download a media attachment to disk. */
export async function saveMedia(
  loader: MediaLoader,
  ref: MediaRef,
  opts: { mimetype?: string; filename?: string } = {},
): Promise<boolean> {
  const url = await resolve(loader, ref, opts.mimetype);
  if (!url) return false;
  const a = document.createElement("a");
  a.href = url;
  a.download = opts.filename || "download";
  a.click();
  return true;
}

/** Copy an image attachment to the clipboard. Returns false if unsupported. */
export async function copyImage(
  loader: MediaLoader,
  ref: MediaRef,
  mimetype?: string,
): Promise<boolean> {
  const url = await resolve(loader, ref, mimetype);
  if (!url) return false;
  try {
    const blob = await (await fetch(url)).blob();
    await navigator.clipboard.write([new ClipboardItem({ [blob.type]: blob })]);
    return true;
  } catch {
    return false;
  }
}
