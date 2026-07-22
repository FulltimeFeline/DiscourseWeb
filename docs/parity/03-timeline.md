# Parity Spec 03 — Timeline

The timeline is the most complex screen in Discourse: a live, back-paginating
message list with sender grouping, day dividers, ~13 message kinds, replies,
edits, reactions, read receipts, typing indicators, threads, encryption
shields, and a details column. This spec is the ground truth for the
TypeScript/React rewrite.

Source of truth (native):
- `Discourse/Features/Timeline/TimelineView.swift` — list rendering, scroll/anchoring, overlays, details column, member list.
- `Discourse/Features/Timeline/TimelineViewModel.swift` — lifecycle, diff application, grouping, pagination, sends, receipts.
- `Discourse/Features/Timeline/MessageRow.swift` — per-message rendering, context menu, reactions, receipt stack.
- `Discourse/Features/Timeline/ThreadView.swift` — thread sheet.
- `Discourse/Models/TimelineEntry.swift` — value-type row model.
- `Discourse/Models/TimelineEntry+FFI.swift` — SDK → value-type mapping.
- `Discourse/Core/ListenerBridge.swift` — UniFFI listener → AsyncStream bridges.

---

## 1. User-facing behaviors

### 1.1 Row model & entry types

The list renders an array of `TimelineEntry`, index-aligned 1:1 with the SDK's
timeline items (even non-rendered items get an entry so positional diffs stay
valid). Entry cases:

| Entry | Rendered as | Notes |
|---|---|---|
| `.message(MessageItem)` | `MessageRow` | The bulk; see §1.4. |
| `.system(id, text)` | `SystemRow` | Membership/profile/state/call events (see §1.6). Right-arrow glyph in a 40pt gutter + secondary text so it aligns with message text. |
| `.dayDivider(id, date)` | `DayDividerView` | Full weekday+month+day+year centered between two hairlines. Padding `.vertical 14`. |
| `.readMarker(id)` | `ReadMarkerView` | Red "NEW" divider. Only shown while `unreadMarkerVisible` (auto-dismisses; see §1.13). |
| `.timelineStart(id)` | `TimelineStartView` | "This is the beginning of the conversation." |
| `.hidden(id)` | `EmptyView` | Unknown virtual items / filtered/failed-to-parse events. Still occupies an array slot. |

`TimelineEntry.id` is the SDK item's `uniqueId().id` (stable across diffs), used
as the React key and scroll target.

### 1.2 Message grouping by sender

`regroup()` sets `MessageItem.showsHeader`. A message shows its header
(avatar + name + timestamp) UNLESS it directly follows another `.message` from
the **same `sender`** within `Preferences.groupingWindow` (a TimeInterval;
compared against `timestamp` delta). Any non-message entry between two messages
(divider, system row, read marker) breaks the group (`previous = nil`).

- Full regroup runs on any positional diff (insert/remove/reset/etc.).
- Incremental `regroup(at:)` runs for append tails and `.set` diffs (a row's
  header depends only on the entry directly above it). For `.set`, both the set
  row and the row below it are re-checked.
- `showsHeader` is only written when it actually changes (avoid redundant
  re-renders).

Grouped (headerless) rows: no avatar (gutter kept at 40pt for alignment), no
name; the avatar gutter instead shows a **hover-only timestamp** (right-aligned,
`hh:mm`), or always-visible if `prefs.alwaysShowTimestamps`.

### 1.3 Day dividers

Emitted by the SDK as `VirtualTimelineItem.dateDivider(ts)` (timeline created
with `dateDividerMode: .daily`). `ts` is ms since epoch. Rendered as
`DayDividerView`. **The web must NOT compute dividers itself** — they arrive as
timeline items and must stay index-aligned.

### 1.4 Message kinds (`MessageItem.Kind`)

Mapped in `TimelineEntry+FFI.kind(of:)`. Reply fallback (leading `> <@user>`
quoted lines + blank separator) is stripped from text/notice bodies via
`strippedReplyFallback` (the reply preview renders the quote instead).

