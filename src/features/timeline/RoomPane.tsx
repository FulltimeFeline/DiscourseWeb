import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { AppState } from "@/app/AppState";
import type { EventEntry, RoomSummary } from "@/models/types";
import { useSession } from "@/app/context";
import { useViewModel, useStore } from "@/core/reactive";
import { preferences } from "@/core/Preferences";
import { Composer, type ComposerEditTarget, type ComposerReplyTarget } from "./Composer";
import type { TimelineViewModel } from "./TimelineViewModel";
import { acquireTimeline, releaseTimeline } from "./timelineCache";
import { TimelineView, type TimelineViewHandle } from "./TimelineView";
import { RoomHeader } from "./RoomHeader";
import { ThreadView } from "./ThreadView";
import { RoomSearchSheet } from "./RoomSearchSheet";
import { DetailsPanel } from "@/features/details/DetailsPanel";
import { Icon } from "@/ui/Icon";
import { settingsPrefs } from "@/features/settings/settingsPrefs";
import { consumePendingJump, peekPendingJump } from "@/core/notifications/pendingJump";
import "./timeline.css";

interface Props {
  app: AppState;
  roomId: string;
}

export function RoomPane({ app, roomId }: Props) {
  const session = useSession();
  void app;

  // Derive `room` synchronously from the current roomId so it can never lag
  // behind a room switch (a stale room object was getting cached under the new
  // room id, showing the wrong room). `session.getRoom` can transiently return
  // undefined right after selecting a room; a poll tick re-renders once it
  // materialises without ever mismatching roomId.
  const [pollTick, setPollTick] = useState(0);
  // Only show the terminal "Room unavailable" state once the poll below has
  // actually given up — before that, the missing room is just still loading.
  const [roomLookupFailed, setRoomLookupFailed] = useState(false);
  const room = useMemo(
    () => session.getRoom(roomId) ?? undefined,
    [session, roomId, pollTick],
  );
  useEffect(() => {
    setRoomLookupFailed(false);
    if (session.getRoom(roomId)) return;
    let tries = 0;
    const id = setInterval(() => {
      tries++;
      if (session.getRoom(roomId)) {
        setPollTick((t) => t + 1);
        clearInterval(id);
      } else if (tries >= 30) {
        console.warn("[timeline] room never materialised", roomId);
        setRoomLookupFailed(true);
        clearInterval(id);
      }
    }, 500);
    return () => clearInterval(id);
  }, [session, roomId]);

  // The view model comes from a per-session LRU cache (acquireTimeline) instead
  // of being built fresh each open, so returning to a recent room reuses its
  // retained FFI timeline + already-mapped entries and paints instantly. The
  // cache owns the VM's lifetime: we `release` (park) on unmount rather than
  // dispose, and the cache disposes on eviction/logout. Acquired inside the
  // effect (not useMemo) so StrictMode's mount/unmount/mount stays consistent —
  // acquire is idempotent per room and release just parks, so a double-invoke
  // ends with the room active either way.
  const [vm, setVm] = useState<TimelineViewModel | undefined>(undefined);
  // useLayoutEffect (not useEffect) so the cached VM commits before paint —
  // acquire/park are synchronous and idempotent, so semantics are unchanged,
  // but a room switch no longer paints a blank frame first.
  useLayoutEffect(() => {
    if (!room) {
      setVm(undefined);
      return;
    }
    const v = acquireTimeline(session, room, roomId);
    setVm(v);
    return () => releaseTimeline(session, roomId);
  }, [session, room, roomId]);

  const [thread, setThread] = useState<string | null>(null);
  const [reply, setReply] = useState<ComposerReplyTarget | undefined>();
  const [edit, setEdit] = useState<ComposerEditTarget | undefined>();
  const [showDetails, setShowDetails] = useState(
    () => localStorage.getItem("discourse.details.open") === "1",
  );
  const [showSearch, setShowSearch] = useState(false);
  const tvRef = useRef<TimelineViewHandle>(null);

  // Remember whether the right details panel is open across reloads.
  useEffect(() => {
    localStorage.setItem("discourse.details.open", showDetails ? "1" : "0");
  }, [showDetails]);

  // Cmd/Ctrl+F opens in-room search when a room is open. Capture-phase plus
  // stopImmediatePropagation so the shell's global-search handler doesn't also fire.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "f" && !e.shiftKey && !e.altKey) {
        e.preventDefault();
        e.stopImmediatePropagation();
        setShowSearch(true);
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);

  // Opt+Cmd+I (dispatched by the shell) toggles the details panel.
  useEffect(() => {
    const toggle = () => setShowDetails((v) => !v);
    window.addEventListener("discourse:toggle-details", toggle);
    return () => window.removeEventListener("discourse:toggle-details", toggle);
  }, []);

  // Permalink and notification jump-to-event. The timeline handle back-paginates
  // to the event itself; we only wait for it to mount before asking.
  useEffect(() => {
    const onJump = (e: Event) => {
      const detail = (e as CustomEvent<{ roomId?: string; eventId?: string }>).detail;
      if (!detail?.eventId || detail.roomId !== roomId) return;
      const eventId = detail.eventId;
      consumePendingJump(roomId, eventId); // we're handling it; don't jump twice
      let tries = 0;
      const attempt = () => {
        const handle = tvRef.current;
        if (!handle) {
          if (tries++ < 20) setTimeout(attempt, 150); // wait for TimelineView mount
          return;
        }
        void handle.jumpToEvent(eventId);
      };
      attempt();
    };
    window.addEventListener("discourse:jump-to-event", onJump);
    return () => window.removeEventListener("discourse:jump-to-event", onJump);
  }, [roomId]);

  // A cross-room jump is dispatched before this pane exists (MainShell keys
  // RoomPane on the room), so it's also parked. `vm` is undefined on the first
  // render, so this runs once TimelineView has committed.
  useEffect(() => {
    if (!vm) return;
    const eventId = peekPendingJump(roomId);
    if (eventId && consumePendingJump(roomId, eventId)) {
      void tvRef.current?.jumpToEvent(eventId);
    }
  }, [roomId, vm]);

  // These three flow as props into the memoized MessageRow (via TimelineView's
  // itemContent). They MUST be referentially stable, or every timeline state
  // change (typing, receipts, pagination) re-renders every visible row. The
  // setState setters are stable, so empty deps are correct. Declared before the
  // early returns below so the hook order is unconditional (Rules of Hooks).
  const startReply = useCallback((e: EventEntry) => {
    setEdit(undefined);
    setReply({
      eventId: e.eventId ?? "",
      senderName: e.senderProfile.displayName ?? e.sender,
      body: bodyText(e),
    });
  }, []);
  const startEdit = useCallback((e: EventEntry) => {
    setReply(undefined);
    if (e.eventId) setEdit({ eventId: e.eventId, body: bodyText(e) });
  }, []);
  const openThread = useCallback((id: string) => setThread(id), []);

  if (!room) {
    if (!roomLookupFailed) {
      // Still loading (the poll above hasn't given up yet).
      return (
        <div className="room-pane">
          <div className="timeline-empty">
            <div className="boot__spinner" />
          </div>
        </div>
      );
    }
    return (
      <div className="room-pane">
        <div className="timeline-empty">Room unavailable</div>
      </div>
    );
  }
  if (!vm) {
    // Room exists; the timeline VM is being created (one render tick).
    return <div className="room-pane" />;
  }

  return (
    <div className="room-pane">
      <RoomHeader
        vm={vm}
        roomId={roomId}
        onToggleDetails={() => setShowDetails((v) => !v)}
        onOpenSearch={() => setShowSearch(true)}
        onBack={() => app.selectRoom(null)}
      />
      <div className="room-pane__row">
        <div className="room-pane__main">
          <CallBanner vm={vm} roomId={roomId} />
          <TimelineView
          ref={tvRef}
          vm={vm}
          ownUserId={session.userId}
          onReply={startReply}
          onEdit={startEdit}
          onOpenThread={openThread}
        />
        <TypingIndicator vm={vm} />
        <UnencryptedBanner vm={vm} />
        <Composer
          room={roomSummaryFor(vm, roomId)}
          session={session}
          replyTarget={reply}
          editTarget={edit}
          onClearReply={() => setReply(undefined)}
          onClearEdit={() => setEdit(undefined)}
          onEditLast={() => {
            const e = vm.lastOwnEditableMessage();
            if (e) startEdit(e);
          }}
          onCreatePoll={(poll) => void vm.createPoll(poll.question, poll.answers, poll.kind)}
          onShareLocation={() => void vm.shareLocation()}
        />
        {thread && (
          <ThreadView
            roomId={roomId}
            rootEventId={thread}
            room={roomSummaryFor(vm, roomId)}
            onClose={() => setThread(null)}
          />
        )}
        {showSearch && (
          <RoomSearchSheet
            vm={vm}
            onJump={(id) => tvRef.current?.jumpToEvent(id)}
            onClose={() => setShowSearch(false)}
          />
        )}
        </div>
        {showDetails && (
          <DetailsPanel roomId={roomId} onClose={() => setShowDetails(false)} />
        )}
      </div>
    </div>
  );
}

