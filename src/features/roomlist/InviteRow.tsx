// An invite row. Account-level invites appear in every space and Home.
// Accept/decline action badges, a "Space" capsule if the invite is to a space,
// and an inviter-name subtitle.

import { useState } from "react";
import type { RoomSummary } from "@/models/types";
import { RoomAvatar } from "./RoomAvatar";
import { Icon } from "@/ui/Icon";
import "./roomlist.css";

function inviterLine(room: RoomSummary): string {
  const name = room.inviter?.displayName ?? room.inviter?.userId;
  return name ? `${name} invited you` : "You've been invited";
}

export function InviteRow({
  room,
  onAccept,
  onDecline,
}: {
  room: RoomSummary;
  onAccept: () => Promise<void> | void;
  onDecline: () => void;
}) {
  const [busy, setBusy] = useState(false);

  return (
    <div className="rl-invite">
      <RoomAvatar name={room.name} avatarUrl={room.avatarUrl} size={28} />
      <div className="rl-invite__body">
        <div className="rl-invite__top">
          <span className="rl-invite__name">{room.name || "Invitation"}</span>
          {room.isSpace && <span className="rl-invite__badge">Space</span>}
        </div>
        <div className="rl-invite__sub">{inviterLine(room)}</div>
      </div>
      <div className="rl-invite__actions">
        <button
          type="button"
          className="rl-invite__decline"
          disabled={busy}
          title="Decline"
          aria-label="Decline invite"
          onClick={onDecline}
        >
          <Icon name="x" size={16} />
        </button>
        <button
          type="button"
          className="rl-invite__accept"
          disabled={busy}
          title="Accept"
          aria-label="Accept invite"
          onClick={async () => {
            setBusy(true);
            try {
              await onAccept();
            } finally {
              setBusy(false);
            }
          }}
        >
          {busy ? "…" : <Icon name="check" size={16} />}
        </button>
      </div>
    </div>
  );
}
