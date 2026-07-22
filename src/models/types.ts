// The value-type layer. The SDK's FFI objects aren't plain/serializable and
// calling them is comparatively expensive, so they're mapped into immutable
// plain objects once, up front, and the UI only ever reads these. This keeps SDK
// calls off React's render path and makes diffing cheap.
//
// These are the shared contract: mappers (FFI to these) live beside them and are
// implemented per feature, but the shapes here are fixed so room list, timeline,
// composer, etc. all agree.

// ---------------------------------------------------------------------------
// Room list
// ---------------------------------------------------------------------------

export type Membership = "joined" | "invited" | "left" | "knocked" | "banned";

export interface RoomSummary {
  id: string;
  name: string;
  /** Lower-cased, accent-folded name for fast client-side filtering. */
  foldedName: string;
  avatarUrl?: string;
  topic?: string;
  isDirect: boolean;
  isSpace: boolean;
  isEncrypted: boolean;
  isFavourite: boolean;
  isLowPriority: boolean;
  isVideoRoom: boolean;
  membership: Membership;
  /** Users other than us in a DM/small room, for avatars and name fallback. */
  heroes: RoomHero[];

  // Unread state
  unreadMessages: number;
  unreadNotifications: number;
  unreadMentions: number;
  isMarkedUnread: boolean;
  isMuted: boolean;

  // Preview (from the room-list timeline limit of 1)
  preview?: RoomPreview;
  lastActivityTs?: number;

  // Calls
  hasActiveCall: boolean;
  activeCallParticipants: string[];

  /** Invite sender, when membership === "invited". */
  inviter?: RoomHero;
}

export interface RoomHero {
  userId: string;
  displayName?: string;
  avatarUrl?: string;
}

export interface RoomPreview {
  senderId: string;
  senderName?: string;
  isOwn: boolean;
  /** Rendered one-line body ("You: hi", "Alice: ↩ ok", "photo", …). */
  body: string;
  isReply: boolean;
  ts: number;
}

export interface SpaceSummary {
  id: string;
  name: string;
  avatarUrl?: string;
  unreadNotifications: number;
  unreadMentions: number;
}

// ---------------------------------------------------------------------------
// Timeline
// ---------------------------------------------------------------------------

/** A timeline row: either a real event or a virtual marker (day divider…). */
export type TimelineEntry = EventEntry | VirtualEntry;

export interface VirtualEntry {
  kind: "virtual";
  /** Stable per-instance id from the SDK's TimelineItem uniqueId. */
  id: string;
  virtual: VirtualKind;
}

export type VirtualKind =
  | { type: "dateDivider"; ts: number }
  | { type: "readMarker" }
  | { type: "timelineStart" };

export interface EventEntry {
  kind: "event";
  id: string;
  /** eventId when remote, else the local transaction id. */
  eventId?: string;
  transactionId?: string;
  sender: string;
  senderProfile: SenderProfile;
  isOwn: boolean;
  timestamp: number;
  content: EventContent;
  reactions: ReactionGroup[];
  /** Reply parent, lazily filled via fetchDetailsForEvent. */
  inReplyTo?: ReplyPreview;
  threadSummary?: { count: number; latestId?: string };
  isEdited: boolean;
  canBeRepliedTo: boolean;
  /** Read-receipt avatars to show on this row (corrected positions). */
  readReceipts: string[];
  /** Local send lifecycle for own, not-yet-confirmed messages. */
  sendState?: SendState;
  /** Encryption shield, computed lazily on row appearance. */
  shield?: Shield;
}

export interface SenderProfile {
  userId: string;
  displayName?: string;
  avatarUrl?: string;
  /** Cinny power-level role tag, if any. */
  roleTag?: { label: string; icon?: string };
}

export type SendState =
  | { type: "sending" }
  | { type: "sent" }
  | { type: "failed"; error: string };

export type Shield = { color: "red" | "grey"; message: string };

export interface ReactionGroup {
  /** Unicode glyph, arbitrary text, or an mxc:// URL (custom emote). */
  key: string;
  senders: string[];
  includesOwn: boolean;
}

export interface ReplyPreview {
  eventId: string;
  status: "ready" | "pending" | "unavailable" | "error";
  senderId?: string;
  senderName?: string;
  body?: string;
}

/** The rendered content of an event row. */
export type EventContent =
  | TextContent
  | ImageContent
  | VideoContent
  | AudioContent
  | FileContent
  | StickerContent
  | PollContent
  | LocationContent
  | MembershipContent
  | StateContent
  | RedactedContent
  | EncryptedContent
  | CallContent
  | UnsupportedContent;

export interface TextContent {
  type: "text";
  /** notice/emote/text; affects styling/prefix. */
  msgtype: "text" | "notice" | "emote";
  body: string;
  /** Sanitised HTML when the event carried org.matrix.custom.html. */
  html?: string;
}

export interface MediaBase {
  body: string;
  /** A genuine caption (present only when the sender added text distinct from the filename). */
  caption?: string;
  source: MediaRef;
  mimetype?: string;
  size?: number;
  width?: number;
  height?: number;
  blurhash?: string;
  thumbnail?: MediaRef;
}

export interface ImageContent extends MediaBase {
  type: "image";
  isAnimated?: boolean;
}
export interface VideoContent extends MediaBase {
  type: "video";
  duration?: number;
}
export interface AudioContent {
  type: "audio";
  body: string;
  source: MediaRef;
  mimetype?: string;
  size?: number;
  duration?: number;
  /** Present for voice messages. */
  waveform?: number[];
  isVoice: boolean;
}
export interface FileContent {
  type: "file";
  body: string;
  source: MediaRef;
  mimetype?: string;
  size?: number;
}
export interface StickerContent {
  type: "sticker";
  body: string;
  source: MediaRef;
  mimetype?: string;
  width?: number;
  height?: number;
}
export interface PollContent {
  type: "poll";
  question: string;
  kind: "disclosed" | "undisclosed";
  maxSelections: number;
  answers: { id: string; text: string }[];
  votes: Record<string, string[]>; // answerId → voter userIds
  endTs?: number;
  startEventId: string;
}
export interface LocationContent {
  type: "location";
  body: string;
  geoUri: string;
}
export interface MembershipContent {
  type: "membership";
  /** Human-readable change ("Alice joined", "Bob was invited by Carol"). */
  summary: string;
}
export interface StateContent {
  type: "state";
  summary: string;
}
export interface RedactedContent {
  type: "redacted";
}
export interface EncryptedContent {
  type: "encrypted";
  /** "waiting to decrypt" vs a permanent UTD. */
  reason: string;
}
export interface CallContent {
  type: "call";
  summary: string;
}
export interface UnsupportedContent {
  type: "unsupported";
  body: string;
}

/**
 * An opaque reference to media. Holds the mxc URL for cache keys and the boxed
 * FFI MediaSource needed to actually download (encrypted media needs the source
 * object, not just the URL). The MediaLoader resolves these to object URLs.
 */
export interface MediaRef {
  mxc: string;
  /** The FFI MediaSource, retained for encrypted downloads. */
  source: unknown;
}
