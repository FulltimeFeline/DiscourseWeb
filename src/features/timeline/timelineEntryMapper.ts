// FFI TimelineItem to value-type TimelineEntry mapping. Runs once per item on
// the diff-apply path (off the React render path) and never drops an item: every
// SDK item becomes exactly one entry so positional diffs stay index-aligned.
// Shields, reply details, blurhash and thumbnails are deferred (lazy, per-row)
// and are not touched here.
//
// The generated bindings model enums as tagged unions: `{ tag, inner }` where
// `tag` is a `<Enum>_Tags` string. Records are plain objects. These shapes are
// read directly, verified against matrix_sdk_ffi.ts.

import {
  DateDividerMode,
  EncryptionState,
  EventOrTransactionId_Tags,
  EmbeddedEventDetails_Tags,
  MembershipChange,
  MessageType_Tags,
  ShieldState_Tags,
  ShieldStateCode,
  MsgLikeKind_Tags,
  PollKind,
  ProfileDetails_Tags,
  TimelineItemContent_Tags,
  VirtualTimelineItem_Tags,
  type EventTimelineItem,
  type FormattedBody,
  type InReplyToDetailsInterface,
  type MsgLikeContent,
  type ProfileDetails,
  type Reaction,
  type TimelineItemContent,
  type TimelineItemInterface,
  type UnstableAudioDetailsContent,
} from "@/matrix";
import { sanitizeHtml } from "./sanitize";
import type {
  AudioContent,
  EventContent,
  EventEntry,
  MediaRef,
  ReactionGroup,
  ReplyPreview,
  SenderProfile,
  SendState,
  Shield,
  TimelineEntry,
  VirtualEntry,
} from "@/models/types";

export interface MapContext {
  ownUserId: string;
  /** Live own display name; own messages show it before sync echoes it back. */
  ownDisplayName?: string;
  ownAvatarUrl?: string;
}

// A UniffiDuration is `{ secs: bigint; nanos: number }`; some info fields carry
// a plain number of ms. Normalise to seconds defensively.
function durationSeconds(d: unknown): number | undefined {
  if (d == null) return undefined;
  if (typeof d === "number") return d;
  if (typeof d === "bigint") return Number(d);
  const o = d as { secs?: bigint | number; nanos?: number };
  if (o.secs != null) return Number(o.secs) + (o.nanos ? o.nanos / 1e9 : 0);
  return undefined;
}

function num(v: bigint | number | undefined): number | undefined {
  return v == null ? undefined : Number(v);
}

/** Wrap the FFI MediaSource so MediaLoader can download (encrypted or not). */
function mediaRef(source: unknown, mxc: string): MediaRef {
  return { mxc, source };
}

function mxcFrom(source: { url?: () => string } | unknown): string {
  try {
    const s = source as { url?: () => string };
    return typeof s?.url === "function" ? s.url() : "";
  } catch {
    return "";
  }
}

function htmlFrom(formatted: FormattedBody | undefined): string | undefined {
  if (!formatted) return undefined;
  // MessageFormat.Html tag is "Html"; anything else is not HTML we render.
  const fmt = formatted.format as unknown as { tag?: string };
  if (fmt?.tag !== "Html") return undefined;
  return sanitizeHtml(formatted.body);
}

/**
 * Strip the reply fallback (leading `> <@user> …` quoted lines plus the blank
 * separator) that the SDK bakes into reply bodies; the reply preview renders the
 * quote instead.
 */
export function stripReplyFallback(body: string): string {
  if (!body.startsWith(">")) return body;
  const lines = body.split("\n");
  let i = 0;
  while (i < lines.length && lines[i].startsWith(">")) i++;
  // Skip the single blank separator line the fallback leaves behind.
  if (i < lines.length && lines[i].trim() === "") i++;
  return lines.slice(i).join("\n");
}

function profile(details: ProfileDetails, sender: string, ctx: MapContext, isOwn: boolean): SenderProfile {
  let displayName: string | undefined;
  let avatarUrl: string | undefined;
  if (details.tag === ProfileDetails_Tags.Ready) {
    displayName = details.inner.displayName ?? undefined;
    avatarUrl = details.inner.avatarUrl ?? undefined;
  }
  if (isOwn) {
    displayName = ctx.ownDisplayName ?? displayName;
    avatarUrl = ctx.ownAvatarUrl ?? avatarUrl;
  }
  return { userId: sender, displayName, avatarUrl };
}