| Kind | Source | Rendering (`MessageRow.content`) |
|---|---|---|
| `.text(body)` | `msgType == .text` | Markdown inline render (`RenderedBodyCache`), bare-URL autolink (accent+underline). Blockquote support (`>` lines → bar-accented secondary block, `QuotedBodyView`). Jumbo emoji if `prefs.jumboEmoji` and body is ≤8 all-emoji chars (`isJumboEmoji`, 44pt × fontScale). Custom emote (`:shortcode:`→mxc) images via `EmoteBodyText`. `(edited)` suffix. |
| `.notice(body)` | `msgType == .notice` | Same as text but `.secondary` foreground. |
| `.emote(body)` | `msgType == .emote` | Italic, rendered as `"{displayName} {body}"`. |
| `.image(ImageItem)` | `msgType == .image` OR `sticker` | `InlineImageView`. Blurhash placeholder while thumbnail loads. Clamped display size (max 360×280; stickers 160×160, no open-externally). `isSticker` flag. |
| `.video(VideoItem)` | `msgType == .video` | `VideoAttachmentView`. Poster frame (thumbnailSource), duration badge (`durationText` "1:05"), blurhash, plays on tap. |
| `.audio(AudioItem)` | `msgType == .audio` | `VoiceMessageView`. `isVoiceMessage` (has `voice`), waveform (normalised `/1024`), duration, play/scrub via shared `AudioPlaybackController`. |
| `.poll(PollItem)` | `MsgLikeKind.poll` | `PollView`. Question, answers with per-answer voteCount + votedByMe, maxSelections, disclosed/undisclosed (undisclosed hides results until `isEnded`), totalVotes. |
| `.location(body, geoUri)` | `msgType == .location` | Tappable Label → opens Apple Maps URL parsed from `geo:lat,lon`. |
| `.media(label, systemImage)` | `.file`, `.gallery`, `.liveLocation` | Labeled chip. file→`doc`; gallery→`photo.on.rectangle`, "Gallery"; liveLocation→`location.fill`, "Live location". |
| `.redacted` | `MsgLikeKind.redacted` | Italic tertiary "Message deleted". |
| `.unableToDecrypt` | `MsgLikeKind.unableToDecrypt` | Lock icon + "Waiting for this message to decrypt…" (UTD). |
| `.unsupported(label)` | `MsgLikeKind.other`, `msgType .other` | Secondary text label. |

### 1.5 Reply rendering

`replyPreview` (from `msgLike.inReplyTo`). Renders above the body: 2pt accent
bar + reply glyph + bold sender name + single-line snippet (markdown-rendered,
tail-truncated). Whole preview is a button → `jumpToEvent(reply.eventId)`. If
the replied-to details aren't loaded (`isPending`), snippet is "…" and the VM
calls `fetchDetailsForEvent` (once per event) to fill it in. `.error` →
"Message unavailable".

### 1.6 State events / membership / call events

Mapped to `.system` rows in `TimelineEntry+FFI`:
- **roomMembership** → `membershipText`: joined / left / invited / invitation
  accepted / declined / banned (banned + kickedAndBanned) / unbanned / removed
  (kicked) / requested to join (knocked) / "membership changed" fallback.
- **profileChange** → "X is now known as Y" (if display names differ) or
  "X updated their profile".
- **state** (generic) → "X updated the room".
- **callInvite / rtcNotification** → "X started a call".
- **failedToParseMessageLike / failedToParseState** → `.hidden` (not rendered).

### 1.7 Edits

`isEdited` from `message.isEdited`. Renders as a small tertiary " (edited)"
suffix appended to the body Text (`editedSuffix`). VoiceOver appends ", edited".

### 1.8 Reactions display

`ReactionChips` (`FlowLayout` wrapping). Each chip: emoji (unicode `Text`, or
`mxc://` custom emote rendered as image via `EmoteImageView`) + count. Own
reaction → tinted background + accent border. Tap toggles. Hover (macOS) /
long-press (iOS) → popover/context menu listing senders (names resolved via
`membersById`, falling back to localpart). Trailing "+" chip opens the emoji
picker. Animated in/out (`.spring`, scale+opacity; suppressed under
`reduceMotion`).

### 1.9 Read receipts

**Critical correction.** The SDK's per-item `readReceipts` mis-places receipts
on the newest event. Discourse overrides them with **explicit receipts** polled
from a parallel long-poll `/sync` (sliding-sync receipts extension):

- `startEphemeralSync()` runs a `Task` loop calling
  `service.fetchRoomEphemerals(roomId:, since:)`. First call snapshots full
  state; subsequent long-polls block until something changes (effectively
  instant). Tracks `nextBatch` cursor.
- `explicitReceipts: [userId: eventId]` holds true read positions.
- `applyExplicitReceipts()` rewrites every message's `readReceiptUserIds` to
  the users whose true position == that event's id (excluding own user, sorted).
  So a reader's avatars sit on the **exact** event they read, including the
  newest one (which the SDK otherwise leaves a message behind). No-op until the
  first poll lands.
- Runs on every diff `apply` and whenever receipts change.

Display (`ReadReceiptStack`, trailing edge of the last-read row): up to 3
overlapping 15pt avatars (`spacing: -5`, background stroke ring), then
`+N` overflow. macOS: hover (300ms delay) → popover "Read up to here by" list.
iOS: tap → sheet with 32pt-avatar reader list. Gated on
`prefs.showReadReceipts`.

**Own-message "Sent" tick.** When there are no receipts on an own message,
`message.id == lastOwnMessageId`, `sendState == nil`, and it has an eventId,
show a tertiary checkmark ("Sent"). `lastOwnMessageId` = newest own message but
only while nobody has read past it (a receipt on a later row means it was read,
so the tick would contradict; `updateLastOwnMessageId` scans reversed and breaks
on the first non-own row with receipts). Recomputed per diff batch.

