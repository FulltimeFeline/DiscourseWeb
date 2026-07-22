import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from "react";
import { Virtuoso, type VirtuosoHandle } from "react-virtuoso";
import type { EventEntry, TimelineEntry } from "@/models/types";
import { useViewModel } from "@/core/reactive";
import type { TimelineViewModel } from "./TimelineViewModel";
import { MessageRow } from "./MessageRow";
import { formatDayDivider } from "./render";
import { Icon } from "@/ui/Icon";

interface Props {
  vm: TimelineViewModel;
  ownUserId: string;
  onReply: (entry: EventEntry) => void;
  onEdit: (entry: EventEntry) => void;
  onOpenThread: (rootEventId: string) => void;
}

/** Imperative handle exposed to the parent (e.g. in-room search → jump). */
export interface TimelineViewHandle {
  /** Scroll to an event, back-paginating if it isn't loaded yet. Resolves to
   *  false if the event couldn't be found (before the room's start). */
  jumpToEvent: (eventId: string) => Promise<boolean>;
}

// react-virtuoso with alignToBottom + followOutput, and firstItemIndex tracked
// in the view model (atomically with the items). The VM owns the render list
// (state.visibleItems) and firstItemIndex, so prepends keep the scroll position
// without the jumpy view-side index juggling.
export const TimelineView = forwardRef<TimelineViewHandle, Props>(function TimelineView(
  { vm, ownUserId, onReply, onEdit, onOpenThread },
  handleRef,
) {
  const state = useViewModel(vm);
  const ref = useRef<VirtuosoHandle>(null);
  const [atBottom, setAtBottom] = useState(true);
  const items = state.visibleItems;
  const unreadIdx = items.findIndex((e) => e.kind === "virtual" && e.virtual.type === "readMarker");
  const hasUnreadMarker = unreadIdx >= 0;
  // Track whether the read marker is currently on screen so the pill only shows
  // when it's scrolled out of view (not when the unread block already fits).
  const [markerOnScreen, setMarkerOnScreen] = useState(false);
  // The "NEW" divider and "Jump to unread" pill auto-dismiss a few seconds after
  // appearing (they linger otherwise until the room is caught up).
  const [unreadFaded, setUnreadFaded] = useState(false);
  useEffect(() => {
    if (!hasUnreadMarker) {
      setUnreadFaded(false);
      return;
    }
    setUnreadFaded(false);
    const t = setTimeout(() => setUnreadFaded(true), 6000);
    return () => clearTimeout(t);
  }, [hasUnreadMarker]);

  const jumpToPresent = useCallback(() => {
    ref.current?.scrollToIndex({ index: "LAST", align: "end", behavior: "smooth" });
  }, []);

  const jumpToEvent = useCallback(
    async (eventId: string): Promise<boolean> => {
      const findIdx = () =>
        vm.state.visibleItems.findIndex((e) => e.kind === "event" && e.eventId === eventId);
      let idx = findIdx();
      if (idx < 0) {
        // Not in the loaded window: back-paginate until it loads (or start).
        await vm.ensureLoaded(eventId);
        idx = findIdx();
      }
      if (idx >= 0) ref.current?.scrollToIndex({ index: idx, align: "center", behavior: "smooth" });
      return idx >= 0;
    },
    [vm],
  );

  useImperativeHandle(handleRef, () => ({ jumpToEvent }), [jumpToEvent]);

  // When new content arrives while already pinned to the bottom,
  // `atBottomStateChange` does not fire (no state change), so it can't mark the
  // room read on its own. Mark read whenever the item list changes while at the
  // bottom; markAsRead() dedupes on the newest event id, so this is cheap.
  useEffect(() => {
    if (atBottom) void vm.markAsRead();
  }, [items, atBottom, vm]);

  // Reserve space at the bottom so the last message clears the floating glass
  // composer (and isn't stuck behind it when scrolled fully down).

  return (
    <div className={`timeline-scroller${unreadFaded ? " unread-faded" : ""}`}>
      <Virtuoso
        ref={ref}
        style={{ height: "100%" }}
        className="timeline-list"
        data={items}
        firstItemIndex={state.firstItemIndex}
        alignToBottom
        followOutput={true}
        startReached={() => void vm.paginateBackwards()}
        rangeChanged={(r) => {
          if (unreadIdx < 0) {
            setMarkerOnScreen(false);
            return;
          }
          // rangeChanged may report firstItemIndex-logical indices (~1e6) or
          // plain data indices; normalize before comparing to unreadIdx.
          const base = r.startIndex > 500_000 ? state.firstItemIndex : 0;
          setMarkerOnScreen(unreadIdx >= r.startIndex - base && unreadIdx <= r.endIndex - base);
        }}
        atBottomThreshold={130}
        atBottomStateChange={(b) => {
          setAtBottom(b);
          if (b) void vm.markAsRead();
        }}
        components={{ Footer: BottomSpacer }}
        computeItemKey={(_, item) => item.id}
        itemContent={(_, entry) => (
          <Row
            entry={entry}
            vm={vm}
            ownUserId={ownUserId}
            onReply={onReply}
            onEdit={onEdit}
            onOpenThread={onOpenThread}
            onJumpToEvent={jumpToEvent}
          />
        )}
      />
      {hasUnreadMarker && !markerOnScreen && (
        <button
          className={`jump-unread${unreadFaded ? " jump-unread--gone" : ""}`}
          onClick={() =>
            ref.current?.scrollToIndex({ index: unreadIdx, align: "start", behavior: "smooth" })
          }
        >
          <span className="jump-unread__caret"><Icon name="chevron-down" size={13} /></span> Jump to unread
        </button>
      )}
      {!atBottom && (
        <button className="jump-present" onClick={jumpToPresent} aria-label="Jump to present">
          <Icon name="chevron-down" size={18} />
        </button>
      )}
    </div>
  );
});

function BottomSpacer() {
  // Clearance so the newest message rests above the floating composer; as you
  // scroll up, messages pass behind the glass bar and refract through it.
  return <div style={{ height: 84 }} aria-hidden />;
}

function Row(props: {
  entry: TimelineEntry;
  vm: TimelineViewModel;
  ownUserId: string;
  onReply: (e: EventEntry) => void;
  onEdit: (e: EventEntry) => void;
  onOpenThread: (id: string) => void;
  onJumpToEvent: (id: string) => void;
}) {
  const { entry } = props;
  if (entry.kind === "virtual") {
    switch (entry.virtual.type) {
      case "dateDivider":
        return <div className="day-divider">{formatDayDivider(entry.virtual.ts)}</div>;
      case "readMarker":
        return <div className="read-marker">NEW</div>;
      case "timelineStart":
        return <div className="timeline-start">This is the beginning of the conversation.</div>;
      default:
        return null;
    }
  }
  return (
    <MessageRow
      entry={entry}
      vm={props.vm}
      ownUserId={props.ownUserId}
      onReply={props.onReply}
      onEdit={props.onEdit}
      onOpenThread={props.onOpenThread}
      onJumpToEvent={props.onJumpToEvent}
    />
  );
}
