// Inline received image.
//
// Fixed footprint from the event's dimensions; a blurhash placeholder shows
// behind a spinner so the image fades in from its colors; the SDK thumbnail
// lands and replaces it. Data-saver gates non-sticker images behind a "Tap to
// load" placeholder; stickers always load and never crop. A failed fetch shows
// "Tap to retry". Tap on a loaded image opens full-res in a lightbox.

import { useState } from "react";
import type { MediaLoader } from "@/core/MediaLoader";
import type { ImageContent, StickerContent } from "@/models/types";
import { blurhashToDataURL, clampMediaSize } from "./blurhash";
import { useMediaUrl } from "./useMedia";
import { Lightbox } from "./Lightbox";
import "./media.css";

interface Props {
  content: ImageContent | StickerContent;
  loader: MediaLoader;
  /** dataSaver preference; gate non-sticker images when true. */
  dataSaver?: boolean;
}

export function InlineImage({ content, loader, dataSaver = false }: Props) {
  const isSticker = content.type === "sticker";
  const blurhash = "blurhash" in content ? content.blurhash : undefined;
  const box = clampMediaSize(
    content.width,
    content.height,
    isSticker
      ? { maxWidth: 160, maxHeight: 160 }
      : { maxWidth: 360, maxHeight: 280 },
  );

  // Stickers always load; other images gate behind data-saver until tapped.
  const cachedNow = loader.cached(content.source.mxc, thumbPx(box));
  const [gateLifted, setGateLifted] = useState(isSticker || !dataSaver || !!cachedNow);
  const [lightbox, setLightbox] = useState(false);

  const thumb = useMediaUrl(loader, content.source, {
    thumbnail: thumbPx(box),
    mimetype: content.mimetype,
    enabled: gateLifted,
  });

  const placeholder = blurhashToDataURL(blurhash);
  const caption = !isSticker && content.body && content.body !== "Image" ? content.body : undefined;

  const style: React.CSSProperties = {
    width: box.width,
    height: box.height,
    backgroundImage: placeholder && !thumb.url ? `url(${placeholder})` : undefined,
  };

  return (
    <div className="dc-media-col">
      <div
        className={`dc-inline-image${isSticker ? " sticker" : ""}`}
        style={style}
        onClick={() => {
          if (!gateLifted) setGateLifted(true);
          else if (thumb.failed) thumb.retry();
          else if (thumb.url) setLightbox(true);
        }}
        role="button"
        tabIndex={0}
        aria-label={content.body || (isSticker ? "Sticker" : "Image")}
      >
        {thumb.url && (
          <img
            src={thumb.url}
            alt={content.body || ""}
            style={{ objectFit: isSticker || !content.width ? "contain" : "cover" }}
            onDragStart={(e) => {
              // Let the image be dragged out to Finder / another app as a file.
              if (!thumb.url) return;
              const mime = content.mimetype || "image/png";
              const ext = mime.split("/")[1]?.split("+")[0] || "png";
              const base =
                content.body && content.body !== "Image"
                  ? content.body.replace(/\.[a-z0-9]+$/i, "")
                  : isSticker
                    ? "sticker"
                    : "image";
              e.dataTransfer.setData("DownloadURL", `${mime}:${base}.${ext}:${thumb.url}`);
            }}
          />
        )}
        {!thumb.url && !gateLifted && <div className="dc-media-badge">Tap to load image</div>}
        {!thumb.url && gateLifted && thumb.loading && <div className="dc-spinner" />}
        {!thumb.url && gateLifted && thumb.failed && (
          <div className="dc-media-badge">Tap to retry</div>
        )}
      </div>
      {caption && <div className="dc-media-caption">{caption}</div>}
      {lightbox && thumb.url && (
        <Lightbox
          loader={loader}
          source={content.source}
          mimetype={content.mimetype}
          fallbackUrl={thumb.url}
          onClose={() => setLightbox(false)}
        />
      )}
    </div>
  );
}

function thumbPx(box: { width: number; height: number }): { width: number; height: number } {
  const scale = Math.min(Math.max(window.devicePixelRatio || 1, 1), 3);
  const side = Math.round(Math.max(box.width, box.height) * scale);
  return { width: side, height: side };
}
