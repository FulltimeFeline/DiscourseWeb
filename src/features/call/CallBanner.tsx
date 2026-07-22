// Shown by the RoomPane when a room has an active MatrixRTC call
// (RoomInfo.hasRoomCall): a "join call" button plus the active-participant count
// (RoomInfo.activeRoomCallParticipants). Group calls surface here rather than
// ringing.

import { Icon } from "@/ui/Icon";

export function CallBanner({
  participantCount,
  onJoin,
}: {
  participantCount?: number;
  onJoin: () => void;
}) {
  return (
    <div style={bannerStyle}>
      <span style={{ display: "inline-flex", fontSize: 16 }}><Icon name="phone" /></span>
      <span style={{ flex: 1, color: "var(--text-primary)", fontWeight: 500 }}>
        {participantCount && participantCount > 0
          ? `Ongoing call · ${participantCount} in call`
          : "Ongoing call"}
      </span>
      <button style={joinBtn} onClick={onJoin}>
        Join
      </button>
    </div>
  );
}

const bannerStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 10,
  padding: "10px 16px",
  background: "var(--bg-elevated)",
  borderBottom: "1px solid var(--separator)",
};

const joinBtn: React.CSSProperties = {
  padding: "6px 16px",
  borderRadius: "var(--radius-pill)",
  border: "none",
  background: "#22c55e",
  color: "#fff",
  fontWeight: 600,
  cursor: "pointer",
};