function reactionGroups(reactions: Array<Reaction>, ownUserId: string): ReactionGroup[] {
  return reactions.map((r) => {
    const senders = r.senders.map((s) => s.senderId);
    return { key: r.key, senders, includesOwn: senders.includes(ownUserId) };
  });
}

function replyPreview(inReplyTo: InReplyToDetailsInterface | undefined): ReplyPreview | undefined {
  if (!inReplyTo) return undefined;
  let eventId = "";
  try {
    eventId = inReplyTo.eventId();
  } catch {
    /* ignore */
  }
  let details;
  try {
    details = inReplyTo.event();
  } catch {
    return { eventId, status: "pending" };
  }
  switch (details.tag) {
    case EmbeddedEventDetails_Tags.Ready: {
      const inner = details.inner;
      const sp = inner.senderProfile;
      const senderName =
        sp.tag === ProfileDetails_Tags.Ready ? sp.inner.displayName ?? undefined : undefined;
      return {
        eventId,
        status: "ready",
        senderId: inner.sender,
        senderName,
        body: previewBodyOf(inner.content),
      };
    }
    case EmbeddedEventDetails_Tags.Pending:
      return { eventId, status: "pending" };
    case EmbeddedEventDetails_Tags.Error:
      return { eventId, status: "error" };
    case EmbeddedEventDetails_Tags.Unavailable:
    default:
      return { eventId, status: "unavailable" };
  }
}

/** A short plain-text snippet of a replied-to event, for the reply preview. */
function previewBodyOf(content: TimelineItemContent): string | undefined {
  if (content.tag !== TimelineItemContent_Tags.MsgLike) return undefined;
  const kind = content.inner.content.kind;
  if (kind.tag === MsgLikeKind_Tags.Message) {
    return stripReplyFallback(kind.inner.content.body);
  }
  if (kind.tag === MsgLikeKind_Tags.Sticker) return kind.inner.body;
  if (kind.tag === MsgLikeKind_Tags.Redacted) return "Message deleted";
  return undefined;
}

// --- content mapping -------------------------------------------------------

function mapMsgLike(msgLike: MsgLikeContent): EventContent {
  const kind = msgLike.kind;
  switch (kind.tag) {
    case MsgLikeKind_Tags.Message: {
      const msg = kind.inner.content; // MessageContent { msgType, body, isEdited }
      return mapMessageType(msg.msgType, msg.body);
    }
    case MsgLikeKind_Tags.Sticker: {
      const { body, info, source } = kind.inner;
      return {
        type: "sticker",
        body,
        source: mediaRef(source, mxcFrom(source)),
        width: num(info?.width),
        height: num(info?.height),
      };
    }
    case MsgLikeKind_Tags.Poll: {
      const p = kind.inner;
      const votes: Record<string, string[]> = {};
      p.votes.forEach((voters, answerId) => {
        votes[answerId] = voters;
      });
      return {
        type: "poll",
        question: p.question,
        kind: p.kind === PollKind.Undisclosed ? "undisclosed" : "disclosed",
        maxSelections: Number(p.maxSelections),
        answers: p.answers.map((a) => ({ id: a.id, text: a.text })),
        votes,
        endTs: p.endTime != null ? Number(p.endTime) : undefined,
        startEventId: "", // filled by caller from eventId
      };
    }
    case MsgLikeKind_Tags.Redacted:
      return { type: "redacted" };
    case MsgLikeKind_Tags.UnableToDecrypt:
      return { type: "encrypted", reason: "Waiting for this message to decrypt…" };
    case MsgLikeKind_Tags.Other:
    default:
      return { type: "unsupported", body: "Unsupported message" };
  }
}

