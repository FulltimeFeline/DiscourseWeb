# Parity Spec 06 — Settings & Profile

Audit of the native SwiftUI Discourse client's Settings and Profile surface, written as a build spec for the TypeScript/React + WASM `matrix-rust-sdk` web rewrite.

Source files audited:
- `Discourse/App/SettingsView.swift` — settings window, tab layout, ProfileEditSection, StickerMaker, iOS ProfileTabView
- `Discourse/Features/Settings/SettingsShell.swift` — Advanced + About
- `Discourse/Features/Settings/SettingsAppearance.swift` — Appearance + Chat
- `Discourse/Features/Settings/SettingsMedia.swift` — Notifications + Storage
- `Discourse/Features/Settings/SettingsPrivacy.swift` — Privacy + Accessibility
- `Discourse/Features/Settings/RoomSettingsSheet.swift` — per-room/space settings
- `Discourse/Features/Profile/ProfileSheet.swift` — other-user profile card
- `Discourse/Core/Preferences.swift` — persisted prefs
- `Discourse/Core/PronounsStore.swift` — profile cache
- `Discourse/Core/SpaceNameStore.swift` — App Group room→space name map
- `Discourse/Core/UsageTracker.swift` — reaction + sticker usage
- `Discourse/Core/MatrixService.swift` + `Discourse/App/AppState.swift` (SessionScope) — profile/state REST + FFI

> **Terminology.** "SessionScope" is the per-account model in `AppState.swift` (the `scope` passed everywhere). "service" is `MatrixService`; `service.client` is the FFI `Client`. Extended-profile writes are **direct REST** to the client-server API, *not* FFI — the SDK exposes no extended-profile setter.

---

## 1. Settings screens & controls

The settings surface is one window on macOS (a 10-item `TabView`, fixed 860×480) and a `NavigationStack` Form (`ProfileTabView`) on iOS. Same view structs back both. Tabs, in order:

**Account · Appearance · Chat · Privacy · Notifications · Accessibility · Storage · Stickers · Advanced · About**

(iOS groups them: identity card → Customization [Appearance, Chat, Accessibility, Storage, Stickers] → Privacy & Notifications → Accounts → Account info → Advanced/About → Sign Out.)

When signed out, only an Account tab showing "Sign in to see settings." is present.

### 1.1 Account (`accountTab` / `ProfileEditSection` / `ProfileTabView`)

