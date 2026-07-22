// Full-res media viewer. Downloads full content via the MediaLoader (decrypted
// server-side for E2EE) and shows it in a scrim overlay; falls back to the
// already-loaded thumbnail while the full-res downloads.

import { useEffect, useRef, useState } from "react";
import type { MediaLoader } from "@/core/MediaLoader";
import type { MediaRef } from "@/models/types";
import { Icon } from "@/ui/Icon";
import "./media.css";

interface Props {
  loader: MediaLoader;
  source: MediaRef;
  mimetype?: string;
  fallbackUrl?: string;
  filename?: string;
  /** "image" or "video"; video renders <video controls>. */
  kind?: "image" | "video";
  onClose: () => void;
}

export function Lightbox({ loader, source, mimetype, fallbackUrl, filename, kind = "image", onClose }: Props) {
  const [url, setUrl] = useState<string | undefined>(fallbackUrl);
  const [loading, setLoading] = useState(true);
  const [copied, setCopied] = useState(false);

  // Zoom / pan (images only). scale 1 = fit; wheel zooms toward the cursor,
  // drag pans when zoomed, double-click toggles fit/2.5x.
  const [zoom, setZoom] = useState({ s: 1, x: 0, y: 0 });
  const drag = useRef<{ px: number; py: number; ox: number; oy: number } | null>(null);
  useEffect(() => setZoom({ s: 1, x: 0, y: 0 }), [url]);

  const onWheel = (e: React.WheelEvent<HTMLImageElement>) => {
    e.preventDefault();
    const r = e.currentTarget.getBoundingClientRect();
    const cx = e.clientX - (r.left + r.width / 2);
    const cy = e.clientY - (r.top + r.height / 2);
    setZoom((p) => {
      const s = Math.min(8, Math.max(1, p.s * (e.deltaY < 0 ? 1.15 : 1 / 1.15)));
      if (s === 1) return { s: 1, x: 0, y: 0 };
      return { s, x: cx - ((cx - p.x) / p.s) * s, y: cy - ((cy - p.y) / p.s) * s };
    });
  };
  const onPointerDown = (e: React.PointerEvent<HTMLImageElement>) => {
    if (zoom.s === 1) return;
    drag.current = { px: e.clientX, py: e.clientY, ox: zoom.x, oy: zoom.y };
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const onPointerMove = (e: React.PointerEvent<HTMLImageElement>) => {
    const d = drag.current;
    if (!d) return;
    setZoom((p) => ({ ...p, x: d.ox + (e.clientX - d.px), y: d.oy + (e.clientY - d.py) }));
  };
  const endDrag = () => {
    drag.current = null;
  };
  const toggleZoom = () => setZoom((p) => (p.s === 1 ? { s: 2.5, x: 0, y: 0 } : { s: 1, x: 0, y: 0 }));

  const save = () => {
    if (!url) return;
    const a = document.createElement("a");
    a.href = url;
    a.download = filename || "image";
    a.click();
  };
  const copy = async () => {
    if (!url || kind !== "image") return;
    try {
      const blob = await (await fetch(url)).blob();
      await navigator.clipboard.write([new ClipboardItem({ [blob.type]: blob })]);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard image write unsupported */
    }
  };

  useEffect(() => {
    let alive = true;
    loader
      .load({ source: source.source, mxc: source.mxc, mimetype })
      .then((u) => {
        if (alive && u) setUrl(u);
      })
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, [loader, source.mxc, source.source, mimetype]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="dc-lightbox" onClick={onClose}>
      <div className="dc-lightbox-bar" onClick={(e) => e.stopPropagation()}>
        {kind === "image" && (
          <button className="dc-lightbox-btn" onClick={() => void copy()} title="Copy image">
            <Icon name={copied ? "check" : "copy"} size={18} />
          </button>
        )}
        <button className="dc-lightbox-btn" onClick={save} title="Save">
          <Icon name="file" size={18} />
        </button>
        <button className="dc-lightbox-btn" onClick={onClose} title="Close">
          <Icon name="x" size={18} />
        </button>
      </div>
      {loading && !url && <div className="dc-spinner light" />}
      {url &&
        (kind === "video" ? (
          <video
            src={url}
            controls
            autoPlay
            className="dc-lightbox-media"
            onClick={(e) => e.stopPropagation()}
          />
        ) : (
          <img
            src={url}
            className="dc-lightbox-media"
            style={{
              transform: `translate(${zoom.x}px, ${zoom.y}px) scale(${zoom.s})`,
              cursor: zoom.s > 1 ? "grab" : "zoom-in",
              touchAction: "none",
            }}
            onClick={(e) => e.stopPropagation()}
            onWheel={onWheel}
            onDoubleClick={toggleZoom}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={endDrag}
            onPointerCancel={endDrag}
            alt=""
          />
        ))}
    </div>
  );
}
