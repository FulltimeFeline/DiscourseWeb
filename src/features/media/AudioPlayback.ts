// A single audio-playback controller per timeline, keyed by timeline item id.
// It survives React row recycling by living in a module-level registry (one per
// session id) rather than in component state, so pausing/scrubbing state isn't
// lost when a row unmounts and remounts.
//
// Only one clip plays at a time; only one download is in flight
// (`loadingItemId` guard). Failed downloads are remembered so rows can show a
// retry control. A 0.1s progress signal drives the waveform tint and countdown.

import { Store } from "@/core/reactive";
import type { MediaLoader } from "@/core/MediaLoader";
import type { MediaRef } from "@/models/types";

export interface PlaybackSnapshot {
  activeId?: string;
  playing: boolean;
  /** 0..1 progress of the active clip. */
  progress: number;
  /** Seconds elapsed of the active clip. */
  currentTime: number;
  duration: number;
  loadingId?: string;
  failedIds: ReadonlySet<string>;
}

const EMPTY: PlaybackSnapshot = {
  playing: false,
  progress: 0,
  currentTime: 0,
  duration: 0,
  failedIds: new Set(),
};

export class AudioPlaybackController {
  readonly store = new Store<PlaybackSnapshot>(EMPTY);

  private audio?: HTMLAudioElement;
  private activeId?: string;
  private activeUrl?: string;
  private loadingId?: string;
  private failedIds = new Set<string>();
  private ticker?: number;

  constructor(private loader: MediaLoader) {}

  private publish(patch: Partial<PlaybackSnapshot>): void {
    this.store.update((s) => ({ ...s, ...patch, failedIds: new Set(this.failedIds) }));
  }

  /** Toggle play/pause for an item; loads + starts it if not already active. */
  async toggle(itemId: string, source: MediaRef, mimetype?: string): Promise<void> {
    if (this.activeId === itemId && this.audio) {
      if (this.audio.paused) {
        await this.audio.play().catch(() => {});
        this.publish({ playing: true });
        this.startTicker();
      } else {
        this.audio.pause();
        this.publish({ playing: false });
        this.stopTicker();
      }
      return;
    }

    // Switching clips: stop the current one.
    this.stopInternal();

    if (this.loadingId) return; // one download in flight
    this.loadingId = itemId;
    this.failedIds.delete(itemId);
    this.publish({ loadingId: itemId });

    const url = await this.loader.load({ source: source.source, mxc: source.mxc, mimetype });
    this.loadingId = undefined;
    if (!url) {
      this.failedIds.add(itemId);
      this.publish({ loadingId: undefined });
      return;
    }

    const audio = new Audio(url);
    this.audio = audio;
    this.activeId = itemId;
    this.activeUrl = url;
    audio.onended = () => {
      this.publish({ playing: false, progress: 0, currentTime: 0 });
      this.stopTicker();
    };
    audio.onloadedmetadata = () => {
      this.publish({ duration: Number.isFinite(audio.duration) ? audio.duration : 0 });
    };
    await audio.play().catch(() => {});
    this.publish({
      activeId: itemId,
      playing: true,
      loadingId: undefined,
      progress: 0,
      currentTime: 0,
    });
    this.startTicker();
  }

  /** Seek the active clip to a 0..1 fraction. */
  seek(fraction: number): void {
    if (!this.audio || !Number.isFinite(this.audio.duration)) return;
    this.audio.currentTime = Math.max(0, Math.min(1, fraction)) * this.audio.duration;
    this.tick();
  }

  private startTicker(): void {
    this.stopTicker();
    this.ticker = window.setInterval(() => this.tick(), 100);
  }

  private stopTicker(): void {
    if (this.ticker !== undefined) {
      clearInterval(this.ticker);
      this.ticker = undefined;
    }
  }

  private tick(): void {
    if (!this.audio) return;
    const duration = Number.isFinite(this.audio.duration) ? this.audio.duration : 0;
    const currentTime = this.audio.currentTime;
    this.publish({
      currentTime,
      duration,
      progress: duration > 0 ? currentTime / duration : 0,
    });
  }

  private stopInternal(): void {
    this.stopTicker();
    if (this.audio) {
      this.audio.pause();
      this.audio.src = "";
      this.audio = undefined;
    }
    this.activeId = undefined;
    this.activeUrl = undefined;
  }

  dispose(): void {
    this.stopInternal();
    this.store.set(EMPTY);
  }
}

// One controller per session (keyed so a re-login rebuilds it). Kept module-
// level so it survives row recycling.
const registry = new Map<string, AudioPlaybackController>();

export function audioPlaybackFor(sessionId: string, loader: MediaLoader): AudioPlaybackController {
  let c = registry.get(sessionId);
  if (!c) {
    c = new AudioPlaybackController(loader);
    registry.set(sessionId, c);
  }
  return c;
}

export function disposeAudioPlayback(sessionId: string): void {
  registry.get(sessionId)?.dispose();
  registry.delete(sessionId);
}
