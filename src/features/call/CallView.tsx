// The Element Call embed.
//
// Renders the EC widget URL in an <iframe> with media granted via `allow`.
// WebRTC, mute, camera, screenshare, tile layout and the participant strip are
// all EC's own in-iframe UI; our chrome is just a title bar and a leave button.

import { useEffect, useMemo, useRef, useState } from "react";
import { useSession } from "@/app/context";
import { useViewModel } from "@/core/reactive";
import { CallViewModel, DEFAULT_EC_BASE_URL } from "./CallViewModel";

const ALLOW =
  "camera; microphone; display-capture; autoplay; clipboard-write; fullscreen";

export function CallView({
  roomId,
  roomName,
  joinExisting,
  ecBaseUrl = DEFAULT_EC_BASE_URL,
  confirmOnLeave = false,
  onClose,
}: {
  roomId: string;
  roomName?: string;
  /** From RoomInfo.hasRoomCall: join in progress vs. start a new call. */
  joinExisting: boolean;
  ecBaseUrl?: string;
  /** Ask before leaving (mobile/touch). */
  confirmOnLeave?: boolean;
  onClose: () => void;
}) {
  const session = useSession();
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [closing, setClosing] = useState(false);

  const vm = useMemo(() => {
    const room = session.getRoom(roomId);
    return new CallViewModel(
      session,
      // A dummy room is never used: start() bails to "error" when room is absent.
      room as never,
      session.userId,
      joinExisting,
      ecBaseUrl,
      () => onClose(), // EC reported hangup/close
      !room,
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session, roomId]);

  const state = useViewModel(vm);

  useEffect(() => {
    const iframe = iframeRef.current;
    if (iframe) vm.attachIframe(iframe);
    void vm.start();
    return () => {
      vm.stop();
      vm.dispose();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [vm]);

  // Re-attach the iframe once its element mounts (url state renders the iframe).
  useEffect(() => {
    if (vm && iframeRef.current) vm.attachIframe(iframeRef.current);
  }, [vm, state.url]);

  const leave = () => {
    if (confirmOnLeave && !closing) {
      setClosing(true);
      return;
    }
    onClose();
  };

  return (
    <div style={containerStyle}>
      <div style={headerStyle}>
        <span style={{ fontWeight: 600, color: "var(--text-primary)" }}>
          Call{roomName ? ` — ${roomName}` : ""}
        </span>
        <button style={leaveBtn} onClick={leave} aria-label="Leave call">
          Leave
        </button>
      </div>

      <div style={{ flex: 1, position: "relative", background: "#000" }}>
        {state.status === "error" && (
          <Centered>
            <p style={{ color: "var(--text-secondary)" }}>
              Couldn't start the call.
              {"error" in state && state.error ? ` ${state.error}` : ""}
            </p>
            <button style={leaveBtn} onClick={onClose}>
              Close
            </button>
          </Centered>
        )}

        {state.status === "loading" && (
          <Centered>
            <p style={{ color: "var(--text-secondary)" }}>Connecting…</p>
          </Centered>
        )}

        {state.url && (
          <iframe
            ref={iframeRef}
            src={state.url}
            allow={ALLOW}
            allowFullScreen
            title="Element Call"
            style={{ border: "none", width: "100%", height: "100%" }}
          />
        )}
      </div>

      {closing && (
        <div style={confirmScrim} onClick={() => setClosing(false)}>
          <div style={confirmBox} onClick={(e) => e.stopPropagation()}>
            <p style={{ color: "var(--text-primary)", margin: "0 0 12px" }}>Leave the call?</p>
            <div style={{ display: "flex", gap: 8 }}>
              <button style={{ ...leaveBtn, flex: 1 }} onClick={() => setClosing(false)}>
                Stay
              </button>
              <button
                style={{ ...leaveBtn, flex: 1, background: "#ef4444", color: "#fff" }}
                onClick={onClose}
              >
                Leave
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function Centered({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        position: "absolute",
        inset: 0,
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: 12,
      }}
    >
      {children}
    </div>
  );
}

const containerStyle: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  width: "100%",
  height: "100%",
  background: "var(--bg-app)",
};

const headerStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  padding: "10px 16px",
  borderBottom: "1px solid var(--separator)",
};

const leaveBtn: React.CSSProperties = {
  padding: "8px 14px",
  borderRadius: "var(--radius-md)",
  border: "none",
  background: "var(--bg-input)",
  color: "var(--text-primary)",
  fontWeight: 600,
  cursor: "pointer",
};

const confirmScrim: React.CSSProperties = {
  position: "absolute",
  inset: 0,
  background: "var(--scrim)",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
};

const confirmBox: React.CSSProperties = {
  background: "var(--bg-elevated)",
  borderRadius: "var(--radius-lg)",
  padding: 20,
  width: "min(320px, 88vw)",
  boxShadow: "var(--shadow-sheet)",
};