The profile editor. All fields seed once from `scope.loadOwnProfile()` (guarded by a `loaded` flag so a later refresh doesn't clobber typing).

| Control | Type | Backing write | Notes |
|---|---|---|---|
| Avatar | 88px circle header | `scope.setAvatar(data,mime)` / `scope.removeAvatar()` | "Change Photo" always; "Remove" only when `ownAvatarURL != nil` |
| Banner | 96px-high image | `scope.setBanner(data,mime)` / `scope.removeBanner()` | "Add/Change Banner…"; Remove when set. Footer: "Shows at the top of your profile card." |
| Name | text field | `scope.setDisplayName(name)` | Non-empty required; only saved if changed |
| Pronouns | text field | `scope.setPronouns(value)` | placeholder "they/them" |
| Status | text field | `scope.setStatus(value)` | placeholder "What you're up to" |
| Bio | multiline (3–6 lines) | `scope.setBio(value)` | |
| Timezone | text field + "Use current" | `scope.setTimezone(value)` | "Use current" sets `TimeZone.current.identifier`; iOS uses a `location.circle` button |
| Social Links | repeatable rows | `scope.setSocialLinks([SocialLink])` | each row: Title, Link (https://…), Icon (emote picker → mxc, or unicode emoji), remove. "Add Link" appends |
| **Save Profile** | prominent button | `saveAll()` | disabled unless `hasChanges`; shows spinner; footer shows green success / red error |

**Save semantics (`saveAll`)** — one pass, each field written only if `norm(field) != current`:
- name → `setDisplayName` (skipped if empty)
- pronouns → `setPronouns`, status → `setStatus`, bio → `setBio`, timezone → `setTimezone`, links → `setSocialLinks`
- `hasChanges` compares trimmed values against `scope.own*`; social links compared as `[SocialLink]` equality.

**Social link editing detail:** the icon picker (`EmoteIconPicker`) presents the emoji/emote picker. A custom emote yields its `mxc://` URL; a unicode emoji yields the character string. `LinkIconPreview` renders mxc via media loader, unicode as text, else a `face.smiling` placeholder. `currentLinks` drops rows with an empty `link`, and defaults title to the link if title is blank.

**Account info section:** read-only `User ID`, `Homeserver` (`token.session.homeserverUrl`), `Device ID` (`token.session.deviceId`). **Sign Out…** (destructive, confirmation dialog "Sign out of {userId}?" / "Local session data is removed from this device." → `appState.logOut()`).

**iOS multi-account (`ProfileTabView` only):** an "Accounts" section lists `appState.accountTokens`, each a button that calls `appState.switchAccount(to:)`, checkmark on `activeUserId`; plus "Add Account…" → `appState.isAddAccountPresented = true`.

### 1.2 Appearance (`AppearanceSettingsView`)

| Control | Values | Pref key |
|---|---|---|
| Appearance (theme) | Automatic / Light / Dark (`AppearanceMode`) | `pref.appearance` |
| Accent Color | swatch grid: Default, Blue, Indigo, Purple, Pink, Red, Orange, Yellow, Green, Teal, Mint, Brown, Graphite (`AccentChoice`) | `pref.accentColor` |
| Message Density | Comfortable / Compact (`MessageDensity`) | `pref.messageDensity` |
| Chat Text Size | slider 0.8…1.4 step 0.05, live preview | `pref.chatFontScale` |
| Show avatars in timeline | toggle | `pref.showAvatarsInTimeline` |
| Colored sender names | toggle | `pref.coloredSenderNames` |

Density derives: comfortable = group top-pad 14 / row-pad 2; compact = 8 / 1. Font scale applies as a multiplier on top of Dynamic Type (base 17px).

### 1.3 Chat (`ChatSettingsView`)

| Control | Pref key | Default |
|---|---|---|
| Jumbo emoji | `pref.jumboEmoji` | true |
| 24-hour time | `pref.use24HourTime` | false |
| Always show timestamps | `pref.alwaysShowTimestamps` | false |
| Show read receipts | `pref.showReadReceipts` | true |

### 1.4 Privacy (`PrivacySettingsView`)

Each toggle gates a real outbound homeserver signal:

| Control | Pref key | Default | Effect |
|---|---|---|---|
| Send read receipts | `pref.sendReadReceipts` | true | suppress outbound `m.read` |
| Send typing notifications | `pref.sendTypingNotifications` | true | suppress typing |
| Share presence | `pref.sharePresence` | true | own online status |
| Warn in unencrypted rooms | `pref.warnUnencrypted` | true | composer banner |
| Remove location from photos | `pref.stripLocationMetadata` | true | strip GPS EXIF before send |

### 1.5 Notifications (`NotificationSettingsView`)

| Control | Values | Pref key | Default |
|---|---|---|---|
| Show in Notifications | Sender and Message / Sender Only / Nothing (`NotificationPreview`: `full`/`senderOnly`/`none`) | `pref.notificationPreview` | full |
| Play sound | toggle | `pref.notificationSound` | true |

These are local presentation prefs for the (native) push extension — **not** homeserver push rules. Per-room push mode lives in Room Settings (§1.11).

### 1.6 Accessibility (`AccessibilitySettingsView`)

| Control | Pref key | Default |
|---|---|---|
| Reduce motion | `pref.reduceTimelineMotion` | false |
| Larger tap targets | `pref.largerTapTargets` | false |
| Confirm before deleting messages | `pref.confirmBeforeDeleting` | false |
| Return key sends message (macOS only) | `pref.sendOnEnter` | true |

`Preferences.reduceMotion` = in-app OR system reduce-motion; `reduceTransparency` mirrors the system flag. System flags observed via accessibility notifications (web: `prefers-reduced-motion` / `prefers-reduced-transparency` media queries).

### 1.7 Storage (`StorageSettingsView`)

| Control | Backing |
|---|---|
| Auto-download images (toggle) | `pref.autoDownloadImages` (default true; stickers always load) |
| Image Cache (size readout) | `loader.totalDiskCacheSize()` → `.byteCount(.file)`; shows spinner while measuring |
| Clear Cache (destructive) | `loader.clearCache()`; disabled while clearing or when size 0; re-measures ~300ms later |

`totalDiskCacheSize` sums `.totalFileAllocatedSizeKey` over the disk cache dir. `clearCache` wipes memory NSCache + on-disk files + resets counters, then re-prepares the directory.

### 1.8 Stickers (`StickerMakerView`)

Not strictly settings but a settings tab. Pick image → cropped/scaled to 512px → uploaded → saved to the account-wide MSC2545 sticker pack (syncs to other Matrix clients). Fields: Choose/Change Image, Name, Pack (free text + menu of existing `store.packs`), Add Sticker (disabled until image + non-blank name). Existing stickers listed per pack with per-row delete (`store.remove(shortcode)`) and context-menu delete. Errors surface via `store.errorMessage` (non-throwing). macOS prefills name from filename.

### 1.9 Advanced (`AdvancedSettingsView`)

- **Session** (read-only, selectable): User ID, Homeserver, Device ID.
- **Developer:** "Show event IDs" toggle → `pref.showEventIds` (default false).
- **Reset All Settings** (destructive, confirmation) → `Preferences.shared.resetToDefaults()` — restores every pref to default; account/messages untouched.

### 1.10 About (`AboutSettingsView`)

App icon, "Discourse", "A Matrix client", "by FulltimeFeline"; Version (`CFBundleShortVersionString`) + Build (`kCFBundleVersionKey`), both selectable; links: Source on GitHub (`github.com/FulltimeFeline/Discourse`), matrix.org, spec.matrix.org.

### 1.11 Per-room / per-space settings (`RoomSettingsSheet`)

Modal. macOS: 760×560 sidebar+detail. iOS: `NavigationStack` root Form with drill-down. Backed by `RoomSettingsModel` (`@Observable`), loaded via `room.roomInfo()` + `room.getPowerLevels()` + notification settings + custom state reads.

**Tabs (rooms):** General, Security & Privacy, Roles & Permissions, Emoji & Stickers, Notifications, Poll History, Advanced.
**Tabs (spaces):** General, Visibility, Roles & Permissions, Emoji & Stickers, Advanced. (Security label becomes "Visibility"; no Notifications/Polls.)

**Permission gating** (resolved in `load()` from `canOwnUserSendState`; controls read-only until true, sheet shows spinner meanwhile):
- `canEditBasics` = name AND topic AND avatar state-send rights (grouped so a partial grant never fails mid-save)
- `canEnableEncryption` = `roomEncryption`
- `canEditAccess` = `roomJoinRules` AND `roomHistoryVisibility`
- `canEditAddresses` = `roomCanonicalAlias`
- `canEditRoles` = `roomPowerLevels`
- `canEditBanner` = space AND custom `page.codeberg.everypizza.room.banner` send right

**General tab:**
- Name + Topic/Description (editable if `canEditBasics`) → `saveNameAndTopic()`: `room.setName` / `room.setTopic` only for changed fields.
- Avatar 72px → Change (`room.uploadAvatar`) / Remove (`room.removeAvatar`). Avatar data is validated via `CGImageSource` and MIME inferred.
- **Space banner** (spaces only): `BannerImageView`; Add/Change/Remove gated by `canEditBanner`. Set → `scope.setSpaceBanner(spaceId,data,mime)` (uploads media then writes `page.codeberg.everypizza.room.banner` state `{url, mimetype}`); Remove → `scope.removeSpaceBanner` (empty state content). Read via `roomList.spaceBannerURL(forSpace:)`.
- **Room Addresses** (rooms only, `AddressesSection`): shows canonical alias; if `canEditAddresses`: set main address (`#name` → prefix `#`, append `:server` if missing → `publishRoomAliasInRoomDirectory` then `updateCanonicalAlias(alias, altAliases:)`), plus a "public room directory" toggle → `updateRoomVisibility(.public/.private)`.
- **Leave Room/Space** (destructive, confirmation) → `model.leaveRoom()` (`room.leave()`; for a space also `roomList.selectSpace(nil)`; dismisses sheet on success). *No forget-room action exists.*

**Security & Privacy (rooms) / Visibility (spaces):**
- Encryption (rooms): shows "End-to-end encrypted" (lock) if on; else if `canEnableEncryption` an **Enable Encryption…** button (confirmation: "This can't be undone…") → `room.enableEncryption()`; else "not encrypted". *There is no disable — encryption is one-way.*
- Access (join rule) picker: Private (invite only) / Space members (only if `parentSpaceIds` non-empty) / Anyone → `setJoinRule`: `.invite`, `.restricted(rules: parents.map{.roomMembership(roomId:)})`, `.public`.
- History visibility (rooms): Members (invited) / Members (joined) / Members (since selected = `.shared`) / Anyone (`.worldReadable`) → `setHistoryVisibility`. Spaces expose this as a single "Preview space" toggle (`.worldReadable` ↔ `.shared`).
- Spaces also show Space Addresses (same `AddressesSection`).

**Roles & Permissions (`RolesSettingsTab`):**
- Privileged users list: userId → role picker (Default 0 / Moderator 50 / Administrator 100 / Custom) → `setUserLevel(userId,level)` = `room.updatePowerLevelsForUsers([UserPowerLevelUpdate])`.
- Add privileged user: `@user:server` + role → same call (enabled once id starts with `@`).
- **Role labels** (`RoleLabelsEditor`, editors only): per power level a name/color/emoji, writing Cinny-compatible `in.cinny.room.power_level_tags` via `room.sendStateEventRaw`. Palette of 8 hex colors + "no color"; emoji via picker (mxc emote or unicode). Levels shown = {0,50,100} ∪ privileged levels ∪ existing tags. Default-equal tags are dropped on save.
- **Permissions grid** (`PermissionsGrid`): each row a required-role picker → `applyPermissions(RoomPowerLevelChanges(...))` = `room.applyPowerLevelChanges`. Rows: Default role (`usersDefault`), Send messages (`eventsDefault`), Invite users (`invite`), Change settings (`stateDefault`), Remove users (`kick`), Ban users (`ban`), Remove others' messages (`redact`), Change room/space name (`roomName`), avatar (`roomAvatar`), topic/description (`roomTopic`).

**Notifications tab (rooms):** mode picker Default / All messages / @mentions & keywords only / Off → `setNotificationMode` over `client.getNotificationSettings()`: `restoreDefaultRoomNotificationMode` / `setRoomNotificationMode(.allMessages | .mentionsAndKeywordsOnly | .mute)`. This is a personal push rule, intentionally **not** power-gated. Loaded via `getUserDefinedRoomNotificationMode`.

**Emoji & Stickers tab:** `EmotePackEditor` (own spec — MSC2545 room emote packs; out of scope here).

**Poll History tab:** read-only list of polls from the loaded timeline (`timeline.entries` → `.poll`), question + date + Ended/Active + vote count. Materializes and then parks the timeline VM on exit if the room isn't active.

**Advanced tab:** Internal room/space ID (selectable + copy), Room version, Members count.

**Member management (kick/ban)** lives in the timeline member list, not this sheet: `TimelineViewModel.kick` = `room.kickUser(userId, reason:nil)`, `.ban` = `room.banUser(userId, reason:nil)`, each reloading members. Invite = `room.inviteUserById(userId)` (from compose). Members loaded via `room.members()`.

### 1.12 Preferences — full persisted-key catalog

All in `UserDefaults.standard`, key prefix `pref.`, observed app-wide (`@Observable`). Enums store their `String` rawValue.

| Property | Key | Type | Default |
|---|---|---|---|
| `appearance` | `pref.appearance` | AppearanceMode (`system`/`light`/`dark`) | `system` |
| `accentColor` | `pref.accentColor` | AccentChoice (13 cases) | `system` |
| `messageDensity` | `pref.messageDensity` | MessageDensity (`comfortable`/`compact`) | `comfortable` |
| `use24HourTime` | `pref.use24HourTime` | Bool | false |
| `coloredSenderNames` | `pref.coloredSenderNames` | Bool | true |
| `showAvatarsInTimeline` | `pref.showAvatarsInTimeline` | Bool | true |
| `chatFontScale` | `pref.chatFontScale` | Double (0.8–1.4) | 1.0 |
| `jumboEmoji` | `pref.jumboEmoji` | Bool | true |
| `animatedEmotes` | `pref.animatedEmotes` | Bool | true |
| `showReadReceipts` | `pref.showReadReceipts` | Bool | true |
| `showTypingIndicators` | `pref.showTypingIndicators` | Bool | true |
| `groupingWindowMinutes` | `pref.groupingWindowMinutes` | Int | 5 |
| `sendOnEnter` | `pref.sendOnEnter` | Bool | true |
| `confirmBeforeDeleting` | `pref.confirmBeforeDeleting` | Bool | false |
| `sendMessageHaptic` | `pref.sendMessageHaptic` | Bool | true |
| `warnUnencrypted` | `pref.warnUnencrypted` | Bool | true |
| `sendReadReceipts` | `pref.sendReadReceipts` | Bool | true |
| `sendTypingNotifications` | `pref.sendTypingNotifications` | Bool | true |
| `sharePresence` | `pref.sharePresence` | Bool | true |
| `stripLocationMetadata` | `pref.stripLocationMetadata` | Bool | true |
| `autoDownloadImages` | `pref.autoDownloadImages` | Bool | true |
| `notificationPreview` | `pref.notificationPreview` | NotificationPreview (`full`/`senderOnly`/`none`) | `full` |
| `notificationSound` | `pref.notificationSound` | Bool | true |
| `alwaysShowTimestamps` | `pref.alwaysShowTimestamps` | Bool | false |
| `reduceTimelineMotion` | `pref.reduceTimelineMotion` | Bool | false |
| `largerTapTargets` | `pref.largerTapTargets` | Bool | false |
| `showEventIds` | `pref.showEventIds` | Bool | false |

`resetToDefaults()` reassigns every one of the above. Some keys (`animatedEmotes`, `showTypingIndicators`, `groupingWindowMinutes`, `sendMessageHaptic`) are persisted here but have **no dedicated settings control** in the audited screens — surface them or keep defaults.

Derived (not persisted): `colorScheme`, `resolvedTint`, `groupingWindow` (min×60), `reduceMotion`, `reduceTransparency`.

### 1.13 Usage tracking (`UsageTracker.swift`)

Two `UserDefaults.standard` stores (no `pref.` prefix), feeding pickers, not the settings UI:
- `ReactionUsage` — key `reactionUsageCounts` (`[emoji: count]`). `record(emoji)` increments; `top(n)` returns most-used **emoji-only** keys (filters out text keys like "+1"), padded from defaults `["👍","❤️","😂","🎉","😮","😢","🔥","👀"]`.
- `StickerUsage` — key `recentStickers` (`[shortcode]`, most-recent-first, capped 16). `record(shortcode)` de-dupes and prepends; `recents` reads it.

### 1.14 Other stores

- `PronounsStore` — per-user profile cache keyed by userId (`ProfileInfo`). `ensure()` fetches once (a stored entry, even empty, blocks re-fetch). Accessors: `pronouns`, `avatarURL`, `displayName`, `bio`, `status`, `bannerURL`, `timezone`, `socialLinks`. `status(for:)` prefers **presence `status_msg`** when the user is known online/idle, hides it when known-offline, and falls back to the profile field when presence is unknown/disabled. `setLocal` / `invalidate` keep the local user's card fresh after an edit. (React: a query cache / SWR store keyed by userId.)
- `SpaceNameStore` — `[roomId: spaceName]` in the **App Group** UserDefaults (key `roomSpaceNames`), so the native push extension can title notifications. No web equivalent unless a service-worker push path needs it.

---

## 2. Profile sheet — viewing another user (`ProfileSheet`)

A compact profile card. iOS: banner header with avatar overlapping its bottom edge, then scrollable blocks, `.medium`/`.large` detents. macOS: 340-wide centered card.

Reads everything from `PronounsStore` (keyed by `target.userId`) plus `PresenceService`:

- **Banner** — `pronounsStore.bannerURL(for:)`; falls back to an accent gradient. (`BannerImageView` loads mxc at 700px.)
- **Avatar** — 92px (iOS) / 72px (macOS), ringed, with a presence indicator dot.
- **Display name + pronouns** — name (`target.displayName ?? userId`) with pronouns inline (`pronounsStore.pronouns`).
- **User ID** — selectable.
- **Status** — `pronounsStore.status(for:)` with a quote-bubble icon (presence-gated as above).
- **Presence detail** — `presence.detailText(of:)`, green when online.
- **Local time** — from `pronounsStore.timezone(for:)` (IANA `m.tz`); formatted "{time} local time ({abbrev})".
- **Bio** — `pronounsStore.bio(for:)`, boxed, selectable.
- **Social links** — `pronounsStore.socialLinks(for:)`; each `SocialLinkRow` opens `link` in the browser, shows an mxc/unicode/`link`-glyph icon. **http(s) icons are intentionally not fetched** (CSP / remote-fetch) — only mxc icons load.
- **Mutual Spaces / Mutual Rooms** — `service.mutualRooms(with:)` (MSC2666), resolved against `roomList.spaces` / non-DM `rooms`; each opens a "Mutual …" list that navigates to the room and dismisses.

**Actions:** **Message** (starts/opens a DM via the injected `message(userId)`, then dismiss; hidden for self) and **Copy User ID**.

> **Parity gap / note:** the audited `ProfileSheet` has **no Ignore/Block action** and **no forget-room action** anywhere in the codebase (`ignoreUser`/`setIgnoredUsers`/`forget` are unused). If the web app wants ignore/block, it is net-new; the FFI symbol would be `client.ignoreUser` / `client.unignoreUser` (see catalog), but the native app does not call them today. Do not claim parity for a feature the native app lacks — flag it as an addition.

---

## 3. Flat FFI / SDK symbol catalog (MatrixRustSDK)

Every `matrix-rust-sdk` FFI call reachable from the Settings/Profile surface. **Bold = has a WASM/JS binding to wire; italic notes = REST fallback, not FFI.** Grouped by receiver.

### Client (`service.client`)
- `client.displayName()` — read own display name
- `client.setDisplayName(name:)` — set own display name
- `client.avatarUrl()` — read own avatar mxc
- `client.uploadAvatar(mimeType:data:)` — upload + set own avatar
- `client.removeAvatar()` — clear own avatar
- `client.uploadMedia(mimeType:data:progressWatcher:)` — generic media upload → mxc (used for profile banner + space banner)
- `client.getNotificationSettings()` → NotificationSettings handle
- `client.encryption()` → Encryption handle
- `client.getSessionVerificationController()` → SessionVerificationController
- `client.session()` — access token / homeserver / deviceId (for REST auth)
- `client.getRoom(roomId:)` / `client.getPowerLevels()`-via-room (permission checks)
- `client.deviceId()` — own device id
- `client.logout()` — sign out (session teardown)

### Room (`room` = `scope.roomList.ffiRoom(withId:)`)
- `room.roomInfo()` — displayName, rawName, topic, avatarUrl, canonicalAlias, encryptionState, joinedMembersCount, roomVersion, joinRule, historyVisibility
- `room.displayName()` / `room.topic()` — current values for change-diffing
- `room.setName(name:)`
- `room.setTopic(topic:)`
- `room.uploadAvatar(mimeType:data:mediaInfo:)`
- `room.removeAvatar()`
- `room.getPowerLevels()` → RoomPowerLevels
- `room.updatePowerLevelsForUsers(updates:)` — `[UserPowerLevelUpdate(userId:powerLevel:)]`
- `room.applyPowerLevelChanges(changes:)` — `RoomPowerLevelChanges`
- `room.enableEncryption()`
- `room.updateJoinRules(newRule:)` — `JoinRule` (`.invite` / `.public` / `.restricted(rules:[.roomMembership(roomId:)])`)
- `room.updateHistoryVisibility(visibility:)` — `RoomHistoryVisibility` (`.invited`/`.joined`/`.shared`/`.worldReadable`)
- `room.getRoomVisibility()` / `room.updateRoomVisibility(visibility:)` — directory listing (`.public`/`.private`)
- `room.publishRoomAliasInRoomDirectory(alias:)`
- `room.updateCanonicalAlias(alias:altAliases:)`
- `room.alternativeAliases()`
- `room.sendStateEventRaw(eventType:stateKey:content:)` — writes `in.cinny.room.power_level_tags`
- `room.leave()`
- `room.members()` — member iterator (member list)
- `room.kickUser(userId:reason:)`
- `room.banUser(userId:reason:)`
- `room.inviteUserById(userId:)`
- `room.id()`

### RoomPowerLevels
- `levels.values()` → `RoomPowerLevelsValues` (usersDefault, eventsDefault, invite, stateDefault, kick, ban, redact, roomName, roomAvatar, roomTopic)
- `levels.userPowerLevels()` — `[userId: level]`
- `levels.canOwnUserSendState(stateEvent:)` — gating; `RoomPowerLevelUserRole`/`StateEventType` incl. `.roomName`, `.roomTopic`, `.roomAvatar`, `.roomEncryption`, `.roomJoinRules`, `.roomHistoryVisibility`, `.roomCanonicalAlias`, `.roomPowerLevels`, `.custom(value:)`

### NotificationSettings
- `settings.getUserDefinedRoomNotificationMode(roomId:)`
- `settings.setRoomNotificationMode(roomId:mode:)` — `.allMessages` / `.mentionsAndKeywordsOnly` / `.mute`
- `settings.restoreDefaultRoomNotificationMode(roomId:)`

### Encryption (`client.encryption()`)
- `encryption().verificationState()` — `.unverified`/`.verified`
- `encryption().verificationStateListener(listener:)` — stream state changes
- `encryption().recover(recoveryKey:)` — restore from recovery key
- `encryption().waitForE2eeInitializationTasks()`
- `encryption().waitForBackupUploadSteadyState(progressListener:)` — drained before logout

### SessionVerificationController
- `controller.setDelegate(delegate:)`
- `controller.acceptVerificationRequest()`
- `controller.startSasVerification()`
- `controller.approveVerification()` — emojis match
- `controller.declineVerification()` — emojis don't match
- `controller.cancelVerification()`
- (delegate emits SAS `emojis` for the emoji-compare UI)

### Not FFI — direct client-server REST (SDK exposes no setter)
- *`PUT /_matrix/client/v3/profile/{userId}/{key}`* — extended-profile write (`setProfileField`, `setPronouns`)
- *`GET /_matrix/client/v3/profile/{userId}`* — full profile read (`fetchProfile`)
- *`PUT /_matrix/client/v3/presence/{userId}/status`* — `status_msg` (`setPresenceStatus`)
- *`GET/PUT /_matrix/client/v3/rooms/{roomId}/state/{type}`* — custom state read/write (`stateEventContent`, `setStateEvent`; space banner + power-level tags reads)
- *`GET /_matrix/client/unstable/uk.half-shot.msc2666/user/mutual_rooms`* — `mutualRooms`
- *`GET /_matrix/client/v3/sync` (filtered)* — room ephemerals
- *`.well-known/matrix/client`* — client-API base resolution for delegated servers + cross-server profile fetch

### Extended-profile field keys (MSC4133 / Commet-compatible)
| Field | Key(s) | Shape |
|---|---|---|
| Pronouns | write `pronouns` + `foxchat.pronouns`; read `foxchat.pronouns`, `pronouns`, `io.fsky.nyx.pronouns`, `m.pronouns` | string (or `{body}`) |
| Bio | `chat.commet.profile_bio` | `{ "body": "…" }` |
| Status | `chat.commet.profile_status` (+ presence `status_msg`) | string |
| Banner | `chat.commet.profile_banner` | mxc string |
| Timezone | `m.tz` (MSC4175) **and** `chat.commet.profile_timezone` fallback | IANA string |
| Social links | `foxchat.social_links` | `[{ img?, title, link }]` |
| Space banner | state event `page.codeberg.everypizza.room.banner` | `{ url, mimetype }` |
| Role labels | state event `in.cinny.room.power_level_tags` | `{ level: { name, color, iconKey } }` |

> Timezone/banner nuance: Tuwunel-family servers **reject `m.tz`** (reserved `m.*` namespace) and silently drop it — always write the `chat.commet.profile_timezone` fallback too, and prefer the standard key on read. Cross-server reads must hit the **origin** homeserver directly (via its `.well-known`), because federation doesn't relay custom extended-profile fields.

---

## 4. Web mapping

- **Preferences → `localStorage`.** Mirror `Preferences` as a store (Zustand/Context). Keep the `pref.*` keys (or migrate deliberately). Enums as string rawValues. Provide a `resetToDefaults()`. Persist on change; hydrate on mount. `groupingWindowMinutes`/`animatedEmotes`/`showTypingIndicators`/`sendMessageHaptic` have no UI in the audit — carry them anyway. System accessibility flags come from `matchMedia('(prefers-reduced-motion)')` and `(prefers-reduced-transparency)`.
- **Theme → CSS variables.** `appearance` maps to `data-theme="light|dark"` (or nothing = follow `prefers-color-scheme`). `accentColor` → a `--accent` custom property (13 named swatches; "system" = the app default). `messageDensity` → `--group-top-pad`/`--row-pad` (14/2 vs 8/1). `chatFontScale` → `--chat-font-scale` multiplier on a 17px base.
- **Avatar / banner upload → File API.** `<input type="file" accept="image/*">` (drag-drop optional) → `File` → `Blob`/`Uint8Array`. Strip GPS EXIF client-side when `stripLocationMetadata`. Own avatar via SDK `uploadAvatar`/`removeAvatar`; profile banner + space banner via `uploadMedia` → mxc → REST `PUT profile/{key}` or `PUT state/{type}`. Room avatar via `room.uploadAvatar`/`removeAvatar`.
- **Extended-profile fields → REST (not SDK).** Reuse the exact key table above. Read own + others via `GET profile/{userId}` against the origin server resolved from its `.well-known`. Presence status via `PUT presence/{userId}/status`. In a browser these are `fetch()` with `Authorization: Bearer` (own server only — never send the token cross-server for world-readable profile reads). Watch CORS: cross-server profile/`.well-known` fetches must be CORS-permitted or proxied.
- **Cache management → WASM SDK store + media cache.** "Image Cache" size + "Clear Cache" map to whatever media cache the web build uses (IndexedDB / Cache Storage). Provide `totalDiskCacheSize()`-equivalent (sum blob sizes) and `clearCache()` (purge the object store), then re-measure. Auto-download-images gates lazy media fetch (stickers exempt).
- **Notifications:** the local `notificationPreview`/`notificationSound` prefs govern how a service-worker/Notification-API banner renders; per-room mode stays an SDK push-rule call.
- **PronounsStore → per-user query cache** keyed by userId with the same presence-gated status precedence. **SpaceNameStore** only matters if web push needs room→space titling.

---

## 5. Parity checklist (acceptance criteria)

**Preferences**
- [ ] All 27 `pref.*` keys persist to `localStorage` with the exact defaults in §1.12 and survive reload.
- [ ] `resetToDefaults()` restores every key; account/messages untouched.
- [ ] Changing `appearance` flips theme live; "Automatic" follows `prefers-color-scheme`.
- [ ] All 13 accent swatches selectable; selection ring on the active one; applies live via `--accent`.
- [ ] Density (Comfortable/Compact) and font-scale slider (0.8–1.4 step 0.05) change timeline spacing/size live, with the live preview text.
- [ ] Reduce-motion = in-app toggle OR `prefers-reduced-motion`.

**Account / profile edit**
- [ ] Fields seed once from a profile fetch and are not clobbered by later refreshes while typing.
- [ ] Save writes only changed fields; Save disabled until there's a change; success/error message shows.
- [ ] Display name via SDK `setDisplayName`; avatar via `uploadAvatar`/`removeAvatar`; "Remove" only when an avatar exists.
- [ ] Pronouns written to both `pronouns` and `foxchat.pronouns`; read tolerant of all four keys.
- [ ] Bio written as `chat.commet.profile_bio` `{body}`; status written to **both** presence `status_msg` and `chat.commet.profile_status`; timezone written to **both** `m.tz` and `chat.commet.profile_timezone`; "Use current" fills the IANA zone.
- [ ] Social links round-trip as `foxchat.social_links` `[{img?,title,link}]`; blank-link rows dropped; icon picker yields mxc or unicode; empty-title defaults to the link.
- [ ] Profile banner upload → mxc → `chat.commet.profile_banner`; Remove writes empty.
- [ ] Sign Out confirmation → `client.logout()` and local session cleared.

**Storage / media**
- [ ] Cache size displayed formatted; Clear Cache empties the media store and re-measures; disabled at size 0.
- [ ] Auto-download-images gates lazy image fetch; stickers always load.

**Profile sheet (other user)**
- [ ] Renders banner (or accent gradient), avatar + presence dot, name + inline pronouns, selectable user ID, status (presence-gated), presence detail, local time from `m.tz`, boxed bio, social-link rows (http(s) icons NOT fetched), Mutual Spaces/Rooms (MSC2666) that navigate.
- [ ] Message starts/opens a DM; Copy User ID works; Message hidden for self.
- [ ] (If added) Ignore/Block is explicitly net-new vs native — documented as an addition, not parity.

**Per-room / space settings**
- [ ] Every edit control is read-only until the matching `canOwnUserSendState` gate resolves true; spinner while loading.
- [ ] Name/Topic save only changed fields; room avatar change/remove works.
- [ ] Encryption: enable is one-way with confirmation; no disable path.
- [ ] Join rule (invite/space-members/anyone), history visibility (4 options / space "Preview" toggle), canonical alias + directory listing all persist via the listed FFI.
- [ ] Roles: user power-level changes, add-privileged-user, permission grid (10 rows), and Cinny role-label state event all write correctly; default-equal role tags dropped.
- [ ] Per-room notification mode (Default/All/Mentions/Off) via push-rule FFI; not power-gated.
- [ ] Space banner (`page.codeberg.everypizza.room.banner`) add/change/remove gated by the custom-state right.
- [ ] Leave room/space works and dismisses; Advanced shows room id (copyable), version, member count. (No forget action — matches native.)

**Encryption / verification**
- [ ] Verification state reflects `encryption().verificationState()` and updates via listener.
- [ ] SAS flow: accept request → start → emoji compare → approve/decline/cancel via the controller.
- [ ] Recovery-key entry → `encryption().recover(recoveryKey:)` with success/failure feedback.
