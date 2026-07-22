// Renders an mxc:// emote/sticker/avatar image via the session MediaLoader
// (object URLs, encrypted-media safe). Shared by the pickers, EmoteText,
// reaction chips, and power-level badges.

import { useEffect, useState } from "react";
import { useSession } from "@/app/context";

export interface EmoteImageProps {
  mxc: string;
  alt?: string;
  /** CSS pixel size (a square thumbnail is requested at 2× for crispness). */
  size?: number;
  className?: string;
  title?: string;
  style?: React.CSSProperties;
  draggable?: boolean;
}

export function EmoteImage({
  mxc,
  alt,
  size = 24,
  className,
  title,
  style,
  draggable,
}: EmoteImageProps) {
  const session = useSession();
  const px = Math.max(32, Math.round(size * 2));
  const [url, setUrl] = useState<string | undefined>(() =>
    session.mediaLoader.cached(mxc, { width: px, height: px }),
  );

  useEffect(() => {
    let cancelled = false;
    const cached = session.mediaLoader.cached(mxc, { width: px, height: px });
    if (cached) {
      setUrl(cached);
      return;
    }
    session.mediaLoader
      .load({ source: undefined, mxc, thumbnail: { width: px, height: px } })
      .then((u) => {
        if (!cancelled) setUrl(u);
      });
    return () => {
      cancelled = true;
    };
  }, [mxc, px, session]);

  return (
    <img
      className={className}
      src={url}
      alt={alt ?? ""}
      title={title}
      draggable={draggable}
      style={{ width: size, height: size, objectFit: "contain", ...style }}
    />
  );
}
