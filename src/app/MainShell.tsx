import { useEffect, useMemo, useRef, useState } from "react";
import { useStore, useViewModel } from "@/core/reactive";
import type { AppState } from "./AppState";
import type { MatrixSession } from "@/core/MatrixSession";
import { SessionProvider } from "./context";
import { SpacesRail } from "@/features/roomlist/SpacesRail";
import { SidebarView } from "@/features/roomlist/SidebarView";
import { useRoomListScope } from "@/features/roomlist/scope";
import { RoomPane } from "@/features/timeline/RoomPane";
import { ModalHost, SettingsButton } from "@/features/settings";
import { KeyboardShortcuts } from "./KeyboardShortcuts";
import { VerificationManager, useNeedsVerification } from "@/features/verification";
import { IncomingCallListener, CallView, incomingCallStoreFor, isLocallyActiveCall } from "@/features/call";
import { NewChat } from "@/features/compose";
import { WebNotifications } from "@/core/notifications/WebNotifications";
import { settingsPrefs } from "@/features/settings/settingsPrefs";
import { registerWebPush, webPushConfigured } from "@/core/notifications/webPush";
import { LoginView } from "@/features/auth/LoginView";
import { Icon } from "@/ui/Icon";
import "./shell.css";

type ComposeMode = "dm" | "room" | "space" | "join";

/** Detail of the `discourse:open-call` window event (from a room's Join button). */
interface OpenCallDetail {
  roomId: string;
  roomName?: string;
  joinExisting: boolean;
}

/**
 * The signed-in layout: spaces rail, room-list sidebar, room pane, plus the
 * cross-cutting overlays (quick switcher / compose / search via KeyboardShortcuts,
 * settings modals, incoming-call ring, device verification, and the call view).
 */
export function MainShell({ app, session }: { app: AppState; session: MatrixSession }) {
  // The provider must wrap everything that uses session-context hooks
  // (useSession / useNeedsVerification / …), so the content lives in a child.
  return (
    <SessionProvider session={session}>
      <ShellContent app={app} session={session} />
    </SessionProvider>
  );
}