function mapMessageType(msgType: { tag: string; inner?: any }, rawBody: string): EventContent {
  switch (msgType.tag) {
    case MessageType_Tags.Text: {
      const c = msgType.inner.content; // TextMessageContent
      return { type: "text", msgtype: "text", body: stripReplyFallback(c.body), html: htmlFrom(c.formatted) };
    }
    case MessageType_Tags.Notice: {
      const c = msgType.inner.content;
      return { type: "text", msgtype: "notice", body: stripReplyFallback(c.body), html: htmlFrom(c.formatted) };
    }
    case MessageType_Tags.Emote: {
      const c = msgType.inner.content;
      return { type: "text", msgtype: "emote", body: stripReplyFallback(c.body), html: htmlFrom(c.formatted) };
    }
    case MessageType_Tags.Image: {
      const c = msgType.inner.content; // ImageMessageContent
      const info = c.info;
      return {
        type: "image",
        body: c.caption ?? c.filename ?? rawBody,
        caption: c.caption ?? undefined,
        source: mediaRef(c.source, mxcFrom(c.source)),
        mimetype: info?.mimetype ?? undefined,
        size: num(info?.size),
        width: num(info?.width),
        height: num(info?.height),
        blurhash: info?.blurhash ?? undefined,
        thumbnail: info?.thumbnailSource ? mediaRef(info.thumbnailSource, mxcFrom(info.thumbnailSource)) : undefined,
        isAnimated: info?.isAnimated ?? undefined,
      };
    }
    case MessageType_Tags.Video: {
      const c = msgType.inner.content;
      const info = c.info;
      return {
        type: "video",
        body: c.caption ?? c.filename ?? rawBody,
        caption: c.caption ?? undefined,
        source: mediaRef(c.source, mxcFrom(c.source)),
        mimetype: info?.mimetype ?? undefined,
        size: num(info?.size),
        width: num(info?.width),
        height: num(info?.height),
        blurhash: info?.blurhash ?? undefined,
        thumbnail: info?.thumbnailSource ? mediaRef(info.thumbnailSource, mxcFrom(info.thumbnailSource)) : undefined,
        duration: durationSeconds(info?.duration),
      };
    }
    case MessageType_Tags.Audio: {
      const c = msgType.inner.content; // AudioMessageContent
      const details: UnstableAudioDetailsContent | undefined = c.audio ?? undefined;
      const waveform = details?.waveform?.map((v) => v / 1024);
      const out: AudioContent = {
        type: "audio",
        body: c.caption ?? c.filename ?? rawBody,
        source: mediaRef(c.source, mxcFrom(c.source)),
        mimetype: c.info?.mimetype ?? undefined,
        size: num(c.info?.size),
        duration: durationSeconds(details?.duration ?? c.info?.duration),
        waveform,
        isVoice: c.voice != null,
      };
      return out;
    }
    case MessageType_Tags.File: {
      const c = msgType.inner.content;
      return {
        type: "file",
        body: c.caption ?? c.filename ?? rawBody,
        source: mediaRef(c.source, mxcFrom(c.source)),
        mimetype: c.info?.mimetype ?? undefined,
        size: num(c.info?.size),
      };
    }
    case MessageType_Tags.Location: {
      const c = msgType.inner.content; // LocationContent
      return { type: "location", body: c.body, geoUri: c.geoUri };
    }
    case MessageType_Tags.Other:
    default: {
      const body = msgType.inner?.body ?? rawBody ?? "Unsupported message";
      return { type: "unsupported", body };
    }
  }
}

function membershipSummary(
  userDisplayName: string | undefined,
  userId: string,
  change: MembershipChange | undefined,
): string {
  const who = userDisplayName || userId;
  switch (change) {
    case MembershipChange.Joined:
      return `${who} joined`;
    case MembershipChange.Left:
      return `${who} left`;
    case MembershipChange.Invited:
      return `${who} was invited`;
    case MembershipChange.InvitationAccepted:
      return `${who} accepted the invitation`;
    case MembershipChange.InvitationRejected:
    case MembershipChange.InvitationRevoked:
      return `${who} declined the invitation`;
    case MembershipChange.Banned:
    case MembershipChange.KickedAndBanned:
      return `${who} was banned`;
    case MembershipChange.Unbanned:
      return `${who} was unbanned`;
    case MembershipChange.Kicked:
      return `${who} was removed`;
    case MembershipChange.Knocked:
      return `${who} requested to join`;
    default:
      return `${who}'s membership changed`;
  }
}

