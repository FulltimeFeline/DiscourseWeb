// An unjoined space-child row ("More Rooms"): avatar + name (video glyph if a
// video room) + topic/"N members" subtitle + a Join button that spins while the
// join is in flight.

import { useState } from "react";
import { Icon } from "@/ui/Icon";
import type { SpaceChild } from "./SpacesViewModel";
import { RoomAvatar } from "./RoomAvatar";
import "./roomlist.css";

export function SpaceDirectoryRow({
  child,
  onJoin,
  onRemove,
}: {
  child: SpaceChild;
  onJoin: () => Promise<void> | void;
  /** Present only for space admins: unfile this room from the space. */
  onRemove?: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const subtitle =
    child.topic?.trim() ||
    `${child.memberCount} member${child.memberCount === 1 ? "" : "s"}`;

  return (
    <div className="rl-dir">
      <RoomAvatar name={child.name} avatarUrl={child.avatarUrl} size={28} />
      <div className="rl-dir__body">
        <div className="rl-dir__top">
          <span className="rl-dir__name">{child.name || "Room"}</span>
          {child.isVideoRoom && (
            <span className="rl-glyph" title="Video room" aria-hidden>
              <Icon name="video" size={13} />
            </span>
          )}
        </div>
        <div className="rl-dir__sub">{subtitle}</div>
      </div>
      <button
        type="button"
        className="rl-dir__join"
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          try {
            await onJoin();
          } finally {
            setBusy(false);
          }
        }}
      >
        {busy ? "…" : "Join"}
      </button>
      {onRemove && (
        <button
          type="button"
          className="rl-dir__remove"
          title="Remove from space"
          aria-label="Remove from space"
          onClick={(e) => {
            e.stopPropagation();
            onRemove();
          }}
        >
          <Icon name="x" size={14} />
        </button>
      )}
    </div>
  );
}
