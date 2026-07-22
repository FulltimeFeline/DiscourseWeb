// Image-picking and light EXIF-stripping helpers shared by the profile, banner,
// and room-avatar editors. Uploads go through the SDK (uploadAvatar,
// uploadMedia, room.uploadAvatar), which want (mimeType, ArrayBuffer).

export interface PickedImage {
  data: ArrayBuffer;
  mimeType: string;
  /** An object URL for immediate preview; caller revokes when done. */
  previewUrl: string;
}

/** Open a native file picker for a single image and return its bytes. */
export function pickImage(): Promise<PickedImage | undefined> {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "image/*";
    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file) return resolve(undefined);
      try {
        const cleaned = await stripLocationMetadata(file);
        const data = await cleaned.arrayBuffer();
        resolve({
          data,
          mimeType: cleaned.type || file.type || "application/octet-stream",
          previewUrl: URL.createObjectURL(cleaned),
        });
      } catch {
        resolve(undefined);
      }
    };
    input.click();
  });
}

/**
 * Strip location (and all) metadata by re-encoding through a canvas, which
 * drops every EXIF/GPS block. Gated by the `stripLocationMetadata` pref at the
 * call site; when off we return the original File. Non-raster or decode-failing
 * inputs fall through to the original bytes.
 */
export async function stripLocationMetadata(file: Blob, enabled = true): Promise<Blob> {
  if (!enabled) return file;
  const type = file.type;
  // Only re-encode formats a canvas can round-trip losslessly-ish.
  if (type !== "image/jpeg" && type !== "image/png" && type !== "image/webp") return file;
  try {
    const bitmap = await createImageBitmap(file);
    const canvas = document.createElement("canvas");
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const ctx = canvas.getContext("2d");
    if (!ctx) return file;
    ctx.drawImage(bitmap, 0, 0);
    bitmap.close?.();
    const outType = type === "image/png" ? "image/png" : "image/jpeg";
    const quality = outType === "image/jpeg" ? 0.92 : undefined;
    const blob: Blob | null = await new Promise((res) => canvas.toBlob(res, outType, quality));
    return blob ?? file;
  } catch {
    return file;
  }
}
