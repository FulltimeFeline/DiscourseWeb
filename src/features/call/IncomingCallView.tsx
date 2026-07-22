// The ring UI plus the mountable listener.
//
// <IncomingCallListener/> mounts once in the shell: it renders the floating ring
// banner whenever IncomingCallStore has an active ring, plays the ringtone,
// auto-declines after 45s, and on accept invokes onAccept(roomId) (the shell/
// room then opens the CallView with joinExisting=true).

import { useEffect, useRef } from "react";
import { useSession } from "@/app/context";
import { useStore } from "@/core/reactive";
import { incomingCallStoreFor, type RingingCall } from "./IncomingCallStore";
import { RingtonePlayer } from "./ringtone";
import { Icon } from "@/ui/Icon";

const RING_TIMEOUT_MS = 45_000;

export function IncomingCallListener({
  onAccept,
}: {
  onAccept: (roomId: string) => void;
}) {
  const session = useSession();
  const store = incomingCallStoreFor(session);
  const ringing = useStore(store.ringing);

  if (!ringing) return null;
  return (
    <IncomingCallView
      call={ringing}
      onAccept={() => {
        store.clearRing(ringing.roomId);
        onAccept(ringing.roomId);
      }}
      onDecline={() => store.clearRing(ringing.roomId)}
    />
  );
}

export function IncomingCallView({
  call,
  onAccept,
  onDecline,
}: {
  call: RingingCall;
  onAccept: () => void;
  onDecline: () => void;
}) {
  const player = useRef<RingtonePlayer | null>(null);

  useEffect(() => {
    const p = new RingtonePlayer();
    player.current = p;
    p.start();
    const timeout = setTimeout(onDecline, RING_TIMEOUT_MS);
    // Best-effort desktop notification when the tab is hidden.
    maybeNotify(call);
    return () => {
      clearTimeout(timeout);
      p.stop();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [call.roomId]);

  return (
    <div style={bannerStyle} role="dialog" aria-label="Incoming call">
      <div style={avatarStyle}>
        {call.avatarUrl ? (
          <img src={call.avatarUrl} alt="" style={{ width: "100%", height: "100%", borderRadius: "50%", objectFit: "cover" }} />
        ) : (
          <span style={{ fontSize: 22 }}>{initials(call.roomName)}</span>
        )}
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={nameStyle}>{call.roomName}</div>
        <div style={{ fontSize: 13, color: "var(--text-secondary)" }}>Incoming call…</div>
      </div>
      <button style={declineBtn} onClick={onDecline} aria-label="Decline">
        <Icon name="x" size={18} />
      </button>
      <button style={acceptBtn} onClick={onAccept} aria-label="Accept">
        <Icon name="check" size={18} />
      </button>
    </div>
  );
}

function maybeNotify(call: RingingCall): void {
  try {
    if (document.visibilityState === "visible") return;
    if (!("Notification" in window)) return;
    if (Notification.permission === "granted") {
      new Notification("Incoming call", { body: call.roomName });
    }
  } catch {
    /* notifications unavailable */
  }
}

function initials(name: string): string {
  return name.trim().slice(0, 1).toUpperCase() || "?";
}

const bannerStyle: React.CSSProperties = {
  position: "fixed",
  top: 20,
  left: "50%",
  transform: "translateX(-50%)",
  display: "flex",
  alignItems: "center",
  gap: 12,
  padding: "12px 16px",
  width: "min(420px, 92vw)",
  background: "var(--bg-elevated)",
  borderRadius: "var(--radius-lg)",
  boxShadow: "var(--shadow-sheet)",
  border: "1px solid var(--separator)",
  zIndex: 1100,
};

const avatarStyle: React.CSSProperties = {
  width: 44,
  height: 44,
  borderRadius: "50%",
  background: "var(--bg-input)",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  flexShrink: 0,
  overflow: "hidden",
};

const nameStyle: React.CSSProperties = {
  fontWeight: 600,
  color: "var(--text-primary)",
  whiteSpace: "nowrap",
  overflow: "hidden",
  textOverflow: "ellipsis",
};

const roundBtn: React.CSSProperties = {
  width: 44,
  height: 44,
  borderRadius: "50%",
  border: "none",
  fontSize: 18,
  fontWeight: 700,
  color: "#fff",
  cursor: "pointer",
  flexShrink: 0,
};

const declineBtn: React.CSSProperties = { ...roundBtn, background: "#ef4444" };
const acceptBtn: React.CSSProperties = { ...roundBtn, background: "#22c55e" };
