// Collects a room's shared images/videos for the Media tab. There is no
// dedicated media API in this SDK build, so we open a fresh, hidden timeline
// scoped by a media-only filter (`TimelineFilter.OnlyMessage([Image, Video])`)
// and read its items. We reuse the timeline entry mapper so image/video content
// (MediaRef + thumbnail + blurhash) comes out identical to the main timeline.
//
// Ownership: this VM owns its own Timeline + diff-listener TaskHandle, entirely
// separate from the live TimelineViewModel. The handle MUST be retained or the
// SDK silently cancels the subscription (same invariant as the main timeline).
// A few backward pages are paginated so the grid isn't limited to the newest
// screenful.

import {
  DateDividerMode,
  RoomMessageEventMessageType,
  TimelineConfiguration,
  TimelineDiff_Tags,
  TimelineFilter,
  TimelineFocus,
  type RoomInterface,
  type TimelineDiff,
  type TimelineInterface,
  type TimelineItemInterface,
} from "@/matrix";
import { ViewModel } from "@/core/reactive";
import { Subscriptions, disposeHandle } from "@/core/listeners";
import type { MatrixSession } from "@/core/MatrixSession";
import type { EventEntry, MediaRef } from "@/models/types";
import { mapTimelineItem } from "@/features/timeline/timelineEntryMapper";

export interface MediaItem {
  id: string;
  kind: "image" | "video" | "file" | "audio";
  /** Full-res source (opened in the lightbox / downloaded). */
  source: MediaRef;
  /** Thumbnail source when the event carried one, else the full source. */
  thumbnail: MediaRef;
  mimetype?: string;
  blurhash?: string;
  body: string;
  size?: number;
  timestamp: number;
}

interface MediaState {
  loading: boolean;
  error: boolean;
  items: MediaItem[];
}

const MEDIA_PAGES = 4;
const PAGE_SIZE = 50;

export class MediaViewModel extends ViewModel<MediaState> {
  private timeline?: TimelineInterface;
  private readonly subs = new Subscriptions();
  private disposed = false;
  /** The SDK's ordered item list, maintained by applying diffs. */
  private items: TimelineItemInterface[] = [];

  constructor(
    private readonly session: MatrixSession,
    private readonly roomId: string,
  ) {
    super({ loading: true, error: false, items: [] });
  }

  async start(): Promise<void> {
    // Re-arm: React StrictMode runs mount→dispose→mount on the SAME instance, so
    // the surviving mount's start() would otherwise see disposed=true (set by the
    // discarded run) and bail after building the timeline → stuck "loading…".
    this.disposed = false;
    const room = this.session.getRoom(this.roomId);
    if (!room) {
      this.setState({ loading: false, error: true });
      return;
    }
    try {
      const config: TimelineConfiguration = {
        focus: new TimelineFocus.Live({ hideThreadedEvents: false }),
        filter: new TimelineFilter.OnlyMessage({
          types: [
            RoomMessageEventMessageType.Image,
            RoomMessageEventMessageType.Video,
            RoomMessageEventMessageType.File,
            RoomMessageEventMessageType.Audio,
          ],
        }),
        internalIdPrefix: "details-media",
        dateDividerMode: DateDividerMode.Daily,
        trackReadReceipts: false,
        reportUtds: false,
      };

      const timeline = await (room as RoomInterface).timelineWithConfiguration(config);
      if (this.disposed) {
        void timeline; // dropped on dispose below
        return;
      }
      this.timeline = timeline;

      // Initial state arrives as a `.reset` diff. We keep a mirror of the SDK's
      // ordered item list by applying diffs, then rebuild the media set.
      const handle = await timeline.addListener({
        onUpdate: (diffs: Array<TimelineDiff>) => this.apply(diffs),
      });
      if (this.disposed) {
        disposeHandle(handle);
        return;
      }
      this.subs.track(handle); // RETAINED, else the subscription detaches.

      // Pull a few pages of history so the grid isn't just the newest screenful.
      for (let i = 0; i < MEDIA_PAGES; i++) {
        if (this.disposed) return;
        const reachedStart = await timeline.paginateBackwards(PAGE_SIZE);
        if (reachedStart) break;
      }
      if (!this.disposed) this.rebuild();
    } catch {
      if (!this.disposed) this.setState({ loading: false, error: true });
    }
  }

  /** Maintain the mirror item array (subset of the diff algebra we need). */
  private apply(diffs: Array<TimelineDiff>): void {
    if (this.disposed) return;
    const items = this.items;
    for (const diff of diffs) {
      switch (diff.tag) {
        case TimelineDiff_Tags.Append:
          for (const v of diff.inner.values) items.push(v);
          break;
        case TimelineDiff_Tags.PushBack:
          items.push(diff.inner.value);
          break;
        case TimelineDiff_Tags.PushFront:
          items.unshift(diff.inner.value);
          break;
        case TimelineDiff_Tags.PopFront:
          items.shift();
          break;
        case TimelineDiff_Tags.PopBack:
          items.pop();
          break;
        case TimelineDiff_Tags.Insert:
          items.splice(diff.inner.index, 0, diff.inner.value);
          break;
        case TimelineDiff_Tags.Set:
          items[diff.inner.index] = diff.inner.value;
          break;
        case TimelineDiff_Tags.Remove:
          items.splice(diff.inner.index, 1);
          break;
        case TimelineDiff_Tags.Truncate:
          items.length = diff.inner.length;
          break;
        case TimelineDiff_Tags.Clear:
          items.length = 0;
          break;
        case TimelineDiff_Tags.Reset:
          items.length = 0;
          for (const v of diff.inner.values) items.push(v);
          break;
      }
    }
    this.rebuild();
  }

  private rebuild(): void {
    if (this.disposed) return;
    const ctx = {
      ownUserId: this.session.userId,
      ownDisplayName: this.session.ownProfile.value.displayName,
      ownAvatarUrl: this.session.ownProfile.value.avatarUrl,
    };

    const media: MediaItem[] = [];
    for (const raw of this.items) {
      const entry = mapTimelineItem(raw, ctx);
      if (entry.kind !== "event") continue;
      const e = entry as EventEntry;
      const c = e.content;
      if (c.type === "image" || c.type === "video") {
        media.push({
          id: e.id,
          kind: c.type,
          source: c.source,
          thumbnail: c.thumbnail ?? c.source,
          mimetype: c.mimetype,
          blurhash: c.blurhash,
          body: c.body,
          size: c.size,
          timestamp: e.timestamp,
        });
      } else if (c.type === "file" || c.type === "audio") {
        media.push({
          id: e.id,
          kind: c.type,
          source: c.source,
          thumbnail: c.source,
          mimetype: c.mimetype,
          body: c.body,
          size: "size" in c ? c.size : undefined,
          timestamp: e.timestamp,
        });
      }
    }
    // Newest first for a media grid.
    media.sort((a, b) => b.timestamp - a.timestamp);
    this.setState({ loading: false, error: false, items: media });
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.subs.dispose();
    this.items = [];
    this.timeline = undefined;
    super.dispose();
  }
}
