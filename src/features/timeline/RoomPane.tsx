import { useEffect, useMemo, useRef, useState } from "react";
import type { AppState } from "@/app/AppState";
import type { EventEntry, RoomSummary } from "@/models/types";
import { useSession } from "@/app/context";
import { useViewModel, useStore } from "@/core/reactive";
import { preferences } from "@/core/Preferences";
import { Composer, type ComposerEditTarget, type ComposerReplyTarget } from "./Composer";
import { TimelineViewModel } from "./TimelineViewModel";
import { TimelineView, type TimelineViewHandle } from "./TimelineView";
import { RoomHeader } from "./RoomHeader";
import { ThreadView } from "./ThreadView";
import { RoomSearchSheet } from "./RoomSearchSheet";
import { DetailsPanel } from "@/features/details/DetailsPanel";
import { Icon } from "@/ui/Icon";
import { settingsPrefs } from "@/features/settings/settingsPrefs";
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
  const room = useMemo(
    () => session.getRoom(roomId) ?? undefined,
    [session, roomId, pollTick],
  );
  useEffect(() => {
    if (session.getRoom(roomId)) return;
    let tries = 0;
    const id = setInterval(() => {
      tries++;
      if (session.getRoom(roomId)) {
        setPollTick((t) => t + 1);
        clearInterval(id);
      } else if (tries >= 30) {
        console.warn("[timeline] room never materialised", roomId);
        clearInterval(id);
      }
    }, 500);
    return () => clearInterval(id);
  }, [session, roomId]);

  // A fresh view model per room open: firstItemIndex resets, no state shared
  // across mounts. Created inside the effect (not useMemo) so React StrictMode's
  // mount/unmount/mount can't leave us starting a disposed instance. Each effect
  // run gets its own VM and disposes exactly it.
  const [vm, setVm] = useState<TimelineViewModel | undefined>(undefined);
  useEffect(() => {
    if (!room) {
      setVm(undefined);
      return;
    }
    const v = new TimelineViewModel(session, room, roomId, { type: "live" });
    setVm(v);
    void v.start();
    return () => v.dispose();
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

  if (!room) {
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

  const startReply = (e: EventEntry) => {
    setEdit(undefined);
    setReply({
      eventId: e.eventId ?? "",
      senderName: e.senderProfile.displayName ?? e.sender,
      body: bodyText(e),
    });
  };
  const startEdit = (e: EventEntry) => {
    setReply(undefined);
    if (e.eventId) setEdit({ eventId: e.eventId, body: bodyText(e) });
  };

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
          onOpenThread={(id) => setThread(id)}
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
