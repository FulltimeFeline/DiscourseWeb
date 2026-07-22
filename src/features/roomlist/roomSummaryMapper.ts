// FFI Room / RoomInfo / EventTimelineItem to the value-type `RoomSummary`.
//
// The only place in the room-list feature that reaches into the raw SDK enum
// shapes, so the diff/render code downstream only ever touches plain immutable
// objects.
//
// Quirks of this SDK build (verified against matrix_sdk_ffi.ts):
//   - `Room.latestEvent()` returns `EventTimelineItem | undefined`, not a
//     `LatestEventValue` enum. Preview data comes off that item directly.
//   - `RoomInfo` has no `isDm`, `isLowPriority`, or `isVideoRoom` fields. We use
//     `isDirect`; low-priority/video-room are derived elsewhere or defaulted.
//   - unread counts are `bigint`.

import {
  EncryptionState,
  RoomNotificationMode,
  Membership as FfiMembership,
  MsgLikeKind_Tags,
  TimelineItemContent_Tags,
  ProfileDetails_Tags,
  type RoomInfo,
  type RoomInterface,
  type EventTimelineItem,
  type RoomHero as FfiRoomHero,
} from "@/matrix";
import type {
  Membership,
  RoomHero,
  RoomPreview,
  RoomSummary,
} from "@/models/types";

// ---------------------------------------------------------------------------
// Name folding (case- and diacritic-insensitive).
// ---------------------------------------------------------------------------

export function foldName(name: string): string {
  return name
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase();
}

// ---------------------------------------------------------------------------
// Video-room detection. The room-list RoomInfo has no room-type field, so we
// can only surface video rooms cross-referenced from the space hierarchy (see
// SpacesViewModel). Kept here so the flag has a single owner on the summary.
// ---------------------------------------------------------------------------

const VIDEO_ROOM_TYPES = new Set(["io.element.video", "org.matrix.msc3417.call"]);
export function isVideoRoomType(customType: string | undefined): boolean {
  return !!customType && VIDEO_ROOM_TYPES.has(customType);
}

// ---------------------------------------------------------------------------

function mapMembership(m: FfiMembership): Membership {
  switch (m) {
    case FfiMembership.Invited:
      return "invited";
    case FfiMembership.Joined:
      return "joined";
    case FfiMembership.Left:
      return "left";
    case FfiMembership.Knocked:
      return "knocked";
    case FfiMembership.Banned:
      return "banned";
    default:
      return "joined";
  }
}

function mapHero(h: FfiRoomHero): RoomHero {
  return { userId: h.userId, displayName: h.displayName, avatarUrl: h.avatarUrl };
}

/** A placeholder summary for a room whose details haven't loaded yet. */
export function placeholderSummary(id: string, fallbackName?: string): RoomSummary {
  const name = fallbackName ?? "";
  return {
    id,
    name,
    foldedName: foldName(name),
    avatarUrl: undefined,
    topic: undefined,
    isDirect: false,
    isSpace: false,
    isEncrypted: false,
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
    preview: undefined,
    lastActivityTs: undefined,
    hasActiveCall: false,
    activeCallParticipants: [],
    inviter: undefined,
  };
}

/** Fold RoomInfo into an existing summary, preserving preview/activity. */
export function applyRoomInfo(prev: RoomSummary, info: RoomInfo): RoomSummary {
  const name = info.displayName ?? prev.name ?? "";
  const isMuted =
    info.cachedUserDefinedNotificationMode === RoomNotificationMode.Mute;
  const inviter = info.inviter
    ? { userId: info.inviter.userId, displayName: info.inviter.displayName, avatarUrl: info.inviter.avatarUrl }
    : prev.inviter;

  return {
    ...prev,
    name,
    foldedName: foldName(name),
    avatarUrl: info.avatarUrl ?? undefined,
    topic: info.topic ?? undefined,
    isDirect: info.isDirect,
    isSpace: info.isSpace,
    isEncrypted: info.encryptionState === EncryptionState.Encrypted,
    isFavourite: info.isFavourite,
    membership: mapMembership(info.membership),
    heroes: info.heroes.map(mapHero),
    unreadMessages: Number(info.numUnreadMessages),
    unreadNotifications: Number(info.numUnreadNotifications),
    unreadMentions: Number(info.numUnreadMentions),
    isMarkedUnread: info.isMarkedUnread,
    isMuted,
    hasActiveCall: info.hasRoomCall,
    activeCallParticipants: info.activeRoomCallParticipants,
    inviter,
  };
}

