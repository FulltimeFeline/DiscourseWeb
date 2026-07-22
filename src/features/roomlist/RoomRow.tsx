// A single room row.
//
// Avatar (cache-first) + bold-when-unread name + video/lock glyphs + relative
// timestamp + "You:/Sender:" preview (↩ for replies) + red-vs-accent unread
// capsule + active-call participant strip. All derived flags come from the
// value-type RoomSummary via the mapper helpers so they match the rail exactly.

import type { RoomSummary } from "@/models/types";
import {
  badgeCount,
  hasAnyUnread,
  hasUnread,
  isMentioned,
} from "./roomSummaryMapper";
import { RoomAvatar } from "./RoomAvatar";
import { Icon } from "@/ui/Icon";
import { useSession } from "@/app/context";
import { usePresence } from "@/core/PresenceService";
import "./roomlist.css";

function formatTimestamp(ts: number | undefined): string {
  if (!ts) return "";
  const d = new Date(ts);
  const now = new Date();
  const sameDay =
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate();
  if (sameDay) {
    return d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  }
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function previewLine(room: RoomSummary): string {
  const p = room.preview;
  if (!p) return "";
  const arrow = p.isReply ? "↩ " : "";
  if (p.isOwn) return `You: ${arrow}${p.body}`;
  if (p.senderName) return `${p.senderName}: ${arrow}${p.body}`;
  return `${arrow}${p.body}`;
}

function a11yValue(room: RoomSummary): string {
  if (isMentioned(room)) return `${room.unreadMentions} mentions`;
  const n = badgeCount(room);
  if (hasUnread(room)) return `${n} unread`;
  if (hasAnyUnread(room)) return "Unread";
  return "";
}

export function RoomRow({
  room,
  selected,
  presenceDot,
  onSelect,
  onContextMenu,
  onHover,
}: {
  room: RoomSummary;
  selected: boolean;
  presenceDot?: "online" | "unavailable" | "offline";
  onSelect: () => void;
  onContextMenu?: (e: React.MouseEvent) => void;
  onHover?: () => void;
}) {
  const unread = hasUnread(room) || selected;
  const count = badgeCount(room);
  const showCapsule = hasUnread(room) && count > 0;
  const mention = isMentioned(room);
  const dmUserId = room.isDirect ? room.heroes[0]?.userId : undefined;
  const value = a11yValue(room);
  // Live presence dot for DMs (falls back to any prop passed by the parent).
  const session = useSession();
  const presence = usePresence(session, dmUserId);
  const dot = presence?.state ?? presenceDot;

  return (
    <button
      type="button"
      className={`rl-row${selected ? " rl-row--selected" : ""}`}
      onClick={onSelect}
      onMouseEnter={onHover}
      onContextMenu={onContextMenu}
      role="option"
      aria-selected={selected}
      aria-label={`${room.name}${value ? `, ${value}` : ""}`}
    >
      <div className="rl-row__avatar">
        <RoomAvatar name={room.name} avatarUrl={room.avatarUrl} size={28} />
        {dmUserId && dot && (
          <span className={`rl-presence rl-presence--${dot}`} aria-hidden />
        )}
      </div>

      <div className="rl-row__body">
        <div className="rl-row__top">
          <span className={`rl-row__name${unread ? " rl-row__name--unread" : ""}`}>
            {room.name || "Unnamed"}
          </span>
          {room.isVideoRoom && (
            <span
              className={`rl-glyph${room.hasActiveCall ? " rl-glyph--call" : ""}`}
              title={room.hasActiveCall ? "Video room — call in progress" : "Video room"}
              aria-hidden
            >
              <Icon name="video" size={13} />
            </span>
          )}
          {room.isEncrypted && (
            <span className="rl-glyph" title="End-to-end encrypted" aria-hidden>
              <Icon name="lock" />
            </span>
          )}
          <span className="rl-row__time" aria-hidden>
            {formatTimestamp(room.lastActivityTs)}
          </span>
        </div>

        {room.hasActiveCall && room.activeCallParticipants.length > 0 && (
          <CallStrip participants={room.activeCallParticipants} />
        )}

        <div className="rl-row__bottom">
          <span
            className={`rl-row__preview${unread ? " rl-row__preview--unread" : ""}`}
          >
            {previewLine(room)}
          </span>
          {showCapsule && (
            <span
              className={`rl-badge${mention ? " rl-badge--mention" : ""}`}
              aria-hidden
            >
              {count}
            </span>
          )}
        </div>
      </div>
    </button>
  );
}

// Overlapping avatars of who's currently in a room's call: size-18 avatars,
// -6px overlap, a background-colored ring, and a "+N" overflow. We only have
// each participant's userId here, so RoomAvatar renders gradient initials
// (name=userId) when no avatar URL is resolvable.
function CallStrip({ participants }: { participants: string[] }) {
  const shown = participants.slice(0, 5);
  const extra = participants.length - shown.length;
  return (
    <div className="rl-callstrip" aria-hidden>
      {shown.map((id, i) => (
        <span
          key={id}
          className="rl-callstrip__avatar"
          title={id}
          style={{ marginLeft: i === 0 ? 0 : -6 }}
        >
          <RoomAvatar name={id} size={18} />
        </span>
      ))}
      {extra > 0 && <span className="rl-callstrip__more">+{extra}</span>}
    </div>
  );
}