### 1.10 Typing indicators

Two independent sources, both filtering out own user:
1. `room.subscribeToTypingNotifications` (SDK listener → `TypingNotificationsBridge`).
2. The ephemeral `/sync` poll's `typing` field.

`typingUsers: [String]`. An **expiry task** (10s from listener / 12s from poll)
clears stale typers, because a "stopped typing" update can be lost server-side
(a stopped typer stays listed until their client's ~30s timeout). Same-value
writes suppressed. The typing tag grows the composer (bottom inset); when at
bottom the list re-anchors to keep the newest message visible.

### 1.11 Sender profiles / power-level tags

- Header shows `effectiveName` (own messages use live `scope.ownDisplayName`
  before sync echoes it back), pronouns (from `pronounsStore`), and timestamp.
  Tapping name/avatar opens the profile sheet. `senderColor` optionally hashes
  the sender id into an 8-color palette (`prefs.coloredSenderNames`).
- Own avatar/name use live `scope.ownAvatarURL` / `ownDisplayName`.
- Power-level tags (`in.cinny.room.power_level_tags`, MSC): members grouped by
  actual power level, each level a named role with emoji (unicode or mxc
  custom-emote) + colored name (`RoleTagLabel`). `roleTag(forLevel:)` resolves
  the room's tag or a default label. Members list in the details column.

### 1.12 Encryption shields

Per-message `ShieldWarning` (level red/grey + text), fetched **lazily** per row
on appear (`loadShieldIfNeeded`, off-main via `provider.getShields(strict:false)`).
Computing during diff mapping forced eager crypto for every item. Grey
`authenticityNotGuaranteed` is suppressed (backup/forwarded keys — harmless).
Codes → text: sentInClear "Not encrypted", unverifiedIdentity, unsignedDevice,
unknownDevice, verificationViolation, mismatchedSender. Rendered as a leading
exclamation-circle (filled+red for red level, outline+secondary for grey) with
tap→popover explanation. Re-armed on `.set` diffs (a verification change can
arrive as a set; offscreen rows refetch via `task(id:)`, visible rows kicked
directly). Room-level lock badge in toolbar/title when `isEncrypted`.

### 1.13 Unread marker & jump-to-unread

- `firstUnreadMarkerId` = id of the `.readMarker` entry, cached per diff batch.
- The inline "NEW" divider and the "Jump to unread" pill both gate on
  `unreadMarkerVisible`. `setUnreadMarker` arms it when a *new* marker appears;
  an auto-dismiss task hides it after 5s (marks `dismissedMarkerId` so it stays
  hidden on return). Re-arms only for a genuinely different marker.
- "Jump to unread" pill (top overlay): shown when `unreadMarkerVisible` && marker
  loaded && not at bottom && marker not currently visible. Scrolls marker to top.
- `markAsRead()` / `dismissUnreadMarker()` hide it immediately (caught up).

### 1.14 Timestamps

- Header timestamp: today → `hh:mm` (locale am/pm or forced 24h via
  `prefs.use24HourTime`); earlier days → `MMM d, hh:mm`.
- Grouped-row gutter: hover-only `hh:mm` (or always if `alwaysShowTimestamps`).
- iOS context menu has a disabled "Sent at …" item (touch has no hover).
- Optional per-message event-id line (`prefs.showEventIds`, monospaced,
  selectable).

### 1.15 Message actions / context menu

`contextMenuItems` (right-click macOS / long-press iOS):
- Quick-reactions palette row (`ReactionUsage.top(5)`, unicode only, rasterised).
- "More Reactions…" → emoji picker popover/sheet (custom packs + unicode).
- "View Profile".
- "Reply" (if `canBeRepliedTo`) → sets `replyTarget`.
- "Edit Message" (own + eventId + `.text` only) → sets `editTarget`, clears reply.
- "Reply in Thread" (live mode + eventId) → opens thread sheet.
- "Copy Text" + "Share…" (text kind).
- Image: iOS "Share Image…"/"Save Image"; macOS "Copy Image"/"Save Image…"/"Share Image…".
- "Copy Event ID" (if eventId).
- Own: "Retry Send" (if failed), "Cancel Upload" (`canCancelSend`), "Delete
  Message" (if `canRedactOwn`, confirm-gated by `confirmBeforeDeleting`).
- Others: "Delete Message" (if `canRedactOther` — moderator), "Report Message…"
  (reason prompt → `room.reportContent`).

iOS extras: swipe-left-to-reply gesture (rubber-banded, 48pt threshold, glyph
overlay); failed-send red icon → Retry/Delete dialog.

### 1.16 Pagination

- **Back-pagination** driven by a visibility-driven `paginationHeader` at the
  top of the list: while visible and `!reachedStart`, it loops
  `paginateBackwards()` every 1s (polling, not `.task(id:)` — count changes
  every diff and cancelled pagination). `paginateBackwards(numEvents: 50)`,
  reentrancy-guarded (`isPaginating`), skipped when parked. Sets `reachedStart`
  from the SDK return.
- Exponential backoff on failure (offline): 1,2,4,…30s gate, reset on success.
- First page kicked manually in `performStart()` (sentinel appears before the
  timeline exists).
- **Live updates at bottom** arrive as `.append`/`.pushBack` diffs; the tail is
  followed only while `isAtBottom` (or for own just-sent messages).

### 1.17 Scroll behavior

- `.defaultScrollAnchor(.bottom)` — list opens pinned to newest.
- **isAtBottom** computed from real scroll geometry (`contentSize.height -
  visibleRect.maxY <= 40`), NOT a sentinel row — a LazyVStack instantiates a
  sentinel ~a screen early, which would flip isAtBottom (and fire receipts)
  while the newest message is still below the fold.
- **Tail-follow**: on `entries.last.id` change, if `isAtBottom` OR the last is
  an own message (incl. when a local echo without eventId is replaced by the
  confirmed event), scroll last to bottom — twice (second in next tick, because
  the new row's real height isn't known on first pass).
- **Jump-to-present** button (bottom-trailing chevron): shown when `!isAtBottom`;
  scrolls to last, animated.
- **Jump-to-event / jump-to-reply**: `jump(to:)` back-fills via `ensureLoaded`
  (bounded ~30 attempts after waiting for the timeline to exist), then scrolls
  to center (animated). A miss shows a transient "Couldn't find that message"
  capsule. Sources: reply clicks, search hits, cross-room event navigation,
  media gallery taps.
- **Scroll-memory restore** (room switch / relaunch): on `.task` start, if a
  saved anchor event (`appState.timelineAnchor`) is loaded, scroll there with no
  animation (`restoreEventId`); else if unreads exist, land on first unread
  (`openUnreadScrollId`, top anchor, no animation); else bottom.
- **Anchor capture**: `scrollAnchorEventId` = bottom-most visible message's
  eventId (nil at bottom). Saved on disappear and at room-switch time.
- `onScroll` re-anchors on typing-tag appearance too.

### 1.18 New-message indicator

There is no separate "N new messages" badge; the jump-to-present chevron plus
the sidebar unread pip cover this. When at bottom, appended messages auto-scroll
and auto-mark-read.

### 1.19 Threads

`ThreadView` (sheet). Its own `TimelineViewModel` with `mode: .thread(rootEventId:)`,
`TimelineFocus.thread`. Same rows, same pagination poll, same composer. Opened
from a message's `threadInfo` button ("N replies") or "Reply in Thread" menu.
Tail-follows only at-bottom or for own echo. `start()` on appear, `stop()` on
disappear (thread VMs are not cached/parked). The live timeline is created with
`hideThreadedEvents: true` so threaded replies don't clutter the main list;
thread roots still show their reply-count button.

### 1.20 Details column (adjacent, same VM)

Right column (`RoomDetailsColumn`, 230pt, persisted `showsDetailsColumn`; iPhone
compact → sheet). Tabs: Info (avatar/topic/facts/copy-id/settings), Members
(role-grouped via power-level tags, presence-sorted with offline section,
search, invite, DM, kick/ban), Media (image grid + file rows, backed by a
`.media`-mode filtered timeline). Not strictly "timeline" but shares the VM and
`jumpToEvent`.

---

## 2. Data flow

### 2.1 TimelineViewModel lifecycle

- **Construction**: from a `Room`, `ownUserId`, `MediaLoader`, optional
  `MatrixService` + `CustomEmojiStore`, and a `Mode` (`.live` / `.thread` / `.media`).
  Reads `roomName`, `topic` synchronously. `@MainActor @Observable`.
- **`start()`** (idempotent, guards `timeline == nil`, dedupes concurrent callers
  via `startTask`):
  - `.live`: `subscribeToRooms([roomId])` (so sliding-sync streams this room's
    ephemerals promptly), ensure custom-emoji room pack.
  - Build the FFI `Timeline` via `room.timelineWithConfiguration(...)` with a
    mode-specific `TimelineFocus` / `TimelineFilter` / internal-id prefix,
    `dateDividerMode: .daily`, `trackReadReceipts` (live only), `reportUtds:false`.
  - `attachTimelineListener` (diff bridge; SDK replays list as initial `.reset`).
  - `.live` only: typing listener, room-info listener (updates hasActiveCall/
    isEncrypted/name/topic/avatar/memberCount/permissions), initial `roomInfo()`,
    `markAsRead()`.
  - Always: `refreshPermissions()`, `flushOutboundQueue()`, kick first
    `paginateBackwards()`.
  - `loadMembers()` is called from the view's `.task` (backs receipt avatars).
- **`stop()`**: cancels all tasks, drops retained listeners, `timeline = nil`.
  Thread/media VMs stop on disappear; the live VM is cached and parked instead.

### 2.2 The FFI Timeline + diff listener (ListenerBridge)

- UniFFI listener callbacks fire on Rust/tokio threads. `TimelineDiffBridge`
  (conforms to `TimelineListener`) turns `onUpdate(diff:)` into an
  `AsyncStream<[TimelineDiff]>`. **The registration `TaskHandle` MUST be
  retained** or the subscription is silently cancelled (`timelineListenerRetained`).
- `attachTimelineListener` cancels the old drain task, registers a fresh bridge
  via `timeline.addListener`, drains diffs on the main actor into `apply(diffs)`,
  and starts the ephemeral sync.
- Other bridges used here: `TypingNotificationsBridge`, `RoomInfoBridge`. (Full
  bridge catalog in the file: room list, sync-state, verification, client-delegate,
  send-queue-error, spaces.)

### 2.3 Diff application (`apply`)

Iterates `[TimelineDiff]`, mutating `entries` (value-type `TimelineEntry`s built
via `TimelineEntry.init(ffi:)`). Diff cases: `.append`, `.pushBack`,
`.pushFront`, `.popFront`, `.popBack`, `.insert(index,value)`,
`.set(index,value)`, `.remove(index)`, `.truncate(length)`, `.clear`,
`.reset(values)`.

Grouping optimization: `.set` batches and pure-append batches regroup only the
touched neighborhood; any other positional diff → full regroup.

`.clear` / `.reset` (and `.reset` with fewer items than before) reopen
pagination (`reachedStart = false`) and clear shields. `.reset` also handles
unpark anchor restore. `.set` re-arms shield fetch for its event.

After the batch: `updateLastOwnMessageId`, `setUnreadMarker`,
`applyExplicitReceipts`, `fetchPendingReplyDetails`, and if appended-at-bottom
&& isAtBottom → `markAsRead`.

### 2.4 Value-type mapping (`TimelineEntry+FFI`)

`init(ffi item: TimelineItem)`: `asEvent()` → build `MessageItem` or `.system`;
`asVirtual()` → dateDivider / readMarker / timelineStart / `.hidden`; else
`.hidden`. Never drops an item (index alignment). See §1.4/§1.6 for the content
switch. Reply fallback stripping, inline-emote HTML parse, poll answer/vote
mapping, sticker→image, shield-provider box all live here.

### 2.5 Lazy per-row work

- **Shields**: `shieldProvider` (boxed `LazyTimelineItemProvider`) computed on
  row appear, off-main, cached in `shields[eventId]`, requested once
  (`shieldsRequested`). Re-armed on `.set`.
- **Blurhash**: `ImageItem.blurhash` / `VideoItem.blurhash` decoded as a
  placeholder while the thumbnail loads (in `InlineImageView`/`VideoAttachmentView`).
- **Reply details**: fetched lazily via `fetchDetailsForEvent` for pending previews.
- **Media thumbnails**: `MediaLoader.thumbnail(for:pixelSize:)`, cached.

### 2.6 Parking / eviction

The phone keeps timelines mounted offscreen behind the room list, so `.task`
doesn't re-run. `isParked` didSet drives:
- **`parkTimeline()`**: captures the scroll anchor, stops audio + stream +
  ephemeral tasks, **detaches the diff listener** (`timelineListenerRetained = []`),
  truncates `entries` to a 200-row tail (keeping the anchor's row), reopens
  pagination, drops members. Receipt-sending is gated on `!isParked` (the bottom
  sentinel still reads as "visible" when parked, which would silently read
  messages).
- **`unparkTimeline()`**: re-attaches the listener (initial `.reset` restores the
  full list), reloads members. Guards against rapid unpark→park races. The view
  scrolls to `unparkScrollTarget` once the reset rebuilds entries.

---

## 3. MatrixRustSDK FFI symbol catalog (flat)

Every SDK symbol touched by the timeline slice. **Critical for the web SDK
binding surface.**

### Room-level

- `Room.id()`
- `Room.displayName()`
- `Room.topic()`
- `Room.timelineWithConfiguration(configuration:)` → `Timeline`
- `Room.roomInfo()` → `RoomInfo`
- `Room.subscribeToRoomInfoUpdates(listener:)` → `TaskHandle`
- `Room.subscribeToTypingNotifications(listener:)` → `TaskHandle`
- `Room.typingNotice(isTyping:)`
- `Room.members()` → `RoomMembersIterator`
- `Room.getPowerLevels()` → `RoomPowerLevels`
- `Room.kickUser(userId:reason:)`
- `Room.banUser(userId:reason:)`
- `Room.reportContent(eventId:reason:)`
- `Room.setUnreadFlag(newValue:)`
- `Room.sendRaw(eventType:content:)` — stickers (`m.sticker`)
- `Room.sendStateEventRaw(eventType:stateKey:content:)` — power-level tags

### Timeline-level

- `Timeline.addListener(listener:)` → `TaskHandle` (retain!)
- `Timeline.paginateBackwards(numEvents:)` → `Bool` (reachedStart)
- `Timeline.send(msg:)`
- `Timeline.sendReply(msg:eventId:)`
- `Timeline.edit(eventOrTransactionId:newContent:)`
- `Timeline.redactEvent(eventOrTransactionId:reason:)`
- `Timeline.toggleReaction(itemId:key:)`
- `Timeline.sendImage(params:thumbnailSource:imageInfo:)` → `SendAttachmentJoinHandle`
- `Timeline.sendVideo(params:thumbnailSource:videoInfo:)` → `SendAttachmentJoinHandle`
- `Timeline.sendFile(params:fileInfo:)` → `SendAttachmentJoinHandle`
- `Timeline.sendVoiceMessage(params:audioInfo:waveform:)` → `SendAttachmentJoinHandle`
- `Timeline.createPoll(question:answers:maxSelections:pollKind:)`
- `Timeline.sendPollResponse(pollStartEventId:answers:)`
- `Timeline.endPoll(pollStartEventId:text:)`
- `Timeline.sendLocation(body:geoUri:description:zoomLevel:assetType:repliedToEventId:)`
- `Timeline.markAsRead(receiptType:)`
- `Timeline.fetchDetailsForEvent(eventId:)`
- `SendAttachmentJoinHandle.join()`

### Timeline configuration / focus / filter

- `TimelineConfiguration(focus:filter:internalIdPrefix:dateDividerMode:trackReadReceipts:reportUtds:)`
- `TimelineFocus.live(hideThreadedEvents:)`
- `TimelineFocus.thread(rootEventId:)`
- `TimelineFilter.all`
- `TimelineFilter.onlyMessage(types:)` — with `TimelineEventTypeFilter`-style message types `[.image, .video, .file, .audio, .gallery]`
- `DateDividerMode.daily`
- `ReceiptType.read`
- `PollKind.disclosed` / `.undisclosed`
- `AssetType.sender` (location)

### Timeline diff stream

- `TimelineListener` (protocol; `onUpdate(diff:)`)
- `TimelineDiff` with cases: `.append(values)`, `.clear`, `.pushFront(value)`,
  `.pushBack(value)`, `.popFront`, `.popBack`, `.insert(index,value)`,
  `.set(index,value)`, `.remove(index)`, `.truncate(length)`, `.reset(values)`

### Timeline items

- `TimelineItem.uniqueId().id`
- `TimelineItem.asEvent()` → `EventTimelineItem?`
- `TimelineItem.asVirtual()` → `VirtualTimelineItem?`
- `VirtualTimelineItem.dateDivider(ts)` / `.readMarker` / `.timelineStart`
- `EventTimelineItem.senderProfile` → `ProfileDetails` (`.ready(displayName,_,avatarUrl)`)
- `EventTimelineItem.content` → `TimelineItemContent`
- `EventTimelineItem.eventOrTransactionId` (`.eventId(id)` / `.transactionId(id)`)
- `EventTimelineItem.localSendState` (`.notSentYet` / `.sendingFailed` / …)
- `EventTimelineItem.sender`
- `EventTimelineItem.isOwn`
- `EventTimelineItem.timestamp` (ms)
- `EventTimelineItem.canBeRepliedTo`
- `EventTimelineItem.readReceipts` (map; **overridden** by explicit poll)
- `EventTimelineItem.lazyProvider` → `LazyTimelineItemProvider`

### Timeline item content

- `TimelineItemContent.msgLike(MsgLikeContent)`
- `TimelineItemContent.roomMembership(userId,userDisplayName,change,_)`
- `TimelineItemContent.profileChange(displayName,prevDisplayName,_,_)`
- `TimelineItemContent.state`
- `TimelineItemContent.callInvite` / `.rtcNotification`
- `TimelineItemContent.failedToParseMessageLike` / `.failedToParseState`
- `MsgLikeContent.kind`, `.threadSummary` (`.numReplies()`), `.inReplyTo`,
  `.reactions` (`.key`, `.senders[].senderId`)
- `MsgLikeKind.message(Message)` / `.sticker(body,info,source)` /
  `.poll(question,pollKind,maxSelections,answers,votes,endTime,_)` /
  `.redacted` / `.unableToDecrypt` / `.other` / `.liveLocation`
- `Message.msgType` → `MessageType`, `.body`, `.isEdited`
- `MessageType.text/notice/emote/image/video/audio/file/gallery/location/other`
- Content bodies: `TextMessageContent`/`NoticeMessageContent`/`EmoteMessageContent`
  (`.formatted` → `FormattedBody`(`.format == .html`, `.body`)),
  `ImageMessageContent`(`.filename`,`.caption`,`.info` → `ImageInfo`(`.width`,`.height`,`.blurhash`),`.source`),
  `VideoMessageContent`(+`.info.duration`,`.thumbnailSource`,`.mimetype`),
  `AudioMessageContent`(`.info.duration`,`.audio.duration`,`.audio.waveform`,`.voice`,`.source`),
  `FileMessageContent`(`.filename`), `LocationContent`(`.body`,`.geoUri`)
- `InReplyToDetails.eventId()`, `.event()` → `RepliedToEvent` (`.ready(content,sender,senderProfile,_,_)` / `.pending` / `.unavailable` / `.error`)

### Crypto / shields

- `LazyTimelineItemProvider.getShields(strict:)` → `ShieldState`
- `LazyTimelineItemProvider.getSendHandle()` → `SendHandle?`
- `ShieldState.red(code)` / `.grey(code)` / `.none`
- `TimelineEventShieldStateCode`: `.sentInClear`, `.unverifiedIdentity`,
  `.unsignedDevice`, `.unknownDevice`, `.authenticityNotGuaranteed`,
  `.verificationViolation`, `.mismatchedSender`

### Send handles / send queue

- `SendHandle.tryResend()`
- `SendHandle.abort()`

### Members / power levels

- `RoomMembersIterator.nextChunk(chunkSize:)`
- `RoomMember.membership` (`.join`), `.isServiceMember`, `.userId`,
  `.displayName`, `.avatarUrl`, `.suggestedRoleForPowerLevel`
  (`.creator`/`.administrator`/`.moderator`/`.user`), `.powerLevel`
  (`.infinite`/`.value(v)`)
- `RoomPowerLevels.canOwnUserInvite()`, `.canOwnUserKick()`, `.canOwnUserBan()`,
  `.canOwnUserRedactOwn()`, `.canOwnUserRedactOther()`

### RoomInfo

- `RoomInfo.hasRoomCall`, `.encryptionState` (`.encrypted`), `.displayName`,
  `.id`, `.topic`, `.avatarUrl`, `.joinedMembersCount`, `.isDm`, `.isDirect`

### Upload params / media info

- `UploadParameters(source:caption:formattedCaption:mentions:inReplyTo:)`
- `UploadSource.data(bytes:filename:)`
- `ImageInfo(...)`, `VideoInfo(...)`, `AudioInfo(...)`, `FileInfo(...)`, `ThumbnailInfo(...)`
- `MediaSource.fromUrl(url:)`, `MediaSource.url()`
- `messageEventContentFromMarkdown(md:)`, `messageEventContentFromHtml(body:htmlBody:)`
- `EditedContent.roomMessage(content:)`
- `EventOrTransactionId.eventId(eventId:)` / `.transactionId(transactionId:)`

### Listeners (bridges)

- `TimelineListener` → `TimelineDiffBridge`
- `TypingNotificationsListener` (`call(typingUserIds:)`) → `TypingNotificationsBridge`
- `RoomInfoListener` (`call(roomInfo:)`) → `RoomInfoBridge`

---

## 4. Web mapping (TypeScript / React)

- **Virtualized reverse list**: a bottom-anchored virtualizer (e.g. TanStack
  Virtual or a custom windowing list) with `column-reverse`-style anchoring so
  new items grow from the bottom and back-pagination prepends without jumping.
  Preserve scroll offset on prepend (measure delta and re-apply). Keep the SDK's
  index-aligned entry array as the source; render `TimelineEntry` union to React
  components 1:1 (message / system / dayDivider / readMarker / timelineStart /
  hidden→null).
- **isAtBottom**: measure from scroll geometry (`scrollHeight - scrollTop -
  clientHeight <= 40`), NOT a sentinel element — same trap as native. Drive
  tail-follow, read receipts, jump-to-present, and unread pill off it.
- **IntersectionObserver** for three jobs:
  1. Top pagination sentinel → `paginateBackwards()` loop (with the same
     reentrancy guard + exponential backoff).
  2. Per-row visibility → lazy shield fetch + reply-detail fetch + receipt
     `markAsRead` gating (`visibleEntryIds` set).
  3. Unread-marker visibility → gates the "Jump to unread" pill.
- **Blurhash decode in JS**: decode `ImageItem.blurhash` / `VideoItem.blurhash`
  to a tiny canvas/data-URL placeholder shown until the thumbnail loads (e.g.
  `blurhash` npm package `decode` → `ImageData`). Match native's clamped
  `displaySize` math (max 360×280; sticker 160×160; unknown-dims fallbacks).
- **Diff application**: port `apply(diffs)` verbatim (append/pushBack/pushFront/
  pop/insert/set/remove/truncate/clear/reset), including the regroup-neighborhood
  optimization and the reachedStart-reopen on clear/reset-shrink.
- **Grouping**: port `regroup` (same-sender + `groupingWindow` on timestamp
  delta, broken by non-message entries).
- **Explicit receipts**: replicate the parallel `/sync` ephemeral poll (or the
  web SDK's equivalent receipts source) and `applyExplicitReceipts` override —
  do NOT trust the timeline item's `readReceipts` for placement.
- **Markdown**: render markdown inline-only + bare-URL autolink + blockquote
  handling; cache per raw body (native uses an NSCache of 500). Custom emote
  (`:shortcode:`→mxc) inline image substitution. Jumbo-emoji detection.
- **Timestamps**: locale-aware `hh:mm` / `MMM d, hh:mm`, 24h option; hover-only
  on grouped rows.
- **Parking**: on route away, either fully unmount+cache the VM state or keep it;
  gate `markAsRead` on a parked flag; truncate entries to shed memory if kept.
- **Scroll restore**: persist per-room anchor eventId; on mount, restore to it
  (no animation) or land on first unread, else bottom.
- **Threads**: a modal/sheet with its own timeline instance
  (`TimelineFocus.thread`); main timeline uses `hideThreadedEvents`.

---

## 5. Parity checklist (acceptance criteria)

### Rendering
- [ ] Every SDK item maps to exactly one row; array stays index-aligned with diffs (hidden items included).
- [ ] Sender grouping: header hidden for same-sender messages within `groupingWindow`; broken by any non-message entry; gutter width preserved on grouped rows.
- [ ] Day dividers come from SDK `dateDivider` items (not client-computed) and render full weekday+date.
- [ ] All 13 kinds render correctly: text, notice (secondary), emote (italic "{name} {body}"), image, video (poster+duration+play), audio/voice (waveform+duration+play), poll (disclosed vs undisclosed, votedByMe, ended), location (Maps link), file/gallery/liveLocation chips, redacted ("Message deleted"), UTD ("Waiting to decrypt…"), unsupported.
- [ ] Sticker renders small (160²), no open-externally affordance.
- [ ] Markdown: inline styles, bare-URL autolink (accent+underline), blockquotes, custom emotes, jumbo emoji.
- [ ] "(edited)" suffix on edited messages.

### Replies / threads
- [ ] Reply preview shows bar + glyph + sender + snippet; click jumps to original; pending previews fill in after fetch; "Message unavailable" on error.
- [ ] Reply fallback quoted lines stripped from body.
- [ ] Thread button shows "N repl{y,ies}"; opens thread sheet with its own timeline; main list hides threaded events.

### Reactions
- [ ] Chips wrap; own reaction tinted+bordered; count updates; toggle works; sender list on hover/long-press; custom-emote (mxc) chips render as images; "+" opens picker.

### Receipts (the correction)
- [ ] Read receipts use explicit `/sync`-polled positions, NOT the timeline item's `readReceipts`; a reader's avatar sits on the exact event they read, including the newest.
- [ ] Up to 3 stacked avatars + "+N"; reader list on hover(mac)/tap(iOS); gated on `showReadReceipts`.
- [ ] Own "Sent" tick shows only on the newest own message with no later receipts and a confirmed eventId.

### Typing
- [ ] Typing users (minus self) shown; stale typers expire (~10–12s); typing-tag growth re-anchors when at bottom.

### Shields / encryption
- [ ] Shields fetched lazily per visible row, cached; grey `authenticityNotGuaranteed` suppressed; red vs grey styling + tap explanation; re-fetched after a `.set` verification change; room lock badge when encrypted.

### Pagination & live
- [ ] Back-pagination polls while the top sentinel is visible, 50 events/page, reentrancy-guarded, exponential backoff offline, sets reachedStart; timelineStart row at the top when reached.
- [ ] First page kicked on start even before the sentinel is measured.
- [ ] Live appends follow the tail only when at bottom (or own echo); double-scroll after layout so tall new rows aren't half-shown.

### Scroll / navigation
- [ ] isAtBottom from geometry (40pt), not a sentinel.
- [ ] Jump-to-present chevron when not at bottom.
- [ ] jump-to-event back-fills then centers; miss shows a transient notice.
- [ ] Scroll-memory restore (no animation) → else first-unread → else bottom.
- [ ] "NEW" divider + "Jump to unread" pill gate on an auto-dismissing marker (5s), stay dismissed on return, re-arm only for a new marker.

### Actions
- [ ] Context menu: react (quick + picker), reply, edit (own text only), reply-in-thread, copy text/event-id, share, image save/copy/share, delete (own→redactOwn / other→redactOther, confirm-gated), report (others), retry/cancel failed sends.
- [ ] iOS swipe-left-to-reply; failed-send icon → Retry/Delete.

### Lifecycle / data flow
- [ ] `start()` idempotent + concurrent-caller-safe; builds timeline with correct focus/filter/config per mode.
- [ ] Diff listener TaskHandle retained; drain on main thread; initial reset restores full list.
- [ ] Parking: detaches listener, truncates entries, gates markAsRead; unpark re-attaches (reset) and restores scroll anchor + members.
- [ ] Value-type mapping never drops an item; lazy shield/blurhash/reply-detail work deferred off the mapping path.
- [ ] markAsRead debounced (per newest eventId), gated on `!parked && live`, honors `sendReadReceipts` pref while still clearing the local unread flag.