function TypingIndicator({ vm }: { vm: TimelineViewModel }) {
  const state = useViewModel(vm);
  const prefs = useStore(preferences);
  if (!prefs.showTypingIndicators || state.typingUsers.length === 0) return null;
  const names = state.typingUsers.map((u) => vm.displayNameFor(u));
  let text: string;
  if (names.length === 1) text = `${names[0]} is typing…`;
  else if (names.length === 2) text = `${names[0]} and ${names[1]} are typing…`;
  else text = "Several people are typing…";
  return <div className="typing-tag">{text}</div>;
}

function UnencryptedBanner({ vm }: { vm: TimelineViewModel }) {
  const state = useViewModel(vm);
  const prefs = useStore(settingsPrefs);
  if (state.isEncrypted || !prefs.warnUnencrypted) return null;
  return (
    <div className="unencrypted-banner">
      <Icon name="warning" size={14} /> Messages here aren’t end-to-end encrypted
    </div>
  );
}

function CallBanner({ vm, roomId }: { vm: TimelineViewModel; roomId: string }) {
  const state = useViewModel(vm);
  if (!state.hasActiveCall) return null;
  const join = () =>
    window.dispatchEvent(
      new CustomEvent("discourse:open-call", {
        detail: { roomId, roomName: state.roomName, joinExisting: true },
      }),
    );
  const n = state.callParticipantCount;
  return (
    <div className="call-banner">
      <span>
        <Icon name="phone" /> Call in progress{n > 0 ? ` · ${n} in call` : ""}
      </span>
      <button className="call-banner__join" onClick={join}>
        Join
      </button>
    </div>
  );
}

function bodyText(e: EventEntry): string {
  const c = e.content;
  return "body" in c ? c.body : "";
}

/**
 * The composer wants a RoomSummary. We only need the fields it reads (id,
 * name, etc.), so build a light one from the VM's live state so the composer
 * has a stable room identity without pulling in the room-list feature.
 */
function roomSummaryFor(vm: TimelineViewModel, roomId: string): RoomSummary {
  const s = vm.state;
  return {
    id: roomId,
    name: s.roomName,
    foldedName: s.roomName.toLowerCase(),
    topic: s.topic,
    isDirect: false,
    isSpace: false,
    isEncrypted: s.isEncrypted,
    isFavourite: false,
    isLowPriority: false,
    isVideoRoom: false,
    membership: "joined",
    heroes: [],
    unreadMessages: 0,
    unreadNotifications: 0,
    unreadMentions: 0,
    isMarkedUnread: false,
    isMuted: false,
    hasActiveCall: s.hasActiveCall,
    activeCallParticipants: [],
  };
}