/** Map a state/membership/call event to a system-row content, or null to hide. */
function mapNonMessage(content: TimelineItemContent): EventContent | null {
  switch (content.tag) {
    case TimelineItemContent_Tags.RoomMembership: {
      const c = content.inner;
      return { type: "membership", summary: membershipSummary(c.userDisplayName ?? undefined, c.userId, c.change ?? undefined) };
    }
    case TimelineItemContent_Tags.ProfileChange: {
      const c = content.inner as { displayName?: string; prevDisplayName?: string };
      if (c.displayName && c.prevDisplayName && c.displayName !== c.prevDisplayName) {
        return { type: "membership", summary: `${c.prevDisplayName} is now known as ${c.displayName}` };
      }
      return { type: "membership", summary: `${c.displayName ?? "Someone"} updated their profile` };
    }
    case TimelineItemContent_Tags.State:
      return { type: "state", summary: "Room settings changed" };
    case TimelineItemContent_Tags.CallInvite:
    case TimelineItemContent_Tags.RtcNotification:
      return { type: "call", summary: "Call started" };
    case TimelineItemContent_Tags.FailedToParseMessageLike:
    case TimelineItemContent_Tags.FailedToParseState:
    default:
      return null; // hidden, but still occupies an array slot
  }
}

function mapSendState(state: EventTimelineItem["localSendState"]): SendState | undefined {
  if (!state) return undefined;
  switch (state.tag) {
    case "NotSentYet":
      return { type: "sending" };
    case "Sent":
      return { type: "sent" };
    case "SendingFailed":
      return { type: "failed", error: (state.inner as { error?: { toString?: () => string } })?.error?.toString?.() ?? "Failed to send" };
    default:
      return undefined;
  }
}

/**
 * A hidden row (unknown virtual item or failed-to-parse event). It still
 * occupies an array slot so positional diffs stay aligned, but the view renders
 * nothing for it. The VirtualKind contract has no "hidden" case, so it's tagged
 * on a virtual entry with `isHiddenEntry` exposed for the view to filter on.
 */
const HIDDEN = Symbol("hidden");
type HiddenEntry = VirtualEntry & { [HIDDEN]: true };

function hiddenEntry(id: string): VirtualEntry {
  const e: HiddenEntry = {
    kind: "virtual",
    id,
    virtual: { type: "readMarker" },
    [HIDDEN]: true,
  };
  return e;
}

export function isHiddenEntry(entry: TimelineEntry): boolean {
  return entry.kind === "virtual" && (entry as unknown as Record<symbol, unknown>)[HIDDEN] === true;
}

/**
 * Map one SDK TimelineItem to a TimelineEntry. Never returns undefined: an
 * unrenderable item becomes a hidden virtual entry so the array stays aligned.
 */
export function mapTimelineItem(item: TimelineItemInterface, ctx: MapContext): TimelineEntry {
  const id = item.uniqueId().id;

  const virtual = item.asVirtual();
  if (virtual) {
    return mapVirtual(virtual, id);
  }

  const event = item.asEvent();
  if (!event) {
    return hiddenEntry(id);
  }

  // Non-message content becomes a "system"/state entry (still an EventEntry so
  // it carries sender/timestamp for grouping breaks and day alignment).
  const content = event.content;
  if (content.tag !== TimelineItemContent_Tags.MsgLike) {
    const mapped = mapNonMessage(content);
    if (!mapped) {
      // failedToParse → hidden
      return hiddenEntry(id);
    }
    return buildEventEntry(item, event, id, ctx, mapped, undefined, [], undefined, undefined, false);
  }

  const msgLike = content.inner.content;
  let mapped = mapMsgLike(msgLike);

  const eventId = eventIdOf(event);
  if (mapped.type === "poll" && eventId) mapped = { ...mapped, startEventId: eventId };

  const reactions = reactionGroups(msgLike.reactions, ctx.ownUserId);
  const reply = replyPreview(msgLike.inReplyTo ?? undefined);
  let threadSummary: EventEntry["threadSummary"];
  if (msgLike.threadSummary) {
    try {
      threadSummary = { count: Number(msgLike.threadSummary.numReplies()) };
    } catch {
      /* ignore */
    }
  }
  const isEdited =
    msgLike.kind.tag === MsgLikeKind_Tags.Message ? msgLike.kind.inner.content.isEdited : false;

  return buildEventEntry(item, event, id, ctx, mapped, reply, reactions, threadSummary, undefined, isEdited);
}

