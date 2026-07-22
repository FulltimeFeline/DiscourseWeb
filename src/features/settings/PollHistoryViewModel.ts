// Collects a room's polls for the Details Polls tab. Opens its own hidden
// timeline and mirrors the SDK's item list by applying diffs, since there's no
// dedicated poll-history API. Polls aren't a RoomMessage type (so OnlyMessage
// can't select them), so we use an unfiltered timeline and pick out poll
// entries. Votes and ends go through this timeline.

import {
  DateDividerMode,
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
import type { EventEntry, PollContent } from "@/models/types";
import { mapTimelineItem } from "@/features/timeline/timelineEntryMapper";

export interface PollHistoryItem {
  id: string;
  poll: PollContent;
  /** Did the current user start this poll (i.e. can they end it)? */
  isOwn: boolean;
  timestamp: number;
}

interface PollState {
  loading: boolean;
  error: boolean;
  items: PollHistoryItem[];
}

const POLL_PAGES = 6;
const PAGE_SIZE = 50;

export class PollHistoryViewModel extends ViewModel<PollState> {
  private timeline?: TimelineInterface;
  private readonly subs = new Subscriptions();
  private disposed = false;
  private items: TimelineItemInterface[] = [];

  constructor(
    private readonly session: MatrixSession,
    private readonly roomId: string,
  ) {
    super({ loading: true, error: false, items: [] });
  }

  async start(): Promise<void> {
    // Re-arm for React StrictMode mount→dispose→mount on the same instance.
    this.disposed = false;
    const room = this.session.getRoom(this.roomId);
    if (!room) {
      this.setState({ loading: false, error: true });
      return;
    }
    try {
      const config: TimelineConfiguration = {
        focus: new TimelineFocus.Live({ hideThreadedEvents: false }),
        filter: new TimelineFilter.All(),
        internalIdPrefix: "details-polls",
        dateDividerMode: DateDividerMode.Daily,
        trackReadReceipts: false,
        reportUtds: false,
      };
      const timeline = await (room as RoomInterface).timelineWithConfiguration(config);
      if (this.disposed) return;
      this.timeline = timeline;

      const handle = await timeline.addListener({
        onUpdate: (diffs: Array<TimelineDiff>) => this.apply(diffs),
      });
      if (this.disposed) {
        disposeHandle(handle);
        return;
      }
      this.subs.track(handle); // must retain, else the subscription detaches

      for (let i = 0; i < POLL_PAGES; i++) {
        if (this.disposed) return;
        const reachedStart = await timeline.paginateBackwards(PAGE_SIZE);
        if (reachedStart) break;
      }
      if (!this.disposed) this.rebuild();
    } catch {
      if (!this.disposed) this.setState({ loading: false, error: true });
    }
  }

  async votePoll(startEventId: string, answerId: string): Promise<void> {
    if (!this.timeline) return;
    try {
      await this.timeline.sendPollResponse(startEventId, [answerId]);
    } catch {
      /* ignore, poll may have ended */
    }
  }

  async endPoll(startEventId: string): Promise<void> {
    if (!this.timeline) return;
    try {
      await this.timeline.endPoll(startEventId, "The poll has ended.");
    } catch {
      /* ignore */
    }
  }

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
    const polls: PollHistoryItem[] = [];
    for (const raw of this.items) {
      const entry = mapTimelineItem(raw, ctx);
      if (entry.kind !== "event") continue;
      const e = entry as EventEntry;
      if (e.content.type !== "poll") continue;
      polls.push({
        id: e.id,
        poll: e.content,
        isOwn: e.sender === this.session.userId,
        timestamp: e.timestamp,
      });
    }
    // Newest first.
    polls.sort((a, b) => b.timestamp - a.timestamp);
    this.setState({ loading: false, error: false, items: polls });
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
