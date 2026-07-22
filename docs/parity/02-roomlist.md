# Parity Spec 02 — Room List & Spaces (Sidebar)

Scope: the left sidebar — the spaces rail, the space/Home switcher, the room list
(rooms, DMs, invites, joinable "more rooms"), search-in-list, unread accounting,
the cold-launch snapshot, and the space home sheet. Source of truth is the native
SwiftUI client (`RoomListViewModel`, `SidebarView`, `SpacesRail`, `SpaceHomeView`,
`RoomSummary`). Platform-specific window chrome is dropped, but places where
behavior (not just chrome) differs by platform are flagged **[platform]**.

---

## 1. Layout overview

Two columns compose the sidebar region:

1. **Spaces rail** (`SpacesRail`) — a narrow vertical strip of circular avatars:
   - **Home button** at top: accent-filled circle with an `envelope.fill` glyph.
   - A short horizontal **divider capsule** (gray, 32×2).
   - One **space avatar** per joined top-level space, in the user's drag-arranged
     order (`orderedSpaces`).
   - A **"+" New Space** button at the bottom of the scrollable list.
   - **[platform]** macOS pins an **account switcher** avatar (40pt) at the very
     bottom of the rail. iOS omits it (there's a Profile tab instead).
   - Avatar slot is 48pt; avatar itself 40pt. The slot must contain the selection
     ring or the rail clips it.

2. **Room list column** (`SidebarView`) — header + search + the scrolling list:
   - **[platform]** iOS renders an in-content **header row**: space/Home name +
     a chevron-down menu (space actions), a sync-status subtitle under the title
     (spinner + "Reconnecting…"/"Updating…"), and a "+" new-menu button on the
     right. macOS puts the space switcher and "+" in the **window toolbar** instead
     and shows sync status as a quiet in-list row.
   - **Search field** — shown **only on Home** (`selectedSpaceId == nil`); a space's
     room list is short enough that a second search bar is redundant.
   - A **column boundary hairline** on the trailing edge in three-pane layouts
     (macOS always; iPad when `horizontalSizeClass == .regular`). Not drawn on
     iPhone (chat slides over as a full layer). **[platform]** chrome-only.

The two columns share one `RoomListViewModel` instance per account (`SessionScope`).

---

## 2. Spaces rail behaviors

### 2.1 Rail buttons
Each rail slot (`railButton`) renders:
- The avatar/glyph (Home glyph, space avatar, or "+" glyph).
- **Selection pill**: a tall (30pt) rounded pill on the **leading edge** when this
  slot is selected. **[platform]** macOS draws it concrete white + drop shadow
  (semantic colors vanish into sidebar vibrancy); iOS uses `.primary`.
- **Unread pip**: when not selected and the space/Home has any unread, a short
  (10pt) pill on the leading edge (same shape as the selection pill, shorter).
- **Mention dot**: a **red** 13pt circle at the bottom-trailing corner (with a
  2.5pt window-colored stroke) when the space/Home has a real mention waiting.
  Distinct from the plain unread pip.
- Animations: mention dot and selection pill spring in/out
  (`response 0.3, damping 0.8`).

Selecting a rail button calls `selectSpace(id)` (or `selectSpace(nil)` for Home).

### 2.2 Home vs spaces unread aggregation
Rail unread state is **stored, not derived per render** (`recomputeUnreadFlags`),
equality-guarded so the rail re-renders only when a flag flips:
- `unreadSpaceIds` — spaces containing a room with `hasAnyUnread`.
- `homeHasUnreadFlag` — a Home room (`!isSpace && (isDirect || not filed in any
  space)`) has any unread.
- `mentionSpaceIds` / `homeHasMentionFlag` — same, but only for rooms where
  `isMentioned` (a real mention).
- Recomputed whenever `rooms` or `allSpaceChildIds` mutates.

### 2.3 Rail reordering (drag)
- Long-press-drag a space avatar to rearrange (`onDrag` → `NSItemProvider` with a
  private in-process UTI `es.discourse.space-reorder`, `.ownProcess` visibility).
  The payload is never read; the dragged id travels via `@State draggingSpaceId`.
- `SpaceReorderDropDelegate.dropEntered` live-reorders via
  `viewModel.moveSpace(id:before:)` as the avatar passes neighbors, animated.
- Home and "+" stay pinned (not draggable).
- **Persistence**: order saved to `UserDefaults` key `"spaceOrder|<userId>"` as an
  array of space ids. Unknown/new spaces sort to the end. `rebuildOrderedSpaces`
  reapplies the saved order over the SDK-ordered `spaces`.
- **Web**: persist to `localStorage["spaceOrder:<userId>"]`. Same "unknown → end"
  merge. `spaces` stays SDK/positional (index-aligned with the diff stream);
  `orderedSpaces` is the display order.

### 2.4 Rail context menus
- **Home**: "Mark All as Read" → `markRead(homeRoomIds)`.
- **Space**: "Mark All as Read" → `markRead(childRoomIds(of:))`; divider; "Leave
  Space…" (destructive, opens confirmation dialog).
- **"+"**: opens the New Space sheet (`appState.newChatSheet = .space`).

---

## 3. Space/Home switcher & menus

The header title reads the selected space's name, or **"Home"** when none.
A menu (iOS header / macOS toolbar popover + context menu) offers:

**In a space:**
- Join Room… (opens join sheet)
- Invite People… — only if `canInvite(toRoomId: spaceId)` (async-primed cache)
- Space Settings…
- Refresh Rooms → `selectSpace(spaceId)` (re-crawls children)
- Mark All as Read → `markRead(childRoomIds(of: spaceId))`
- Leave Space… (destructive → confirmation)

**On Home:**
- Join Room…
- Mark All as Read → `markRead(homeRoomIds)`

**"New" menu:**
- In a space: New Room…, New Video Room… (both scoped to `spaceId`).
- On Home: New Message…, New Room…, New Video Room… (`spaceId: nil`).

---

## 4. Room rows

### 4.1 Row content (`RoomRow`)
- **Avatar** (`RoomAvatarView`, 28pt): circular image via media loader, falling back
  to **colored initials**. Initials = first letters of up to 2 words of the name
  (stripping leading `#@!+ `), uppercased, `?` if empty. Background color chosen by
  a deterministic hash of the name over an 8-color palette
  (blue, indigo, purple, pink, red, orange, teal, green).
  - **Synchronous cache hit** (`cachedThumbnail`) so recycled rows show the avatar
    on the first frame instead of flashing initials; async `avatar()` load follows.
  - Requested pixel size = `size * 2`.
  - **Presence indicator** overlaid for DMs (keyed by `dmUserId`, 9pt dot).
- **Name**: bold (`.semibold`) when unread, regular otherwise. Selected rows count
  as unread (stay bright). **[platform]** iOS selected rows render name white on the
  accent fill; macOS uses native list highlight (semantic colors).
  Weight change animates (`easeOut 0.15`).
- **Inline glyphs** after the name:
  - `video.fill` if `isVideoRoom`; **green** if `hasActiveCall`, else tertiary.
    Tooltip/a11y: "Video room" / "Video room — call in progress".
  - `lock.fill` if `isEncrypted`. Tooltip/a11y "End-to-end encrypted".
- **Timestamp** (trailing, baseline-aligned): `lastActivity` formatted relative —
  **today → time (H:M)**, **earlier → "MMM d"**. Monospaced digits; capped at
  Dynamic Type xxxLarge so it can't crowd the name; `fixedSize`, `layoutPriority 1`.
- **Call participants strip** (`CallParticipantsStrip`): if `hasActiveCall` and
  `callParticipantIds` non-empty, a Discord-style row of overlapping avatars
  (−6pt spacing, up to 5, then "+N"). Uses profile cache for names/avatars.
- **Preview line** (`previewText`): 2 lines max, truncating tail. Format:
  - own message → `"You: <preview>"`
  - has sender → `"<sender>: <preview>"`
  - else (e.g. invitation) → bare preview.
  Dim (`subtitle`/`tertiary`) vs bright by unread state.
- **Unread badge** (trailing of preview line): shown when `room.hasUnread`
  (notification-level). Capsule with `String(badgeCount)`, monospaced,
  numeric-text content transition, scale+opacity transition. **Red capsule** for a
  real mention (`isMentioned`), otherwise the accent tint capsule. Badge count uses
  `.numericText()` transition; whole row springs on `badgeCount` change.

### 4.2 Unread semantics (`RoomSummary`) — critical, replicate exactly
Fields: `unreadMessages`, `unreadNotifications`, `unreadMentions`, `isMarkedUnread`,
`isMuted`.
- `hasUnread` (bold + capsule): muted → `unreadMentions > 0`; else
  `unreadNotifications > 0 || unreadMentions > 0 || isMarkedUnread`.
- `hasAnyUnread` (dim "unread, no notification" state, drives rail pips):
  `hasUnread || (!isMuted && unreadMessages > 0)`.
- `isMentioned`: `unreadMentions > 0` (shown even when muted).
- `badgeCount` (capsule number **and** dock/app badge contribution):
  `isMuted ? unreadMentions : unreadNotifications`.
- **Muted rooms** contribute only real mentions everywhere (no pip, no capsule, no
  dock count) unless a mention is present.

### 4.3 Row accessibility
- Whole row combines into one a11y element; avatar is `accessibilityHidden`.
- A11y **value** announces unread state (font weight is invisible to VoiceOver):
  `"<n> mentions"` if mentioned, else `"<badgeCount> unread"`, else `"Unread"` if
  `hasAnyUnread`, else empty.

### 4.4 Row interaction
- Tap → `selection = room.id` (a real Button for touch-down highlight + VoiceOver
  button trait).
- **[platform]** macOS: `List(selection:)` binding so ↑/↓ move through and open
  rooms. Selection highlight comes from the native list; custom fill stays clear.
  iOS: untracked list, custom accent-fill selection background (gray 0.35 when the
  window is inactive).
- **[platform]** macOS: `dropDestination(for: ComposerDropItem.self)` — dropping a
  file/image onto a row **stages it in that room's composer and opens the room**.
  iOS has no swipe actions on rows (horizontal swipes belong to the chat pager).
- **Context menu** (`roomContextMenu`), built synchronously:
  - Room Settings…
  - Invite People… — only if `canInvite(toRoomId:)` (async-primed, fail-closed)
  - Mark as Read → `markRead([room.id])`
  - divider
  - **Spaces submenu** — only if `!isDirect && moveableRoomIds.contains(id)` (needs
    `m.space.parent` power in the room). Lists only `manageableSpaces` (spaces whose
    child list the user can edit — `m.space.child` power). Each space toggles
    membership (`toggleRoom(id, inSpace:)`), checkmark for current members. Shows
    "No Spaces Yet" / "No Spaces You Can Edit" (disabled) when none.
  - Leave Room… / Leave Chat… (destructive → confirmation dialog).

---

## 5. Sections, filtering, ordering

### 5.1 Ordering
Every list is sorted by `lastActivity` **descending**
(`(a.lastActivity ?? .distantPast) > (b.lastActivity ?? .distantPast)`). There are
**no favourites / low-priority / offline sections** rendered as separate groups —
`isFavourite`/`isLowPriority` are captured on the model (and persisted) but the
sidebar does **not** currently split by them. All joined rooms + DMs appear in one
activity-sorted list. (Web parity: single activity-sorted list; keep the
favourite/low-priority flags available for a future grouping toggle.)

### 5.2 Which rooms are visible (`visibleRooms`)
Filter, in order:
1. Exclude `isSpace` and `isInvited`.
2. If a search query is active, keep only rooms whose `foldedName` contains the
   folded query (name-only; see §6).
3. **Space selected** (`visibleRoomIds != nil`): keep rooms whose id ∈
   `visibleRoomIds` (that space's joined, non-space children).
4. **Home** (`visibleRoomIds == nil`): keep DMs always (`isDirect`), plus rooms not
   filed in **any** space (`!allSpaceChildIds.contains(id)`).

### 5.3 Sections rendered (top → bottom, `listContent`)
1. **Space banner** (if the space has one) — tappable, opens Space Home sheet.
2. **Verify-this-session** prompt (if `scope.needsVerification`).
3. **Sync banner** (offline/error) and transient **action error** (join/leave/invite
   failures, auto-cleared ~6s).
4. **[platform]** macOS "Updating…" quiet row while catching up.
5. **"Search messages for '<q>'"** button (when a query is present) → opens the
   full-text `SearchResultsSheet`.
6. **Spaces** section (search only) — spaces whose name matches the query; tapping
   jumps to that space (`selectSpace`) and clears search.
7. **Invites** section — see §8.
8. **Rooms/DMs** — the sorted `visibleRooms`.
9. **More Rooms** section — see §7 (unjoined rooms the space advertises).

### 5.4 Empty / loading state
- If `visibleRooms` empty and `isLoaded`: `ContentUnavailableView`
  ("No Rooms" — "Join a room to get started." on Home, "This space has no rooms
  you've joined." in a space).
- If not loaded yet: `ProgressView("Syncing…")`.

---

## 6. Search-in-list

- `searchQuery` (raw text) → **debounced** to `debouncedQuery` by ~150ms; clearing
  skips the debounce (immediate).
- Filtering is **name-only**, using `RoomSummary.foldedForSearch` (case- and
  diacritic-insensitive folding, current locale). Both the room's `foldedName`
  (maintained via `didSet`) and the query are folded so comparisons line up.
- Search also matches **spaces** (jump target) and **unjoined space directory rows**.
- **Enter / the "Search messages" row** escalates to full-text message search
  (`SearchResultsSheet`) — out of scope for this slice but the entry point lives
  here.
- **[platform]** iOS adds `.textInputAutocapitalization(.never)`,
  autocorrection off, `.search` submit label. `⌘⇧F` (macOS/iPad) focuses the field
  via `appState.sidebarFilterFocusRequest`.
- **Web**: same 150ms debounce; fold with an equivalent normalize
  (`.normalize("NFD").replace(/\p{Diacritic}/gu,"").toLowerCase()`).

---

## 7. Space directory ("More Rooms") + joining

- When a space is selected, `unjoinedSpaceRooms` = that space's `spaceChildren`
  filtered to `!isSpace && !isJoined` (and matching the search query).
- `SpaceDirectoryRow`: avatar, name, `video.fill` if video room, subtitle = topic
  or `"<n> members"`, and a **Join** button (spinner while `joiningRoomIds`
  contains the id).
- Join → `joinSpaceChild(child)` → `client.joinRoomByIdOrAlias(id, serverNames: via)`,
  then reloads the space children so the row flips to joined; selects the room.
  Guarded against double-join by `joiningRoomIds`.

---

## 8. Invites

- Invites are **account-level, not space-level** — they show in **every** space and
  on Home (`invites = rooms.filter(\.isInvited)`).
- `InviteRow`: avatar, bold name, a "Space" capsule badge if `isSpace`, subtitle
  `"<inviter> invited you"` or `"You've been invited"` (from
  `RoomSummary.inviterName`, resolved async via `room.inviter()`), and two circular
  action badges: **decline** (red ✕) and **accept** (green ✓). While accepting
  (`joiningInviteIds`), the accept badge becomes a spinner and both buttons disable.
- Accept → `acceptInvite(roomId:)` → `room.join()`; the diff stream flips the row
  to joined. Non-space invites auto-select the room after accepting.
- Decline → `leave(roomId:)`.

---

## 9. Space Home sheet (`SpaceHomeView`)

Opened by tapping the space banner in the list. Shows:
- Banner image (150pt) if set.
- Space avatar (56pt) + name.
- **Bio** = the space's `topic`, rendered (markdown via `RenderedBodyCache`),
  selectable; "No description." if empty.
- **Banner editing** (only if `scope.canEditSpaceBanner`): Add/Change/Remove banner.
  - Banner is the Commet state event `page.codeberg.everypizza.room.banner`, url in
    `content["url"]` (mxc). Fetched lazily via `spaceBannerURL(forSpace:)` /
    `stateEventContent`. Set via `scope.setSpaceBanner`, cleared via
    `removeSpaceBanner`. Status line reports success/permission errors.
- **[platform]** iOS: `NavigationStack` sheet with medium/large detents + drag
  indicator; image pick via PhotosPicker. macOS: fixed 460×480 panel with a close
  button; image pick via `fileImporter`.

---

## 10. Data flow

### 10.1 Startup (`RoomListViewModel.start`)
1. `restoreSnapshot()` paints the last run's sidebar **before** sync produces
   anything (see §11).
2. `service.startSync()` — builds the SDK `SyncService` with `.withOfflineMode()`
   and **`.withRoomListTimelineLimit(limit: 1)`** (so the room-list sync returns each
   room's latest event → sidebar previews populate **without** subscribing every
   room). `roomListService = sync.roomListService()`.
3. `roomListService.allRooms()` → a `RoomList`.
4. `roomList.entriesWithDynamicAdapters(pageSize: 200, listener:)` → a controller +
   an entries stream. `controller.setFilter(kind: .all(filters: [.nonLeft,
   .deduplicateVersions]))` — hide left rooms; after a room upgrade hide the
   tombstoned room, show its replacement.
5. `roomList.loadingState(listener:)` → drives `isLoaded` (`.loaded`).
6. **Retention**: the `roomList`, entries bridge, adapter result, controller,
   entries stream, loading bridge & handle are all kept in `retained` — dropping any
   silently cancels the subscription. Web equivalent: keep references to the
   subscription handles for the lifetime of the sidebar.
7. Sync-state stream → `syncBanner` / `isReconnecting`. `.offline` →
   "Offline — reconnecting…"; `.error` → "Sync error — retrying…"; on recovery,
   re-enable all send queues. Republish only on change.
8. `startSpaces()` (see §10.4).
9. On failure: schedule a retry in 10s (de-facto backoff loop); `hasStarted`
   re-entrancy guard prevents double-subscribe.

### 10.2 Diff application (`apply([RoomListEntriesUpdate])`)
The entries stream is **positional**. `rooms` (value-type `RoomSummary`) and
`ffiRooms` (`[Room]`) are kept **index-aligned** and mutate in lockstep. Diff kinds
handled: `append, clear, pushFront, pushBack, popFront, popBack, insert(index),
set(index), remove(index), truncate(length), reset(values)`.
- `set`/`reset` **carry over the existing populated summary by id** so the row
  doesn't blank/re-sort while details reload.
- Snapshot placeholders have no FFI backing: the first diff batch either starts with
  a `.reset` (replaces wholesale) or the restored `rooms` are cleared first, or
  `rooms`/`ffiRooms` diverge.
- After every batch: `rebuildRoomIndex()` (id → index dict), `updateDockBadge()`,
  `recomputeUnreadFlags()`, `scheduleSnapshotWrite()`.

### 10.3 Detail population (`refreshDetails(of: Room)`)
For each added/`set` room, asynchronously:
- `room.roomInfo()` → `RoomInfo` → `summary.update(from: info)` (name, avatar, topic,
  isDirect/isDm, isSpace, encryption, the three unread counts, isMarkedUnread, mute
  mode, favourite, low-priority, active call + participants, DM hero, membership).
- `room.latestEvent()` → `LatestEventValue` → `summary.update(from: latest)` (last
  activity timestamp, preview text, is-own, sender name). Preview text mapping in
  `RoomSummary.previewText` (message/reply-with-↩/sticker/poll/redacted/encrypted;
  state & membership events → nil).
- If invited and no inviter name → `room.inviter()`.
- If the room is the active (on-screen) room and app is active, force unreads to 0
  locally (avoid a flicker between a new message and its receipt).
- Result is **enqueued** for a **batched** publish.

### 10.4 Batched publication (`enqueue` / `flushPendingSummaries`)
- Updated summaries queue by id; a drain task flushes **~every 100ms** while work
  exists, applying all pending in **one** `rooms` mutation (publishing one at a time
  re-rendered the whole sidebar per room). Indexes re-resolved by id (rows may have
  moved). No-op summaries are skipped (churn was swallowing menu clicks).
- Each flush also: `updateDockBadge`, `recomputeUnreadFlags`, `scheduleSnapshotWrite`,
  and notifies (`NotificationManager.maybeNotify` / `maybeNotifyCall` /
  `maybeNotifyInvite`) per changed room. **[platform]** iOS also mirrors room→space
  names to the App Group for the push NSE.

### 10.5 Spaces data flow (`startSpaces`)
- `client.spaceService()` → `SpaceService`.
- `service.subscribeToTopLevelJoinedSpaces(listener:)` → `[SpaceListUpdate]` diff
  stream (same diff-kind vocabulary as room entries; `applySpaceDiffs`), applied
  positionally to `spaces`. Initial fill via `service.topLevelJoinedSpaces()`.
- Each `SpaceRoom` → `SpaceItem { id, name, avatarURL, topic }`.
- If the selected space disappears from `spaces` → fall back to Home.
- **Child listings** (`loadSpaceChildren(spaceId:)`):
  - `spaceService.spaceRoomList(spaceId:)` → `SpaceRoomList` (retained per space).
  - **Drive pagination to completion**: loop on `list.paginationState()` —
    `.idle(endReached)` → `paginate()` until `endReached`; `.loading` → sleep 50ms.
    Guard-capped at 200 iterations.
  - `list.rooms()` → `[SpaceRoom]` (children, joined or not).
  - Video-room type isn't in the space listing → cross-reference
    `service.videoRoomIds(inSpace:)` (REST hierarchy call, see §12).
  - Produces `SpaceChild { id, name, isSpace, isVideoRoom, avatarURL, topic,
    memberCount, isJoined, via }`.
  - Updates `spaceChildIds[spaceId]` (Set) and `spaceChildren[spaceId]` (full list),
    equality-guarded; rebuilds `allSpaceChildIds` (union — anything filed in a space
    is hidden from Home).
- `refreshAllSpaceChildren()` crawls every space (deduped by a flag); triggered on
  start, on pull-to-refresh (Home), and **coalesced** ~2s after the last space diff
  (`scheduleSpaceChildrenRefresh`).

### 10.6 Selecting a space (`selectSpace`)
- `nil` → Home: `visibleRoomIds = nil`.
- A space: optimistically show the cached child set (or empty) so the previous
  space's rooms don't linger, then `loadSpaceChildren` and set `visibleRoomIds` to
  the joined non-space children. A failed load keeps the cached/empty set (don't
  blank a snapshot-restored space). Guarded against a stale async result if the
  selection changed mid-load.

### 10.7 Filing rooms into spaces
- `toggleRoom(id, inSpace:)` → `removeChildFromSpace` (if present) or `fileRoom`.
- `fileRoom` → `addChildToSpace(childId:spaceId:)`, **retried up to 10×** (a
  just-created room takes a sync round-trip to exist locally). Updates local
  `spaceChildIds` optimistically.
- Permission gates (all **fail-closed**, async-primed, cached):
  - `refreshInvitePermission` → `getPowerLevels().canOwnUserInvite()` →
    `invitableRoomIds`.
  - `refreshSpaceManagePermission` → `canOwnUserSendState(.spaceChild)` →
    `manageableSpaceIds`.
  - `refreshMovePermission` → `canOwnUserSendState(.spaceParent)` →
    `moveableRoomIds`.

### 10.8 Read state
- `activeRoomId` (the open room) clears its unreads **locally** the moment it's
  selected and while on screen (waiting for the server echo makes pips lag/flicker).
- `markRead(roomIds:)` → `clearUnreadLocally` (zero the three counts + `isMarkedUnread`
  in `rooms` **and** any pending summaries; clear delivered notifications; recompute
  rail flags + dock badge) then, per room, `room.markAsRead(receiptType: .read)` and
  `room.setUnreadFlag(newValue: false)`.
- `updateDockBadge` sums `badgeCount` across all rooms → `unreadTotal`
  (per-account; AppState sums scopes for the app badge).

### 10.9 Leaving
- `leave(roomId:)` → `room.leave()`; if it was the selected space, fall back to Home.
  Errors surface as a transient action error.

---

## 11. Cold-launch snapshot (instant sidebar)

- **File**: `Application Support/<sanitized-userId>/roomlist-snapshot.json`. User id
  sanitized to `[A-Za-z0-9.-]`, others → `_`.
- **Shape** (`RoomListSnapshot`): `rooms: [RoomSummary]`, `spaces: [{id,name,avatarURL}]`,
  `spaceChildIds: [String: Set<String>]`. Holds only state `RoomSummary` already has
  — **never decrypted timeline content** beyond the preview line it already stores.
- **RoomSummary Codable**: `foldedName` is **omitted and recomputed on decode**
  (folding is locale-sensitive; a persisted value could go stale). `isMuted`,
  `isFavourite`, `isLowPriority` are `decodeIfPresent` (tolerate older snapshots).
- **Restore** (`restoreSnapshot`): guarded on `rooms.isEmpty`. Paints rows +
  spaces + spaceChildIds immediately (`isShowingRestoredSnapshot = true`), rebuilds
  index + unread flags, and **prewarms avatars** in the background
  (`prewarmAvatars(avatarURLs)` — bulk-loads disk-cached thumbnails so the first
  frame has them). `primeSnapshotForLaunch()` runs before the window mounts;
  idempotent with `start()`.
- **First diff supersedes**: `isShowingRestoredSnapshot` cleared on first batch (see
  §10.2). While restored, `isCatchingUp = (!isLoaded && !rooms.isEmpty)` drives an
  "Updating…"/"Catching up" indicator.
- **Write** (`scheduleSnapshotWrite`): trailing-debounced ~2s after the last change,
  **capped at 30s** under continuous churn. Skipped while showing restored rows.
  Encode + write happen **off-main** (`Task.detached`); the file is
  `isExcludedFromBackup`. **[platform]** iOS writes with
  `.completeFileProtectionUntilFirstUserAuthentication` (preview lines are plaintext
  metadata).
- **Delete** on logout (`removeSnapshot`) — removes the file and its per-account dir.

---

## 12. MatrixRustSDK FFI symbol catalog (flat, exhaustive)

> Everything the sidebar slice touches. The value-type mapping lives in
> `RoomSummary+FFI.swift`; the "only place outside Core importing MatrixRustSDK" for
> models. Symbols are grouped only for readability — treat as one flat list.

### Client / sync bootstrap
- `Client.syncService()` → `SyncServiceBuilder`
- `SyncServiceBuilder.withOfflineMode()` → `SyncServiceBuilder`
- `SyncServiceBuilder.withRoomListTimelineLimit(limit:)` → `SyncServiceBuilder`  *(limit: 1 — the source of sidebar previews)*
- `SyncServiceBuilder.finish()` → `SyncService`
- `SyncService.roomListService()` → `RoomListService`
- `SyncService.state(listener:)` → `TaskHandle`  *(listener: `SyncServiceStateObserver`)*
- `SyncService.start()`
- `SyncServiceState` enum: `.running`, `.idle`, `.terminated`, `.offline`, `.error`
- `SyncServiceStateObserver` (protocol) — `onUpdate(state:)`
- `Client.enableAllSendQueues(enable:)`
- `Client.subscribeToSendQueueStatus(listener:)` → `TaskHandle` *(sidebar-adjacent; drives send-queue re-enable)*
- `SendQueueRoomErrorListener` — `onError(roomId:error:)`
- `Client.session()` → `Session` (`.homeserverUrl`, `.accessToken`) *(for the REST hierarchy call)*
- `ClientError`

### Room list
- `RoomListService.allRooms()` → `RoomList`
- `RoomList.entriesWithDynamicAdapters(pageSize:listener:)` → `RoomListEntriesWithDynamicAdaptersResult`
  - `.controller()` → `RoomListDynamicEntriesController`
  - `.entriesStream()` → `TaskHandle` (retained)
- `RoomListEntriesListener` (protocol) — `onUpdate(roomEntriesUpdate: [RoomListEntriesUpdate])`
- `RoomListDynamicEntriesController.setFilter(kind:)` → `Bool`
- `RoomListEntriesDynamicFilterKind.all(filters:)`
- `RoomListEntriesDynamicFilterKind` filter cases used: `.nonLeft`, `.deduplicateVersions`
- `RoomList.loadingState(listener:)` → `RoomListLoadingStateResult` (retained)
- `RoomListLoadingStateListener` (protocol) — `onUpdate(state:)`
- `RoomListLoadingState` enum: `.loading`, `.loaded` *(only `.loaded` is acted on)*
- `RoomListEntriesUpdate` enum: `.append(values)`, `.clear`, `.pushFront(value)`,
  `.pushBack(value)`, `.popFront`, `.popBack`, `.insert(index,value)`,
  `.set(index,value)`, `.remove(index)`, `.truncate(length)`, `.reset(values)`
  *(values/value are `Room`)*

### Room (per-entry)
- `Room.id()` → String
- `Room.displayName()` → String?
- `Room.avatarUrl()` → String?
- `Room.topic()` → String?
- `Room.roomInfo()` → `RoomInfo` (async, throwing)
- `Room.latestEvent()` → `LatestEventValue`
- `Room.inviter()` → `RoomMember?` (`.displayName`, `.userId`)
- `Room.join()`
- `Room.leave()`
- `Room.markAsRead(receiptType:)` — `ReceiptType.read`
- `Room.setUnreadFlag(newValue:)`
- `Room.getPowerLevels()` → `RoomPowerLevels`
- `RoomPowerLevels.canOwnUserInvite()` → Bool
- `RoomPowerLevels.canOwnUserSendState(stateEvent:)` → Bool
  — `StateEventType.spaceChild`, `StateEventType.spaceParent`
- `Client.getRoom(roomId:)` → `Room?` *(fallback lookup for permission checks)*
- `Client.joinRoomByIdOrAlias(roomIdOrAlias:serverNames:)` → `Room`

### RoomInfo fields (→ RoomSummary)
- `RoomInfo.displayName`, `.canonicalAlias`, `.avatarUrl`, `.topic`
- `RoomInfo.isDm`, `.isDirect`, `.isSpace`
- `RoomInfo.encryptionState` (`EncryptionState.encrypted`)
- `RoomInfo.numUnreadMessages`, `.numUnreadNotifications`, `.numUnreadMentions`
- `RoomInfo.isMarkedUnread`
- `RoomInfo.cachedUserDefinedNotificationMode` (`RoomNotificationMode.mute`)
- `RoomInfo.isFavourite`, `.isLowPriority`
- `RoomInfo.hasRoomCall`, `.activeRoomCallParticipants`
- `RoomInfo.heroes` (`[RoomHero]`, `.userId`)
- `RoomInfo.membership` (`Membership.invited`)
- `RoomInfoListener` — `call(roomInfo:)` *(bridge exists; not used by the sidebar directly)*

### Latest event / timeline content (preview)
- `LatestEventValue` enum: `.remote(timestamp,sender,isOwn,profile,content)`,
  `.local(timestamp,_,_,content,_)`, `.remoteInvite(timestamp,_,_)`, `.none`
- `ProfileDetails.ready(displayName,_,_)` *(sender display name)*
- `TimelineItemContent` enum: `.msgLike(MsgLikeContent)`, `.roomMembership`,
  `.profileChange`, `.state`, (others → nil)
- `MsgLikeContent.kind`: `.message(Message)`, `.sticker(body,_,_)`,
  `.poll(question,…)`, `.redacted`, (default → "Encrypted message")
- `MsgLikeContent.inReplyTo` *(reply detection for the ↩ preview)*
- `Message.body`
- `RoomType` enum: `.space`, `.custom(String)` *(video-room detection:
  `"io.element.video"`, `"org.matrix.msc3417.call"`)*

### Spaces
- `Client.spaceService()` → `SpaceService`
- `SpaceService.subscribeToTopLevelJoinedSpaces(listener:)` → `TaskHandle`
- `SpaceServiceJoinedSpacesListener` — `onUpdate(roomUpdates: [SpaceListUpdate])`
- `SpaceService.topLevelJoinedSpaces()` → `[SpaceRoom]`
- `SpaceService.spaceRoomList(spaceId:)` → `SpaceRoomList`
- `SpaceService.addChildToSpace(childId:spaceId:)`
- `SpaceService.removeChildFromSpace(childId:spaceId:)`
- `SpaceListUpdate` enum: `.append(values)`, `.clear`, `.pushFront(value)`,
  `.pushBack(value)`, `.popFront`, `.popBack`, `.insert(index,value)`,
  `.set(index,value)`, `.remove(index)`, `.truncate(length)`, `.reset(values)`
  *(values/value are `SpaceRoom`)*
- `SpaceRoomList.paginationState()` → `SpaceRoomListPaginationState`
  (`.idle(endReached: Bool)`, `.loading`)
- `SpaceRoomList.paginate()`
- `SpaceRoomList.rooms()` → `[SpaceRoom]`
- `SpaceRoom` fields: `.roomId`, `.displayName`, `.avatarUrl`, `.topic`,
  `.roomType` (`RoomType`), `.numJoinedMembers`, `.state` (`.joined`), `.via`

### Media (avatars/banners)
- `MediaSource.fromUrl(url:)` → `MediaSource` (wrapped as `MediaSourceBox`)
  *(sidebar avatar cache-key parity)*

### REST (not FFI, but part of the flow)
- `GET _matrix/client/v1/rooms/<spaceId>/hierarchy?limit=200` — Bearer auth from
  `Client.session()`; used to detect video rooms among a space's children because
  the SDK space listing reports plain `room` for `m.room.create` types.

### State events (custom, via `service.stateEventContent`)
- `page.codeberg.everypizza.room.banner` (`content["url"]` = space banner mxc).

---

## 13. Web implementation mapping

- **SDK**: `matrix-js-sdk` (or a Rust-SDK WASM binding). The native app leans on the
  Rust SDK's `RoomListService` + dynamic-adapter diff stream; `matrix-js-sdk` has no
  1:1 equivalent, so the web side must synthesize an equivalent value-type
  `RoomSummary` from `Room` objects and re-emit a diff/patch stream (e.g. an
  immutable `Map<roomId, RoomSummary>` with structural sharing, or a reducer over
  `Room.timeline`/`RoomState`/`accountData` events).
- **Ordering**: sort by last-activity timestamp descending; recompute on any room
  update. Keep the space-filed exclusion (`allSpaceChildIds` union) for Home.
- **Unread accounting**: replicate `RoomSummary`'s `hasUnread`/`hasAnyUnread`/
  `badgeCount`/`isMentioned` **exactly** (muted-room rules included). Drive both the
  row capsule and the rail pip/mention dot from the same derived flags.
- **Snapshot persistence**: mirror `RoomListSnapshot` into **IndexedDB** (preferred
  for size; localStorage acceptable for small lists) keyed by user id; paint from it
  **before** the first sync response. Omit `foldedName`; recompute on load. Debounce
  writes ~2s, cap ~30s. Never store decrypted content beyond the preview line.
- **Virtualization**: the list can be long — use a windowed/virtualized list
  (e.g. `@tanstack/react-virtual`) with stable keys = `room.id`. Keep the sync
  cache-hit-first avatar pattern (§4.1) so recycled rows don't flash initials.
- **Avatar prewarming**: on snapshot restore, kick off background thumbnail fetches
  for all restored room+space avatar URLs (mirror `prewarmAvatars`). Use an
  in-memory + Cache Storage layer keyed the same way for sync cache hits.
- **Rail order**: `localStorage["spaceOrder:<userId>"]`; unknown → end.
- **Debounces to replicate**: search 150ms, summary flush 100ms, snapshot 2s/30s,
  space-children refresh 2s coalesce, action-error auto-clear 6s, sync-error restart
  bounce 250ms, start-retry 10s.
- **Fail-closed permissions**: gate Invite / move-to-space / manage-space menu items
  behind async power-level checks; hide until confirmed.

---

## 14. Parity checklist (acceptance criteria)

**Rail**
- [ ] Home button (envelope glyph) + one avatar per top-level joined space + "+".
- [ ] Selected slot shows a tall leading pill; unread (unselected) shows a short
      leading pip; a mention shows a red bottom-trailing dot.
- [ ] Rail unread/mention flags derive from `hasAnyUnread`/`isMentioned` and update
      only when a flag flips (no per-render O(rooms) scan).
- [ ] Drag-reorder spaces; order persists per account; unknown spaces sort to end.
- [ ] Rail context menus: Home/Space "Mark All as Read"; Space "Leave".

**Room rows**
- [ ] Avatar with sync cache-hit-first load and colored-initials fallback (same hash
      palette); DM presence dot.
- [ ] Name bold when unread (or selected); video + lock glyphs; video glyph green
      during an active call.
- [ ] Timestamp: today→time, earlier→"MMM d", monospaced, capped growth.
- [ ] Preview: "You:"/"Sender:" prefix; reply preview marked ↩, sticker/poll/redacted
      handled; 2-line clamp.
- [ ] Unread capsule with `badgeCount`; red for mention, accent otherwise; hidden for
      muted rooms without a mention.
- [ ] Active-call participants strip (≤5 + "+N").
- [ ] Row a11y value announces mentions/unread.

**Sections & selection**
- [ ] Single activity-sorted list (favourite/low-priority flags captured, not yet
      grouped).
- [ ] Home shows DMs always + rooms not filed in any space; a space shows its joined
      non-space children.
- [ ] Invites section shown in every space + Home; accept/decline; "Space" badge;
      inviter name; accept auto-selects non-space rooms.
- [ ] "More Rooms" (unjoined space directory) with Join buttons + spinner.
- [ ] Space banner row → Space Home sheet.
- [ ] Empty state ("No Rooms" contextual) vs "Syncing…".

**Search**
- [ ] 150ms debounce; folded name-only match; instant clear.
- [ ] Matching spaces jump-to; "Search messages for '<q>'" escalation entry point.

**Spaces**
- [ ] Space/Home switcher menu with the full action set (§3).
- [ ] Child listing paginated to completion; video rooms cross-referenced via
      hierarchy.
- [ ] File/unfile room into space (retry on new rooms); optimistic local update.
- [ ] Selected-space fallback to Home when the space disappears/leaves.
- [ ] Permission gates fail closed (invite/manage/move).
- [ ] Space Home: banner + avatar + rendered topic; banner edit for admins.

**Unread / read**
- [ ] `badgeCount` sums into a per-account total (app/dock badge).
- [ ] Active room clears unread locally on select and stays cleared while open.
- [ ] Mark-as-read (single / all-in-space / all-Home) zeroes local flags + sends
      receipts + clears the unread flag.

**Cold-launch snapshot**
- [ ] Sidebar paints from snapshot before first sync response.
- [ ] Snapshot omits `foldedName` (recompute on load) and never stores decrypted
      content beyond the preview line.
- [ ] Debounced write (2s / 30s cap), off-main encode, deleted on logout.
- [ ] Avatar prewarming on restore.
- [ ] First real diff supersedes restored placeholders cleanly (no divergence).