function ShellContent({ app, session }: { app: AppState; session: MatrixSession }) {
  const s = useViewModel(app);
  const scope = useRoomListScope(app, session);
  const roomList = useViewModel(scope.roomList);
  const needsVerification = useNeedsVerification();
  const sync = useStore(session.syncState);
  const disconnected = sync === "offline" || sync === "error" || sync === "terminated";

  const [call, setCall] = useState<OpenCallDetail | null>(null);
  const [compose, setCompose] = useState<ComposeMode | null>(null);
  // Verification: auto-prompt once; after "Not now" a persistent banner lets you
  // verify later instead of being locked out of the prompt until reload.
  const [verifyDismissed, setVerifyDismissed] = useState(false);

  // The rail "+" (new space) and any "new chat" affordance dispatch these.
  useEffect(() => {
    const onNewSpace = () => setCompose("space");
    const onNewChat = () => setCompose("dm");
    const onNewRoom = () => setCompose("room");
    const onNewJoin = () => setCompose("join");
    const onSelectRoom = (e: Event) => {
      const id = (e as CustomEvent<{ roomId?: string }>).detail?.roomId;
      if (id) app.selectRoom(id);
    };
    window.addEventListener("discourse:new-space", onNewSpace);
    window.addEventListener("discourse:new-chat", onNewChat);
    window.addEventListener("discourse:new-room", onNewRoom);
    window.addEventListener("discourse:new-join", onNewJoin);
    window.addEventListener("discourse:select-room", onSelectRoom);
    return () => {
      window.removeEventListener("discourse:new-space", onNewSpace);
      window.removeEventListener("discourse:new-chat", onNewChat);
      window.removeEventListener("discourse:new-room", onNewRoom);
      window.removeEventListener("discourse:new-join", onNewJoin);
      window.removeEventListener("discourse:select-room", onSelectRoom);
    };
  }, []);

  // Feed the ring watcher the set of joined rooms so it can detect incoming
  // calls (hasRoomCall rising edges).
  useEffect(() => {
    const ids = roomList.rooms
      .filter((r) => r.membership === "joined")
      .map((r) => r.id);
    incomingCallStoreFor(session).setWatchedRooms(ids);
  }, [session, roomList.rooms]);

  // Desktop notifications: fire on a new non-own message in a room that isn't
  // the focused one. Drives off the room-list preview timestamps (no second
  // subscription). The first pass only primes the baseline so we don't notify
  // for the whole backlog on launch.
  const notifier = useMemo(() => new WebNotifications(app), [app]);
  const lastPreviewTs = useRef<Map<string, number>>(new Map());
  const notifyPrimed = useRef(false);
  useEffect(() => {
    void notifier.requestPermission().then((granted) => {
      // Background push (deployment-gated; no-op unless a gateway is configured).
      if (granted && webPushConfigured()) void registerWebPush(session);
    });
  }, [notifier, session]);
  // A push notification click (handled by the service worker) asks the app to
  // open the room; also honor a ?room= deep link from a cold-opened window.
  useEffect(() => {
    const onSwMessage = (e: MessageEvent) => {
      if (e.data?.type === "discourse:navigate" && e.data.roomId) app.selectRoom(e.data.roomId);
    };
    navigator.serviceWorker?.addEventListener("message", onSwMessage);
    const room = new URL(window.location.href).searchParams.get("room");
    if (room) {
      app.selectRoom(room);
      window.history.replaceState({}, "", "/");
    }
    return () => navigator.serviceWorker?.removeEventListener("message", onSwMessage);
  }, [app]);
  // Feed the notification preview-level + sound preferences into the notifier
  // (they were dead toggles before), keeping it in sync as they change.
  useEffect(() => {
    const apply = () => {
      notifier.setPreviewLevel(settingsPrefs.get("notificationPreview"));
      notifier.setSound(settingsPrefs.get("notificationSound"));
    };
    apply();
    return settingsPrefs.subscribe(apply);
  }, [notifier]);
  useEffect(() => {
    const prev = lastPreviewTs.current;
    for (const r of roomList.rooms) {
      const p = r.preview;
      if (!p) continue;
      const last = prev.get(r.id);
      prev.set(r.id, p.ts);
      if (!notifyPrimed.current) continue;
      if (last !== undefined && p.ts > last && !p.isOwn) {
        notifier.notifyMessage({
          roomId: r.id,
          eventId: `${r.id}:${p.ts}`,
          roomName: r.name,
          senderName: p.senderName ?? p.senderId,
          body: p.body,
          timestampMs: p.ts,
          isOwn: false,
        });
      }
    }
    notifyPrimed.current = true;
  }, [roomList.rooms, notifier]);
  // One-shot banner when a new invite arrives (primed so launch-time pending
  // invites don't all fire at once).
  const invitesSeen = useRef<Set<string>>(new Set());
  const invitesPrimed = useRef(false);
  useEffect(() => {
    for (const inv of roomList.invites) {
      if (invitesSeen.current.has(inv.id)) continue;
      invitesSeen.current.add(inv.id);
      if (!invitesPrimed.current) continue;
      notifier.notifyInvite({
        roomId: inv.id,
        roomName: inv.name,
        inviterName: inv.inviter?.displayName ?? inv.inviter?.userId ?? "Someone",
      });
    }
    invitesPrimed.current = true;
  }, [roomList.invites, notifier]);
  // OS notification for an ongoing call in any room (group calls included),
  // tap to join; cleared when the call ends. Skips calls we're in ourselves.
  const callStore = useMemo(() => incomingCallStoreFor(session), [session]);
  const activeCalls = useStore(callStore.activeCalls);
  const callsNotified = useRef<Set<string>>(new Set());
  const callsPrimed = useRef(false);
  useEffect(() => {
    const active = new Set(Object.keys(activeCalls).filter((k) => activeCalls[k]));
    for (const id of [...callsNotified.current]) {
      if (!active.has(id)) {
        notifier.clearCall(id);
        callsNotified.current.delete(id);
      }
    }
    for (const id of active) {
      if (callsNotified.current.has(id) || isLocallyActiveCall(id)) continue;
      callsNotified.current.add(id);
      if (!callsPrimed.current) continue;
      const room = roomList.rooms.find((r) => r.id === id);
      notifier.notifyCall({ roomId: id, roomName: room?.name ?? "Call" });
    }
    callsPrimed.current = true;
  }, [activeCalls, notifier, roomList.rooms]);
  // Clear a room's banners when it's opened.
  useEffect(() => {
    if (s.selectedRoomId) notifier.clearRoom(s.selectedRoomId);
  }, [s.selectedRoomId, notifier]);

  // A room's "Join call" button dispatches this so we can open the call overlay
  // without threading a callback through the timeline feature.
  useEffect(() => {
    const onOpenCall = (e: Event) => {
      const detail = (e as CustomEvent<OpenCallDetail>).detail;
      if (detail?.roomId) setCall(detail);
    };
    window.addEventListener("discourse:open-call", onOpenCall as EventListener);
    return () =>
      window.removeEventListener("discourse:open-call", onOpenCall as EventListener);
  }, []);

  return (
    <div className={`shell${s.selectedRoomId ? " shell--room-open" : ""}`}>
      {disconnected && (
        <div className={`shell__netbanner${sync === "offline" ? " shell__netbanner--offline" : ""}`}>
          {sync === "offline" ? "You're offline" : "Reconnecting…"}
        </div>
      )}
      {needsVerification && verifyDismissed && (
        <div className="shell__verifybanner">
          <span><Icon name="shield" size={13} /> This session isn’t verified — your encrypted messages stay locked.</span>
          <button onClick={() => setVerifyDismissed(false)}>Verify</button>
        </div>
      )}
      <aside className="shell__rail">
          <SpacesRail app={app} />
          <div className="shell__rail-footer">
            <SettingsButton />
          </div>
        </aside>
        <aside className="shell__sidebar">
          <SidebarView app={app} />
        </aside>
        <main className="shell__room">
          {s.selectedRoomId ? (
            <RoomPane key={s.selectedRoomId} app={app} roomId={s.selectedRoomId} />
          ) : (
            <div className="shell__empty">
              <Icon name="envelope" size={44} strokeWidth={1.4} className="shell__empty-glyph" />
              <div>Select a conversation</div>
            </div>
          )}
        </main>

        {/* Cross-cutting overlays */}
        <ModalHost />
        <KeyboardShortcuts app={app} />
        <VerificationManager
          showVerify={needsVerification && !verifyDismissed}
          onVerifyClosed={() => setVerifyDismissed(true)}
        />
        <IncomingCallListener
          onAccept={(roomId) => setCall({ roomId, joinExisting: true })}
        />
        {call && (
          <div className="shell__call-overlay">
            <CallView
              roomId={call.roomId}
              roomName={call.roomName}
              joinExisting={call.joinExisting}
              onClose={() => setCall(null)}
            />
          </div>
        )}
        {compose && (
          <NewChat initialMode={compose} onClose={() => setCompose(null)} />
        )}
        {s.isAddAccountOpen && (
          <div className="shell__addaccount">
            <button
              className="shell__addaccount-close"
              onClick={() => app.setAddAccountOpen(false)}
              aria-label="Cancel"
            >
              <Icon name="x" size={20} />
            </button>
            <LoginView app={app} />
          </div>
        )}
      </div>
  );
}
