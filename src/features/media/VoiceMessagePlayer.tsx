// Received voice-message player.
//
// Play/pause via the shared AudioPlaybackController (one per session, survives
// row recycling). 36 waveform bars resampled from the event's stored samples
// (clamped 0.12 to 1); the played portion is tinted; a deterministic sine
// fallback is used when the event carries no waveform. The time label counts
// down while playing (remaining), else shows the total.

import { useMemo } from "react";
import { useStore } from "@/core/reactive";
import type { MediaLoader } from "@/core/MediaLoader";
import type { AudioContent } from "@/models/types";
import { audioPlaybackFor } from "./AudioPlayback";
import { Icon } from "@/ui/Icon";
import "./media.css";

interface Props {
  /** Stable timeline item id (keys the shared controller). */
  itemId: string;
  content: AudioContent;
  loader: MediaLoader;
  sessionId: string;
}

const BAR_COUNT = 36;

export function VoiceMessagePlayer({ itemId, content, loader, sessionId }: Props) {
  const controller = audioPlaybackFor(sessionId, loader);
  const snap = useStore(controller.store);

  const isActive = snap.activeId === itemId;
  const isLoading = snap.loadingId === itemId;
  const failed = snap.failedIds.has(itemId);
  const progress = isActive ? snap.progress : 0;
  const playing = isActive && snap.playing;

  const bars = useMemo(() => resample(content.waveform, BAR_COUNT), [content.waveform]);

  const total = content.duration ?? snap.duration;
  const remaining = isActive ? Math.max(0, (snap.duration || total) - snap.currentTime) : total;
  const timeLabel = formatTime(isActive && playing ? remaining : total);

  const onBar = (idx: number) => {
    if (isActive) controller.seek((idx + 0.5) / BAR_COUNT);
  };

  return (
    <div className="dc-voice-player">
      <button
        className="dc-voice-toggle"
        type="button"
        onClick={() => {
          if (failed) controller.toggle(itemId, content.source, content.mimetype);
          else controller.toggle(itemId, content.source, content.mimetype);
        }}
        aria-label={playing ? "Pause voice message" : "Play voice message"}
      >
        {isLoading ? <span className="dc-spinner small" /> : failed ? <Icon name="retry" size={16} /> : playing ? <Icon name="pause" size={16} /> : <Icon name="play" size={16} />}
      </button>
      <div className="dc-voice-waveform" role="slider" aria-label="Seek">
        {bars.map((h, i) => {
          const played = i / BAR_COUNT <= progress;
          return (
            <span
              key={i}
              className={`dc-voice-bar${played ? " played" : ""}`}
              style={{ height: `${Math.round(h * 100)}%` }}
              onClick={() => onBar(i)}
            />
          );
        })}
      </div>
      <span className="dc-voice-time">{timeLabel}</span>
    </div>
  );
}

/** Resample stored waveform samples to `count` bars, clamped 0.12…1. */
function resample(samples: number[] | undefined, count: number): number[] {
  if (!samples || samples.length === 0) {
    // Deterministic sine fallback shape.
    return Array.from({ length: count }, (_, i) =>
      clamp(0.35 + 0.4 * Math.abs(Math.sin((i / count) * Math.PI * 3))),
    );
  }
  const out: number[] = [];
  const step = samples.length / count;
  for (let i = 0; i < count; i++) {
    const start = Math.floor(i * step);
    const end = Math.max(start + 1, Math.floor((i + 1) * step));
    let max = 0;
    for (let j = start; j < end && j < samples.length; j++) if (samples[j] > max) max = samples[j];
    out.push(clamp(max));
  }
  return out;
}

function clamp(v: number): number {
  return Math.max(0.12, Math.min(1, v));
}

function formatTime(secs: number): string {
  const s = Math.max(0, Math.floor(secs));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}