/** Fold the latest event into an existing summary (preview + activity ts). */
export function applyLatestEvent(
  prev: RoomSummary,
  item: EventTimelineItem | undefined,
): RoomSummary {
  if (!item) return prev;
  const preview = buildPreview(item);
  if (!preview) return prev;
  return { ...prev, preview, lastActivityTs: preview.ts };
}

// ---------------------------------------------------------------------------
// Preview text extraction from a timeline item.
// ---------------------------------------------------------------------------

function senderName(item: EventTimelineItem): string | undefined {
  const p = item.senderProfile;
  if (p && p.tag === ProfileDetails_Tags.Ready) {
    return p.inner.displayName ?? undefined;
  }
  return undefined;
}

/** Build the one-line preview from an EventTimelineItem, or undefined to skip. */
function buildPreview(item: EventTimelineItem): RoomPreview | undefined {
  const ts = Number(item.timestamp);
  const content = item.content;

  // Only message-like events produce a sidebar preview; state / membership /
  // profile changes are skipped so the preview doesn't churn on joins etc.
  if (content.tag !== TimelineItemContent_Tags.MsgLike) return undefined;

  const msgLike = content.inner.content;
  const isReply = !!msgLike.inReplyTo;
  const body = previewBody(msgLike.kind);
  if (body === undefined) return undefined;

  return {
    senderId: item.sender,
    senderName: senderName(item),
    isOwn: item.isOwn,
    body,
    isReply,
    ts,
  };
}

function previewBody(kind: unknown): string | undefined {
  const k = kind as { tag: MsgLikeKind_Tags; inner?: any };
  switch (k.tag) {
    case MsgLikeKind_Tags.Message: {
      const body = k.inner?.content?.body;
      return typeof body === "string" && body.length ? body : "Message";
    }
    case MsgLikeKind_Tags.Sticker:
      return k.inner?.body || "Sticker";
    case MsgLikeKind_Tags.Poll:
      return k.inner?.question ? `Poll: ${k.inner.question}` : "Poll";
    case MsgLikeKind_Tags.Redacted:
      return "Message deleted";
    case MsgLikeKind_Tags.UnableToDecrypt:
      return "Encrypted message";
    default:
      return undefined;
  }
}

// ---------------------------------------------------------------------------
// Unread semantics.
// ---------------------------------------------------------------------------

export function hasUnread(r: RoomSummary): boolean {
  if (r.isMuted) return r.unreadMentions > 0;
  return r.unreadNotifications > 0 || r.unreadMentions > 0 || r.isMarkedUnread;
}

export function hasAnyUnread(r: RoomSummary): boolean {
  return hasUnread(r) || (!r.isMuted && r.unreadMessages > 0);
}

export function isMentioned(r: RoomSummary): boolean {
  return r.unreadMentions > 0;
}

export function badgeCount(r: RoomSummary): number {
  return r.isMuted ? r.unreadMentions : r.unreadNotifications;
}

/** Zero the unread counters locally (active-room + mark-as-read paths). */
export function clearedUnread(r: RoomSummary): RoomSummary {
  if (
    r.unreadMessages === 0 &&
    r.unreadNotifications === 0 &&
    r.unreadMentions === 0 &&
    !r.isMarkedUnread
  ) {
    return r;
  }
  return {
    ...r,
    unreadMessages: 0,
    unreadNotifications: 0,
    unreadMentions: 0,
    isMarkedUnread: false,
  };
}

export type { RoomInterface };