function buildEventEntry(
  item: TimelineItemInterface,
  event: EventTimelineItem,
  id: string,
  ctx: MapContext,
  content: EventContent,
  inReplyTo: ReplyPreview | undefined,
  reactions: ReactionGroup[],
  threadSummary: EventEntry["threadSummary"],
  _unused: undefined,
  isEdited: boolean,
): EventEntry {
  const eventId = eventIdOf(event);
  const transactionId = transactionIdOf(event);
  return {
    kind: "event",
    id,
    eventId,
    transactionId,
    sender: event.sender,
    senderProfile: profile(event.senderProfile, event.sender, ctx, event.isOwn),
    isOwn: event.isOwn,
    timestamp: Number(event.timestamp),
    content,
    reactions,
    inReplyTo,
    threadSummary,
    isEdited,
    canBeRepliedTo: event.canBeRepliedTo,
    readReceipts: readReceiptUsers(event, ctx.ownUserId),
    sendState: mapSendState(event.localSendState),
    // shield is filled lazily on row appearance by the view model
  };
}

function readReceiptUsers(event: EventTimelineItem, ownUserId: string): string[] {
  // The SDK's per-item receipts are unreliable for placement; the view model
  // overrides these with explicit-poll positions. Seed with the SDK map minus
  // own user as a best-effort fallback.
  const out: string[] = [];
  try {
    event.readReceipts.forEach((_receipt, userId) => {
      if (userId !== ownUserId) out.push(userId);
    });
  } catch {
    /* ignore */
  }
  return out.sort();
}

export function eventIdOf(event: EventTimelineItem): string | undefined {
  const id = event.eventOrTransactionId;
  return id.tag === EventOrTransactionId_Tags.EventId ? id.inner.eventId : undefined;
}

export function transactionIdOf(event: EventTimelineItem): string | undefined {
  const id = event.eventOrTransactionId;
  return id.tag === EventOrTransactionId_Tags.TransactionId ? id.inner.transactionId : undefined;
}

const SHIELD_TEXT: Partial<Record<ShieldStateCode, string>> = {
  [ShieldStateCode.SentInClear]: "Not encrypted",
  [ShieldStateCode.UnverifiedIdentity]: "Sent by an unverified user",
  [ShieldStateCode.UnsignedDevice]: "Sent from a device not verified by its owner",
  [ShieldStateCode.UnknownDevice]: "Sent from an unknown device",
  [ShieldStateCode.VerificationViolation]: "Verified user changed identity",
  [ShieldStateCode.MismatchedSender]: "Sender does not match",
  [ShieldStateCode.AuthenticityNotGuaranteed]: "Authenticity not guaranteed",
};

/**
 * Read the encryption shield for an event off its lazy provider. Called per
 * visible row (off the mapping path, since computing it eagerly forces crypto
 * for every item). Grey `authenticityNotGuaranteed` is suppressed (harmless
 * backup/forwarded keys). Returns null when there is no meaningful shield.
 */
export function shieldForEvent(item: TimelineItemInterface): Shield | null {
  const event = item.asEvent();
  if (!event) return null;
  let state;
  try {
    state = event.lazyProvider.getShields(false);
  } catch {
    return null;
  }
  if (!state) return null;
  if (state.tag === ShieldState_Tags.None) return null;
  const { code, message } = state.inner;
  if (state.tag === ShieldState_Tags.Grey && code === ShieldStateCode.AuthenticityNotGuaranteed) {
    return null;
  }
  return {
    color: state.tag === ShieldState_Tags.Red ? "red" : "grey",
    message: SHIELD_TEXT[code] ?? message ?? "Encryption warning",
  };
}

function mapVirtual(virtual: NonNullable<ReturnType<TimelineItemInterface["asVirtual"]>>, id: string): VirtualEntry {
  switch (virtual.tag) {
    case VirtualTimelineItem_Tags.DateDivider:
      return { kind: "virtual", id, virtual: { type: "dateDivider", ts: Number(virtual.inner.ts) } };
    case VirtualTimelineItem_Tags.ReadMarker:
      return { kind: "virtual", id, virtual: { type: "readMarker" } };
    case VirtualTimelineItem_Tags.TimelineStart:
    default:
      return { kind: "virtual", id, virtual: { type: "timelineStart" } };
  }
}

// Config helpers used by the view model live here so all FFI enum knowledge is
// in one place.
export const timelineEnums = { DateDividerMode, EncryptionState };
