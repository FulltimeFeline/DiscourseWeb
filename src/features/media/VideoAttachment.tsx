// Inline received video.
//
// Poster from the event's thumbnail source (blurhash placeholder behind it, a
// neutral film placeholder if none); play overlay and duration badge. Tap
// downloads and decrypts the full file and plays it (scrubbing/fullscreen via
// the <video> controls in the lightbox).

import { useState } from "react";
import type { MediaLoader } from "@/core/MediaLoader";
import type { VideoContent } from "@/models/types";
import { blurhashToDataURL, clampMediaSize } from "./blurhash";
import { useMediaUrl } from "./useMedia";
import { Lightbox } from "./Lightbox";
import { Icon } from "@/ui/Icon";
import "./media.css";

interface Props {
  content: VideoContent;
  loader: MediaLoader;
}

export function VideoAttachment({ content, loader }: Props) {
  const box = clampMediaSize(content.width, content.height, { maxWidth: 360, maxHeight: 280 });
  const [playing, setPlaying] = useState(false);

  const poster = useMediaUrl(loader, content.thumbnail ?? content.source, {
    thumbnail: { width: box.width, height: box.height },
  });
  const placeholder = blurhashToDataURL(content.blurhash);
  const caption = content.body && content.body !== "Video" ? content.body : undefined;

  return (
    <div className="dc-media-col">
      <div
        className="dc-video-attachment"
        style={{
          width: box.width,
          height: box.height,
          backgroundImage: placeholder && !poster.url ? `url(${placeholder})` : undefined,
        }}
        onClick={() => setPlaying(true)}
        role="button"
        tabIndex={0}
        aria-label={content.body || "Video"}
      >
        {poster.url ? (
          <img src={poster.url} alt="" style={{ objectFit: "cover" }} />
        ) : (
          !placeholder && <div className="dc-video-film" aria-hidden />
        )}
        <div className="dc-video-play" aria-hidden>
          <Icon name="play" size={24} />
        </div>
        {content.duration != null && (
          <div className="dc-video-duration">{formatDuration(content.duration)}</div>
        )}
      </div>
      {caption && <div className="dc-media-caption">{caption}</div>}
      {playing && (
        <Lightbox
          loader={loader}
          source={content.source}
          mimetype={content.mimetype}
          kind="video"
          onClose={() => setPlaying(false)}
        />
      )}
    </div>
  );
}

function formatDuration(secs: number): string {
  const m = Math.floor(secs / 60);
  const s = Math.floor(secs % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}
