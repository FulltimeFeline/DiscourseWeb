# Parity Spec 00 — MASTER CATALOG: SDK / FFI Surface

> The single source of truth for the **`matrix-rust-sdk` surface** the native
> Discourse client uses. The web (TypeScript/React) rewrite calls the SAME Rust
> SDK compiled to WASM (via the `matrix-rust-sdk` JS/WASM bindings — the same
> UniFFI records/enums are re-exposed as JS objects). The TypeScript
> `MatrixClient` / `Room` / `Timeline` abstraction is derived from **this
> document**.
>
> Feature-slice specs 01–07 describe screens; **this doc is the flat, exhaustive
> catalog** of every SDK symbol they collectively call, plus the app-shell /
> cross-cutting features and the native→web mapping.
>
> Source files audited (verbatim reads + full-tree ripgrep):
> `Core/{MatrixService,ListenerBridge,MatrixPlatform,PlatformShims,NotificationManager,Push,PushConfig,SessionStore,RestorationToken+FFI,MediaLoader,CustomEmojiStore,StickerStore}.swift`,
> `App/{DiscourseApp,AppState,AppCommands}.swift`,
> `Features/**` (Timeline, RoomList, Search, QuickSwitcher, Compose, Settings, Call, Verification, Auth),
> `Models/{RoomSummary,TimelineEntry}+FFI.swift`, `DiscourseNSE/NotificationService.swift`.

Every symbol below is a **UniFFI export** unless marked "(app type)" or "(REST)".
Method signatures are given **as used in the app** (Swift param labels → the JS
bindings use the same names as an options object or positional args). `async` =
returns a `Promise` in JS; `throws` = rejects. `TaskHandle` = a subscription
handle you MUST retain or the listener silently detaches.

---

## PART A — COMPLETE FFI SYMBOL CATALOG

### A.0 Top-level (free) functions

| Symbol | Signature (as used) | Purpose |
|---|---|---|
| `initPlatform` | `initPlatform(config: TracingConfiguration, useLightweightTokioRuntime: Bool) throws` | One-time SDK init before any `ClientBuilder`. |
| `messageEventContentFromMarkdown` | `messageEventContentFromMarkdown(md: String) -> MessageEventContent` | Build a message body from markdown (send path). |
| `messageEventContentFromHtml` | `messageEventContentFromHtml(body: String, htmlBody: String) -> MessageEventContent` | Build a message body from HTML. |
| `makeWidgetDriver` | `makeWidgetDriver(settings: WidgetSettings) -> (driver: WidgetDriver, handle: WidgetDriverHandle)` | Element Call widget driver. |
| `newVirtualElementCallWidget` | `newVirtualElementCallWidget(props: VirtualElementCallWidgetProperties, config: VirtualElementCallWidgetConfig) throws -> WidgetSettings` | Build call widget settings. |
| `getElementCallRequiredPermissions` | `getElementCallRequiredPermissions(ownUserId: String, ownDeviceId: String) -> WidgetCapabilities` | Capabilities to grant the call widget. |
| `generateWebviewUrl` | `generateWebviewUrl(widgetSettings: WidgetSettings, room: Room, props: ClientProperties) async throws -> String` | The iframe URL for Element Call. |

`TracingConfiguration` fields used: `logLevel(.info)`, `traceLogPacks`, `extraTargets`, `writeToStdoutOrSystem`, `writeToFiles`, `sentryConfig`.

### A.1 ClientBuilder

Fluent builder; every method returns `self`; terminal `build()` is `async throws`.

```
ClientBuilder()
  .serverNameOrHomeserverUrl(serverNameOrUrl: String)
  .sqliteStore(config: SqliteStoreBuilder)
  .slidingSyncVersionBuilder(versionBuilder: SlidingSyncVersionBuilder)   // .discoverNative | .native | .none
  .setSessionDelegate(sessionDelegate: ClientSessionDelegate)
  .autoEnableCrossSigning(autoEnableCrossSigning: Bool)
  .autoEnableBackups(autoEnableBackups: Bool)
  .backupDownloadStrategy(backupDownloadStrategy: BackupDownloadStrategy)  // .afterDecryptionFailure
  .enableShareHistoryOnInvite(enableShareHistoryOnInvite: Bool)
  .build() async throws -> Client
```

- `SqliteStoreBuilder(dataPath: String, cachePath: String).passphrase(passphrase: String)` — on WASM this is the **IndexedDB** store builder (`StoreConfig`/`makeStoreConfig`-equivalent); `dataPath`/`cachePath` become an IndexedDB DB name, `passphrase` an encryption key. **See §D.**
- Enums: `SlidingSyncVersionBuilder` (`.discoverNative`, `.native`, `.none`), `BackupDownloadStrategy` (`.afterDecryptionFailure`).

### A.2 Client — authentication & session

| Method | Signature | Notes |
|---|---|---|
| `homeserverLoginDetails` | `() async -> HomeserverLoginDetails` | `.supportsPasswordLogin()`, `.supportsOauthLogin()`, `.supportsSsoLogin()` |
| `login` | `(username, password, initialDeviceName: String?, deviceId: String?) async throws` | Password login. |
| `urlForOauth` | `(oauthConfiguration: OAuthConfiguration, prompt: String?, loginHint: String?, deviceId: String?, additionalScopes: [String]?) async throws -> OAuthAuthorizationData` | `.loginUrl()` on result. |
| `loginWithOauthCallback` | `(callbackUrl: String) async throws` | Finish OAuth. |
| `abortOauthAuth` | `(authorizationData: OAuthAuthorizationData) async` | Cancel OAuth. |
| `startSsoLogin` | `(redirectUrl: String, idpId: String?) async throws -> SsoHandler` | Legacy SSO; `handler.url()`, `handler.finish(callbackUrl:)`. |
| `restoreSession` | `(session: Session) async throws` | Restore from stored token. |
| `session` | `() throws -> Session` | Current session record (see A.3). |
| `logout` | `() async throws` | Server-side logout. |
| `userId` | `() throws -> String` | |
| `deviceId` | `() throws -> String?` | |
| `setDelegate` | `(delegate: ClientDelegate) -> TaskHandle?` | Auth-error / soft-logout signal. |

- `OAuthConfiguration` fields: `clientName, redirectUri, clientUri, logoUri, tosUri, policyUri, staticRegistrations`.
- `HomeserverLoginDetails` methods: `supportsPasswordLogin()`, `supportsOauthLogin()`, `supportsSsoLogin()`.

### A.3 Session record (`Session`)

Fields (round-tripped to the app's `RestorationToken.SessionData`):
`accessToken: String`, `refreshToken: String?`, `userId: String`, `deviceId: String`, `homeserverUrl: String`, `oauthData: String?`, `slidingSyncVersion: SlidingSyncVersion` (`.native` | `.none`).
Constructed directly and read field-by-field in `RestorationToken+FFI.swift`.

### A.4 Client — sync / services / misc

| Method | Signature | Notes |
|---|---|---|
| `syncService` | `() -> SyncServiceBuilder` | `.withOfflineMode().withRoomListTimelineLimit(limit: 1).finish() async throws -> SyncService` |
| `enableAllSendQueues` | `(enable: Bool) async` | Re-enable per-room send queues. |
| `subscribeToSendQueueStatus` | `(listener: SendQueueRoomErrorListener) -> TaskHandle` | Send-queue self-disable signal. |
| `getMaxMediaUploadSize` | `() async throws -> UInt64` | Composer oversize gate. |
| `searchUsers` | `(searchTerm: String, limit: UInt64) async throws -> SearchUsersResults` | `.results: [UserProfile]` → `userId, displayName, avatarUrl`. |
| `getDmRoom` | `(userId: String) throws -> Room?` | Existing DM lookup. |
| `createRoom` | `(request: CreateRoomParameters) async throws -> String` | Returns roomId. |
| `joinRoomByIdOrAlias` | `(roomIdOrAlias: String, serverNames: [String]) async throws -> Room` | |
| `getRoom` | `(roomId: String) throws -> Room?` | Full FFI Room by id. |
| `spaceService` | `() -> SpaceService` | See A.7. |
| `encryption` | `() -> Encryption` | See A.10. |
| `getSessionVerificationController` | `() async throws -> SessionVerificationController` | **App caches one instance** (see A.11 note). |
| `getNotificationSettings` | `() -> NotificationSettings` | See A.9. |
| `accountData` | `(eventType: String) async throws -> String?` | Global account data JSON (e.g. `im.ponies.user_emotes`). |
| `setAccountData` | `(eventType: String, content: String) async throws` | |
| `getMediaContent` | `(mediaSource: MediaSource) async throws -> Data` | Full media bytes. |
| `getMediaThumbnail` | `(mediaSource: MediaSource, width: UInt64, height: UInt64) async throws -> Data` | Server thumbnail (unencrypted only). |
| `uploadMedia` | `(mimeType: String, data: Data, progressWatcher: ProgressWatcher?) async throws -> String` | Returns mxc URL. |
| `uploadAvatar` | `(mimeType: String, data: Data) async throws` | Own profile avatar. |
| `removeAvatar` | `() async throws` | |
| `avatarUrl` | `() async throws -> String?` | Own avatar mxc. |
| `displayName` | `() async throws -> String?` | Own display name. |
| `setDisplayName` | `(name: String) async throws` | |
| `setPusher` | `(identifiers: PusherIdentifiers, kind: PusherKind, appDisplayName, deviceDisplayName, profileTag: String?, lang: String, append: Bool) async throws` | iOS APNs pusher — see §C push mapping. |
| `searchMessages` | `(query: String, filter: SearchMessagesFilter, numResultsPerBatch: UInt32) async throws -> GlobalSearchIterator` | Global search; `.rooms` filter. |

- `CreateRoomParameters` fields used: `name: String?, topic: String?, isEncrypted: Bool, isDirect: Bool, visibility: RoomVisibility, preset: RoomPreset, invite: [String], joinRuleOverride: JoinRule?, isSpace: Bool`.
  - `RoomVisibility` = `.public | .private`; `RoomPreset` = `.trustedPrivateChat | .privateChat | .publicChat`.
- `PusherIdentifiers(pushkey, appId)`; `PusherKind.http(data: HttpPusherData(url, format: PushFormat.eventIdOnly, defaultPayload: String))`.
- `GlobalSearchIterator.nextEvents() async throws -> [GlobalSearchResult]` where each has `.roomId` and `.result: RoomSearchResult` (`eventId, sender, senderProfile: ProfileDetails, timestamp: UInt64, content: TimelineItemContent`).

### A.5 SyncService & SyncServiceState

| Symbol | Signature |
|---|---|
| `SyncService.roomListService()` | `-> RoomListService` |
| `SyncService.state(listener:)` | `(listener: SyncServiceStateObserver) -> TaskHandle` |
| `SyncService.start()` | `() async` |
| `SyncService.stop()` | `() async` |
| `SyncServiceStateObserver.onUpdate(state:)` | callback `(SyncServiceState)` |

`SyncServiceState` cases used: `.idle`, `.running`, `.error`, `.offline`, (`.terminated`).

### A.6 RoomListService / RoomList (sidebar)

| Symbol | Signature | Notes |
|---|---|---|
| `RoomListService.allRooms()` | `async throws -> RoomList` | |
| `RoomList.entriesWithDynamicAdapters(pageSize:)` | `(UInt) -> RoomListEntriesWithDynamicAdaptersResult` | `.controller()`, `.entriesStream()` |
| `RoomListDynamicEntriesController.setFilter(kind:)` | `(RoomListEntriesDynamicFilterKind)` | `.all(filters: [.nonLeft, .deduplicateVersions])` |
| `RoomList.loadingState(listener:)` | `(RoomListLoadingStateListener) -> RoomListLoadingStateResult` | initial `.state` + stream |
| `RoomListEntriesListener.onUpdate(roomEntriesUpdate:)` | `([RoomListEntriesUpdate])` | |
| `RoomListLoadingStateListener.onUpdate(state:)` | `(RoomListLoadingState)` | cases: `.notLoaded`, `.loaded(maximumNumberOfRooms:)` |

`RoomListEntriesUpdate` cases (the diff algebra — **identical shape reused for spaces & timeline**): `.append([Room])`, `.clear`, `.pushFront(Room)`, `.pushBack(Room)`, `.popFront`, `.popBack`, `.insert(index: UInt64, value: Room)`, `.set(index: UInt64, value: Room)`, `.remove(index: UInt64)`, `.truncate(length: UInt64)`, `.reset([Room])`.

The entries stream yields FFI `Room` objects directly (roomId via `.id()`), which the app indexes to back its `RoomSummary`.

### A.7 SpaceService (spaces / hierarchy)

| Symbol | Signature |
|---|---|
| `SpaceService.topLevelJoinedSpaces()` | `async throws -> [SpaceRoom]` |
| `SpaceService.subscribeToTopLevelJoinedSpaces(listener:)` | `(SpaceServiceJoinedSpacesListener) -> TaskHandle` |
| `SpaceService.spaceRoomList(spaceId:)` | `(String) -> SpaceRoomList` |
| `SpaceService.addChildToSpace(childId:spaceId:)` | `async throws` |
| `SpaceService.removeChildFromSpace(childId:spaceId:)` | `async throws` |
| `SpaceServiceJoinedSpacesListener.onUpdate(roomUpdates:)` | `([SpaceListUpdate])` |
| `SpaceRoomList.paginationState()` | `-> PaginationState` (`.idle(endReached: Bool)`, `.loading`) |
| `SpaceRoomList.paginate()` | `async throws` |
| `SpaceRoomList.rooms()` | `async -> [SpaceRoom]` |

`SpaceListUpdate` cases = same 11-case diff algebra as A.6 but over `SpaceRoom`.
`SpaceRoom` fields: `roomId, displayName, avatarUrl: String?, topic: String?, roomType: RoomType, numJoinedMembers: UInt64, state: RoomState, via: [String]`.
`RoomType` cases: `.space`, `.room`, `.custom(value: String)` (matched: `"io.element.video"`, `"org.matrix.msc3417.call"`). `RoomState` cases: `.joined`, (`.invited`, `.left`).

### A.8 Room (FFI)

**Identity / info**
- `id() -> String`, `displayName() -> String?`, `avatarUrl() -> String?`, `topic() -> String?`
- `roomInfo() async throws -> RoomInfo` — see A.8.1
- `latestEvent() async -> LatestEventValue?` — see A.8.2
- `subscribeToRoomInfoUpdates(listener: RoomInfoListener) -> TaskHandle` (`RoomInfoListener.call(roomInfo: RoomInfo)`)
- `members() async throws -> RoomMembersIterator?` (`.nextChunk(chunkSize: UInt) -> [RoomMember]?`)
- `inviter() async throws -> RoomMember?`
- `getPowerLevels() async throws -> RoomPowerLevels`

**Timeline**
- `timelineWithConfiguration(configuration: TimelineConfiguration) async throws -> Timeline` — see A.12

**Read / unread**
- `markAsRead(receiptType: ReceiptType) async throws` (`ReceiptType.read`)
- `setUnreadFlag(newValue: Bool) async throws`

**Membership / moderation**
- `join() async throws`, `leave() async throws`
- `inviteUserById(userId: String) async throws`
- `kickUser(userId: String, reason: String?) async throws`
- `banUser(userId: String, reason: String?) async throws`
- `reportContent(eventId: String, score: Int32?, reason: String?) async throws`
- `typingNotice(isTyping: Bool) async throws`
- `subscribeToTypingNotifications(listener: TypingNotificationsListener) -> TaskHandle` (`.call(typingUserIds: [String])`)

**Room settings (see Spec 06)**
- `setName(name: String) async throws`, `setTopic(topic: String) async throws`
- `uploadAvatar(mimeType: String, data: Data, mediaInfo: ...) async throws`, `removeAvatar() async throws`
- `enableEncryption() async throws`
- `getRoomVisibility() async throws -> RoomVisibility`, `updateRoomVisibility(visibility:) async throws`
- `updateJoinRules(newRule: JoinRule) async throws`
- `updateHistoryVisibility(visibility: RoomHistoryVisibility) async throws`
- `updateCanonicalAlias(alias: String?, altAliases: [String]) async throws`, `alternativeAliases() -> [String]`
- `publishRoomAliasInRoomDirectory(alias: String) async throws -> Bool`
- `updatePowerLevelsForUsers(updates: [UserPowerLevelUpdate]) async throws`
- `applyPowerLevelChanges(changes: RoomPowerLevelChanges) async throws`

**Raw events (used for custom state the FFI has no typed API for)**
- `sendRaw(eventType: String, content: String) async throws -> String`
- `sendStateEventRaw(eventType: String, stateKey: String, content: String) async throws`

#### A.8.1 `RoomInfo` (read fields)
`id, displayName: String?, rawName: String?, canonicalAlias: String?, avatarUrl: String?, topic: String?, isDm/isDirect: Bool, isSpace: Bool, encryptionState: EncryptionState(.encrypted/.notEncrypted/.unknown), joinedMembersCount/activeMembersCount: UInt64, numUnreadMessages, numUnreadNotifications, numUnreadMentions: UInt, isMarkedUnread: Bool, cachedUserDefinedNotificationMode: RoomNotificationMode?, isFavourite, isLowPriority: Bool, hasRoomCall: Bool, activeRoomCallParticipants: [String], heroes: [RoomHero{userId}], membership: Membership(.invited/.joined/.left), joinRule: JoinRule, historyVisibility: RoomHistoryVisibility, roomVersion: String?`.

#### A.8.2 `LatestEventValue` cases
`.remote(timestamp: Int64, sender: String, isOwn: Bool, profile: ProfileDetails, content: TimelineItemContent)`, `.local(...)`, `.remoteInvite(...)`, `.none`.
`ProfileDetails.ready(displayName: String?, avatarUrl: String?, ...)`.

#### A.8.3 Power levels
- `RoomPowerLevels.values() -> RoomPowerLevelsValues` (`usersDefault, eventsDefault, invite, stateDefault, kick, ban, redact, roomName, roomAvatar, roomTopic: Int64`)
- `RoomPowerLevels.userPowerLevels() -> [String: Int64]`
- `RoomPowerLevels.canOwnUserSendState(stateEvent: StateEventType) -> Bool` — `StateEventType` cases: `.roomName, .roomTopic, .roomAvatar, .roomEncryption, .roomJoinRules, .roomHistoryVisibility, .roomCanonicalAlias, .roomPowerLevels, .custom(value: String)`
- `canOwnUserInvite() / canOwnUserKick() / canOwnUserBan() / canOwnUserRedactOwn() / canOwnUserRedactOther() -> Bool`
- `UserPowerLevelUpdate(userId: String, powerLevel: Int64)`
- `RoomPowerLevelChanges(usersDefault, eventsDefault, invite, stateDefault, kick, ban, redact, roomName, roomAvatar, roomTopic: Int64?)`
- `RoomMember` fields: `userId, displayName: String?, avatarUrl: String?, membership: Membership, powerLevel: PowerLevel(.infinite/.value(Int64)), suggestedRoleForPowerLevel: SuggestedRole(.creator/.administrator/.moderator/.user), isServiceMember: Bool`.

**Enums:** `JoinRule` = `.public | .invite | .knock | .restricted(rules: [AllowRule]) | .knockRestricted(...)`; `AllowRule.roomMembership(roomId: String)`. `RoomHistoryVisibility` = `.invited | .joined | .shared | .worldReadable`. `RoomVisibility` = `.public | .private`.

### A.9 NotificationSettings

- `getUserDefinedRoomNotificationMode(roomId:) async throws -> RoomNotificationMode?`
- `setRoomNotificationMode(roomId:, mode: RoomNotificationMode) async throws`
- `restoreDefaultRoomNotificationMode(roomId:) async throws`
- `RoomNotificationMode` = `.allMessages | .mentionsAndKeywordsOnly | .mute`.

### A.10 Encryption

- `verificationState() -> VerificationState` (`.verified | .unverified | .unknown`)
- `verificationStateListener(listener: VerificationStateListener) -> TaskHandle` (`.onUpdate(status: VerificationState)`)
- `recover(recoveryKey: String) async throws`
- `waitForE2eeInitializationTasks() async`
- `waitForBackupUploadSteadyState(progressListener: BackupSteadyStateListener?) async throws`

### A.11 SessionVerificationController (SAS)

- `setDelegate(delegate: SessionVerificationControllerDelegate?)`
- `requestDeviceVerification() async throws`
- `acknowledgeVerificationRequest(senderId:, flowId:) async throws`
- `acceptVerificationRequest() async throws`
- `startSasVerification() async throws`
- `approveVerification() async throws` / `declineVerification() async throws` / `cancelVerification() async throws`
- `isVerified()` / lifecycle managed by delegate.

`SessionVerificationControllerDelegate` callbacks: `didReceiveVerificationRequest(details: SessionVerificationRequestDetails{ senderProfile.userId, flowId })`, `didAcceptVerificationRequest()`, `didStartSasVerification()`, `didReceiveVerificationData(data: SessionVerificationData)` (`.emojis(emojis: [SessionVerificationEmoji], indices)` → `.symbol()`, `.description()`), `didFail()`, `didCancel()`, `didFinish()`.

> **Port note:** `getSessionVerificationController` mints a NEW controller per call, and separate controllers get separate delegates. **Cache one instance per session** or incoming-verification events land on the wrong delegate.

### A.12 Timeline (see Spec 03)

**Obtain:** `room.timelineWithConfiguration(configuration: TimelineConfiguration)`.
`TimelineConfiguration(focus: TimelineFocus, filter: TimelineFilter, internalIdPrefix: String?, dateDividerMode: DateDividerMode(.daily), trackReadReceipts: Bool, reportUtds: Bool)`.
- `TimelineFocus` = `.live(hideThreadedEvents: Bool) | .thread(rootEventId:) | .event(...)`
- `TimelineFilter` = `.all | .onlyMessage(types: [MessageType])` (media search: `.image/.video/.file/.audio/.gallery`)

**Diff listener:** `timeline.addListener(listener: TimelineListener) -> TaskHandle`; `TimelineListener.onUpdate(diff: [TimelineDiff])`. `TimelineDiff` = same 11-case algebra as A.6 over `TimelineItem`.

**`TimelineItem`:** `.uniqueId() -> {id: String}`, `.asEvent() -> EventTimelineItem?`, `.asVirtual() -> VirtualTimelineItem?` (`.dateDivider(timestampMillis: Int64) | .readMarker | .timelineStart`).

**`EventTimelineItem`** fields: `sender, timestamp: UInt64, senderProfile: ProfileDetails(.ready(displayName, avatarUrl, ...)), eventOrTransactionId: EventOrTransactionId(.eventId(String) | .transactionId(String)), localSendState: EventSendState(.notSentYet/.sendingFailed/.sent...), content: TimelineItemContent, isOwn, isEditable, canBeRepliedTo: Bool, readReceipts: [String: Receipt], lazyProvider: LazyTimelineItemProvider`.

**`LazyTimelineItemProvider`:** `.getShields(strict: Bool) -> ShieldState?`, `.getSendHandle() -> SendHandle?`.

**`TimelineItemContent`** cases: `.msgLike(MsgLikeContent)`, `.roomMembership(userId, userDisplayName, change: MembershipChange?, ...)`, `.profileChange(displayName, prevDisplayName, avatarUrl, prevAvatarUrl)`, `.state`, `.callInvite`, `.callNotify`/`.rtcNotification`, `.failedToParseMessageLike`, `.failedToParseState`.
- `MsgLikeContent{ kind: MsgLikeKind, inReplyTo: InReplyToDetails?, threadSummary: ThreadSummary?, reactions: [Reaction] }`
- `MsgLikeKind` cases: `.message(Message)`, `.sticker(body, info, source: MediaSource)`, `.poll(question, kind: PollKind, maxSelections, answers: [PollAnswer{id,text}], votes: [String:[String]], endTime: UInt64?, hasBeenEdited)`, `.redacted`, `.unableToDecrypt(EncryptedMessage)`.
- `Message{ msgType: MessageType, body, isEdited: Bool, mentions }`
- `MessageType` cases: `.text(TextMessageContent{body, formatted: FormattedBody?})`, `.notice(...)`, `.emote(...)`, `.image(ImageMessageContent{filename, caption: String?, info: ImageInfo?, source: MediaSource})`, `.video(VideoMessageContent{...})`, `.audio(AudioMessageContent{filename, info, audio: AudioContent{duration, waveform:[UInt16]}?, voice: ...?, source})`, `.file(FileMessageContent{filename, ...})`, `.gallery(...)`, `.location(LocationMessageContent{body, geoUri, ...})`, `.other(msgtype, body)`.
- `FormattedBody{ format: MessageFormat(.html), body }`
- `Reaction{ key, senders: [ReactionSender{senderId, timestamp}] }`
- `InReplyToDetails{ eventId, event: InReplyToEvent(.ready(content, sender, senderProfile, ...) | .pending | .unavailable | .error) }`
- `ThreadSummary.numReplies()`
- `MembershipChange` cases: `.joined/.left/.invited/.invitationAccepted/.invitationRejected/.banned/.kickedAndBanned/.unbanned/.kicked/.knocked/...`
- Shields: `ShieldState(.red(code) | .grey(code) | .none)`; `ShieldStateCode(.sentInClear/.unverifiedIdentity/.unsignedDevice/.unknownDevice/.authenticityNotGuaranteed/.verificationViolation/.mismatchedSender)`.

**Timeline write methods** (each returns a `SendHandle` unless noted; `SendHandle.join()/.tryResend()/.abort() async`):
```
send(msg: MessageEventContent)
sendReply(msg: MessageEventContent, eventId: String)         // repliedToEventId in newer bindings
edit(eventOrTransactionId: EventOrTransactionId, newContent: EditedContent)   // .roomMessage(MessageEventContent)
sendImage(params: UploadParameters, thumbnailSource: UploadSource?, imageInfo: ImageInfo)
sendVideo(params: UploadParameters, thumbnailSource: UploadSource?, videoInfo: VideoInfo)
sendFile(params: UploadParameters, fileInfo: FileInfo)
sendVoiceMessage(params: UploadParameters, audioInfo: AudioInfo, waveform: [UInt16])
sendLocation(body, geoUri, description: String?, zoomLevel: UInt8?, assetType: AssetType?)   async
toggleReaction(itemId: EventOrTransactionId, key: String)    async
redactEvent(eventOrTransactionId: EventOrTransactionId, reason: String?)   async -> Bool
createPoll(question, answers: [String], maxSelections: UInt8, pollKind: PollKind)   async   // .disclosed/.undisclosed
sendPollResponse(pollStartEventId: String, answers: [String])   async
endPoll(pollStartEventId: String, text: String)   async
paginateBackwards(numEvents: UInt16)   async throws -> Bool   // true = reached start
fetchDetailsForEvent(eventId: String)   async throws
markAsRead(receiptType: ReceiptType)   async throws
```
Attachment records: `UploadParameters{ source: UploadSource(.data(bytes, filename) | .file(path)), caption: String?, formattedCaption: FormattedBody?, mentions: Mentions?, inReplyTo: String? }`, `ImageInfo/VideoInfo/AudioInfo/FileInfo{ width/height: UInt64?, duration, mimetype, size: UInt64?, blurhash: String?, thumbnailInfo: ThumbnailInfo?, thumbnailSource: MediaSource? }`, `ThumbnailInfo{ width, height, mimetype, size }`, `Mentions{ userIds: [String], room: Bool }`.

### A.13 Media

- `MediaSource.fromUrl(url: String) throws -> MediaSource`; `mediaSource.url() -> String`; `mediaSource.toJson() -> String` (the app inspects the JSON for an AES `"key"` to detect encrypted media — encrypted sources can't be server-thumbnailed).
- Download via `client.getMediaContent` / `getMediaThumbnail` (A.4).

### A.14 Element Call widget (see Spec 07)

`VirtualElementCallWidgetProperties{ elementCallUrl, widgetId, parentUrl, fontScale, font, encryption: EncryptionSystem(.perParticipantKeys), posthog*, rageshakeSubmitUrl, sentry* }`; `VirtualElementCallWidgetConfig{ intent: WidgetIntent(.joinExisting/.startCall), skipLobby, header, hideHeader, preload, appPrompt, confineToRoom, hideScreensharing, controlledAudioDevices, sendNotificationType }`; `ClientProperties{ clientId, languageTag, theme }`; `WidgetDriver.run(room: Room, capabilitiesProvider: WidgetCapabilitiesProvider)`; `WidgetDriverHandle.send(msg: String) async`/`.recv() async -> String?`; `WidgetCapabilitiesProvider.acquireCapabilities(capabilities:) -> WidgetCapabilities`.

### A.15 Delegates & listeners — full protocol inventory

| Protocol | Callback(s) | Fires on |
|---|---|---|
| `ClientDelegate` | `didReceiveAuthError(isSoftLogout: Bool)`, `onBackgroundTaskErrorReport(taskName, error)` | Rust thread |
| `ClientSessionDelegate` | `retrieveSessionFromKeychain(userId) throws -> Session`, `saveSessionInKeychain(session)` | Rust thread (OAuth token rotation) |
| `SyncServiceStateObserver` | `onUpdate(state: SyncServiceState)` | |
| `RoomListEntriesListener` | `onUpdate(roomEntriesUpdate: [RoomListEntriesUpdate])` | |
| `RoomListLoadingStateListener` | `onUpdate(state: RoomListLoadingState)` | |
| `SpaceServiceJoinedSpacesListener` | `onUpdate(roomUpdates: [SpaceListUpdate])` | |
| `TimelineListener` | `onUpdate(diff: [TimelineDiff])` | |
| `TypingNotificationsListener` | `call(typingUserIds: [String])` | |
| `RoomInfoListener` | `call(roomInfo: RoomInfo)` | |
| `VerificationStateListener` | `onUpdate(status: VerificationState)` | |
| `SessionVerificationControllerDelegate` | 7 callbacks (A.11) | |
| `SendQueueRoomErrorListener` | `onError(roomId: String, error: ClientError)` | |
| `WidgetCapabilitiesProvider` | `acquireCapabilities(capabilities:)` | |
| `ProgressWatcher` / `BackupSteadyStateListener` | progress callbacks (passed `nil` in-app) | |

---

## PART B — THE LISTENER BRIDGE PATTERN (`ListenerBridge.swift`)

Every SDK listener callback arrives on a **Rust/tokio thread**. The native app
wraps each one in a small class that conforms to the SDK protocol and pushes each
callback value into a Swift `AsyncStream`; view models `for await` off the main
actor. Registration returns a `TaskHandle` the bridge **must retain** (dropping
it cancels the subscription).

Example (verbatim shape):
```swift
final class TimelineDiffBridge: TimelineListener {
    let stream: AsyncStream<[TimelineDiff]>
    private let continuation: AsyncStream<[TimelineDiff]>.Continuation
    init() { (stream, continuation) = AsyncStream.makeStream() }
    func onUpdate(diff: [TimelineDiff]) { continuation.yield(diff) }
}
```
Bridges in the codebase: `RoomListEntriesBridge`, `RoomListLoadingStateBridge`,
`SyncServiceStateBridge` (×2 — a stream has ONE consumer, so the error-restart
monitor registers a SECOND listener), `TimelineDiffBridge`,
`TypingNotificationsBridge`, `JoinedSpacesBridge`, `VerificationStateBridge`,
`SessionVerificationDelegateBridge` (maps 7 callbacks → one
`VerificationEvent` enum stream), `RoomInfoBridge`, `ClientDelegateBridge`,
`SendQueueErrorBridge`, `SessionDelegate` (keychain, not a stream).
Buffering: unbounded for diffs/entries; `.bufferingNewest(1)` for
latest-value-only state (sync state, loading state, typing, verification, room
info, send-queue).

### Web equivalent

The WASM `matrix-rust-sdk` bindings expose each listener as **a JS callback
object / function** you pass to the same registration method; it returns a
handle with a `.free()`/dispose method (the `TaskHandle` analogue). Wrap each in
an **async iterable** or an **`EventTarget`**:

```ts
function toAsyncStream<T>(register: (cb: (v: T) => void) => TaskHandle) {
  let handle: TaskHandle;
  const queue: T[] = []; let resolve: ((v: IteratorResult<T>) => void) | null = null;
  handle = register(v => { if (resolve) { resolve({ value: v, done: false }); resolve = null; } else queue.push(v); });
  const iter: AsyncIterableIterator<T> = {
    next: () => queue.length ? Promise.resolve({ value: queue.shift()!, done: false })
                             : new Promise(r => (resolve = r)),
    return: () => { handle.free(); return Promise.resolve({ value: undefined as any, done: true }); },
    [Symbol.asyncIterator]() { return this; },
  };
  return { iter, handle };
}
```
Key rules to preserve: (1) **retain the handle** on the owning object; free it on
teardown. (2) For latest-value-only streams, keep only the last value
(coalesce). (3) The two-consumer problem is the same — if two loops need sync
state, register **two** listeners. (4) Callbacks may fire before your `for await`
starts (WASM has no separate thread but async microtasks race) — buffer.
(5) `ClientSessionDelegate.saveSessionInKeychain` becomes a **write to IndexedDB
/ persisted store** on the token-rotation path (see §D).

---

## PART C — APP SHELL & CROSS-CUTTING FEATURES

### C.1 Window / scene structure (`DiscourseApp.swift`)
- **Main `WindowGroup`** → `RootView` phase router (`launching → loggedOut → disconnected → active(scope)`).
- **`WindowGroup(id: "call", for: String.self)`** — a **detached call window per room** so the app stays usable during a call. Web: a separate route/popup or a PiP-style floating panel; call state must live above the view tree (like `AppState.activeCallRoomIds`).
- **macOS `Settings` scene** — its own window with independent theme injection. Web: a `/settings` route/modal.
- **Scene-phase handling:** background → pause presence polling; iOS pauses SDK sync under a background-task assertion (skipped during a live call — MatrixRTC "delayed leave" needs sync to keep refreshing). Web analogue: `visibilitychange` / `pagehide` / `freeze` (bfcache) → stop the sliding-sync loop; `Page Lifecycle API`. **macOS `ProcessInfo.beginActivity` (App Nap) has no web analogue** — a hidden tab is throttled by the browser; use a **Service Worker + Web Push** to receive messages while the tab is inactive (see C.5).

### C.2 Keyboard commands / shortcuts (`AppCommands.swift`)
| Shortcut | Action |
|---|---|
| ⌘N | New Message (DM) |
| ⇧⌘N | New Room |
| (menu) | New Space |
| ⇧⌘J | Join Room |
| **⌘K** | **Jump to Room (Quick Switcher)** |
| ⇧⌘F | Focus room filter (sidebar) |
| ⌥⌘I | Toggle details column (persisted in `UserDefaults "showsDetailsColumn"`) |
| ⌥⌘↓ / ⌥⌘↑ | Next / Previous room |
| ⇧⌘] / ⇧⌘[ | Next / Previous **unread** |
| ⌘0 | Home space |
| ⌘1…⌘9 | Nth space (rail's persisted drag order) |
| (menu) | Sign Out |
Web: a global `keydown` handler / a lib like `tinykeys`; ⌘→Ctrl on non-mac. ⌘F in-timeline = in-room search sheet.

### C.3 Quick switcher (⌘K) (`QuickSwitcherView.swift`)
Pure client-side fuzzy match over `roomList.rooms` (`RoomSummary`) — **no SDK
call**. Excludes spaces & invites. Prefix matches outrank contains; folded
(diacritic-insensitive, lowercased) names via `RoomSummary.foldedForSearch`.
↑/↓ to move, Enter opens, Esc closes. Rooms keep syncing while open (re-filter on
`rooms` change). Web: a command-palette component fed the same in-memory list.

### C.4 Global search (`SearchResultsSheet.swift`) + in-room search
- **Global message search:** `client.searchMessages(query:, filter: .rooms, numResultsPerBatch: 40) -> GlobalSearchIterator`, paged via `.nextEvents()`. Category filter (all/text/images/video/audio/files) is **client-side** over the returned `TimelineItemContent`. Selecting a hit sets `pendingEventNavigation`.
- **User/directory search** (new-DM, invite): `client.searchUsers(searchTerm:, limit: 10)`; the app also accepts a raw `@user:server` the directory misses. Debounced 300ms.
- **In-room search (⌘F):** searches the **loaded timeline** client-side, then `timeline.paginateBackwards` in a loop to reach older/encrypted history the cache-only search misses.

### C.5 Notifications (native → Web)
Native (`NotificationManager.swift`): `UNUserNotificationCenter` local
notifications for incoming messages/calls/invites, suppressing the focused room
and own messages; categories with **Reply** (text input) and **Mark as Read**
actions; click → open room (switching accounts first if needed); delivered-banner
clearing on read; preview levels (full / sender-only / none); dedup by
timestamp; stale-event guard (>120s old ignored).
- iOS remote push (`Push.swift`, `PushConfig.swift`, `DiscourseNSE`): APNs device
  token → `client.setPusher` (base64 pushkey, sygnal gateway,
  `format: .eventIdOnly`, `mutable-content:1`); an **NSE** decrypts the pushed
  event via the shared App-Group crypto store.
**Web mapping:**
- Local banners → **Web Notifications API** (`new Notification`, or
  `ServiceWorkerRegistration.showNotification` for action buttons). Reply/
  Mark-as-Read → notification `actions[]` handled in the SW `notificationclick`.
- Remote push → **Web Push** (VAPID) + a **Service Worker**: the SW receives the
  push, and (mirroring the NSE) decrypts via a WASM SDK instance against the
  IndexedDB crypto store, then `showNotification`. `setPusher` still registers,
  but with a Web-Push `endpoint`/`p256dh`/`auth` instead of an APNs pushkey.
- Focused-room suppression, dedup, preview levels, click→navigate: identical
  logic in JS.

### C.6 URL / deep-link handling
- **OAuth/SSO callback:** custom scheme `com.riiiiiiiley.discourse:/oauth-callback` via `ASWebAuthenticationSession`. Web: a normal `https://…/oauth-callback` redirect URI + `window` message / route handler (no `ASWebAuthenticationSession`; just a redirect or popup).
- **Notification navigation:** click carries `{roomId, userId}` → `pendingRoomNavigation` / switch account. Web: SW `notificationclick` → `clients.openWindow`/`postMessage` → route.
- **Event permalinks:** search/thread jumps use `pendingEventNavigation{roomId, eventId}`; the timeline scrolls to the event (consuming the request, dropping ones >30s old). Composer mentions render as `https://matrix.to/#/@user:server` links. Web: parse `matrix.to` / `matrix:` URIs and route to room+event; the SDK's permalink parser (`parseMatrixEntityFrom`) can be used if exposed.

### C.7 Badge counts (`PlatformShims.swift` / `AppState.swift`)
App badge = **sum of unread across ALL warm accounts** (`scope.roomList.unreadTotal`), not just the active one, recomputed on every unread-total change. Native: `NSApp.dockTile.badgeLabel` / `UNUserNotificationCenter.setBadgeCount`. Web: **`navigator.setAppBadge(n)` / `clearAppBadge()`** (installed PWA); fall back to a `document.title` prefix / favicon badge.

### C.8 Multi-account (`AppState.swift`)
Warm `SessionScope` per account kept across switches; each has its own
`Client`, room list, media loader, presence, stores. Auth-error stream per
account → drop that account into re-auth without disturbing others. Web: a
`Map<userId, SessionScope>`; each scope owns a distinct WASM `Client` + IndexedDB
namespace.

---

## PART D — NATIVE → WEB MAPPING (non-portable APIs)

| Native API | Used for | Web replacement |
|---|---|---|
| **Keychain** (`Security`, `SessionStore.swift`) | Restoration tokens (access/refresh, passphrase, store paths) — device-only, shared with NSE via access group | **IndexedDB** (optionally wrapped with WebCrypto-encrypted values); the token's `storePassphrase` keys the crypto store. No OS keychain; consider `CredentialsContainer`/passkeys only for the login secret, not per-message keys. Share with SW via same-origin IndexedDB. |
| **UserDefaults** (`@AppStorage`, `UserDefaults.standard`) | `activeUserId`, per-space room selection JSON, timeline scroll anchors, `showsDetailsColumn`, preferences | **`localStorage`** (small scalars) / **IndexedDB** (JSON blobs). Same keys. |
| **APNs + NSE** (`Push.swift`, `DiscourseNSE`) | Remote push wake + decrypt while suspended | **Web Push (VAPID) + Service Worker** that decrypts via WASM SDK against IndexedDB crypto store; `setPusher` with Web-Push endpoint. |
| **`ProcessInfo.beginActivity` (App Nap)** | Keep sliding-sync long-poll alive when window occluded (macOS) | No equivalent — hidden tabs are throttled. Rely on **Web Push + SW** for background delivery; on focus, resume sync. |
| **`ASWebAuthenticationSession`** (`WebAuthSession.swift`) | OAuth/SSO browser flow with custom-scheme callback | Standard **OAuth redirect** to an `https` redirect URI (full-page or popup + `postMessage`); `client.urlForOauth`/`loginWithOauthCallback` unchanged. |
| **`AVAudioPlayer` ringtones** (`RingtonePlayer.swift`) | Incoming-call ringtone | **`HTMLAudioElement` / Web Audio API** (autoplay needs a prior user gesture — pre-unlock on first interaction). |
| **Voice recording** (`AVAudioRecorder`, `VoiceRecorder.swift`) | Voice messages + waveform | **`MediaRecorder`** (opus/webm) + `AudioContext` analyser for the waveform `[UInt16]`. |
| **File system paths** (`FileManager`, App Group container, `dataPath`/`cachePath`) | SQLite store dirs, disk thumbnail cache | Logical **IndexedDB** DB names + **Cache Storage** (or IndexedDB) for the thumbnail cache. `makeSessionDirectories` → deterministic DB-name minting. |
| **`SqliteStore` / SQLCipher** (`ClientBuilder.sqliteStore`) | The crypto + state + event-cache store, passphrase-encrypted | **IndexedDB store** (the WASM SDK ships an IndexedDB `StoreConfig`); `passphrase` → the store's encryption key. |
| **`ImageIO` downsampling** (`MediaLoader`, `MediaProcessing`) | Thumbnail decode/downsample off-main | **`createImageBitmap({resizeWidth,…})`** in a **Web Worker** / OffscreenCanvas; blurhash decode in JS. |
| **`NSCache` / disk thumbnail cache** | In-memory + on-disk thumbnails per account | JS `Map` + **Cache Storage**, namespaced per userId. |
| **`OSAllocatedUnfairLock` / `NSLock`** | Guard token-array & profile-URL caches across Rust threads | Single-threaded JS event loop makes most of these no-ops; keep an async mutex only around token read-modify-write if the SW also writes. |
| **AppKit/UIKit shims** (`Platform`, clipboard, open URL, activate) | Clipboard, open external URL, app activate, badge | `navigator.clipboard`, `window.open`, `navigator.setAppBadge`. |
| **Manual REST via `URLSession`** (`MatrixService`: extended profiles, presence, ephemerals, mutual rooms, video-room create, state read/write, hierarchy) | Endpoints the FFI doesn't expose typed APIs for | **`fetch`** with the session `accessToken`; resolve `.well-known/matrix/client` for the client-API base (delegated homeservers). Same endpoints, same headers. |

---

## PART E — PROPOSED TYPESCRIPT INTERFACE SKETCH

The ViewModels port to hooks/stores over these interfaces. `matrix-rust-sdk` WASM
types are re-exported; app-level abstractions wrap them (mirroring
`MatrixService`/`SessionScope`).

```ts
// ---- Session lifecycle (mirrors MatrixService + PendingLogin) ----
interface MatrixClientFactory {
  prepare(homeserver: string): Promise<PendingLogin>;
  restore(token: RestorationToken): Promise<MatrixSession>;
}
interface PendingLogin {
  readonly supportsPassword: boolean; readonly supportsOAuth: boolean; readonly supportsSso: boolean;
  finishWithPassword(username: string, password: string): Promise<[MatrixSession, RestorationToken]>;
  startOAuth(): Promise<URL>;  finishOAuth(callbackUrl: string): Promise<[MatrixSession, RestorationToken]>;
  abortOAuth(): Promise<void>;
  startSso(): Promise<URL>;    finishSso(callbackUrl: string): Promise<[MatrixSession, RestorationToken]>;
}
interface RestorationToken {                       // persisted to IndexedDB (was Keychain)
  session: { accessToken: string; refreshToken?: string; userId: string; deviceId: string;
             homeserverUrl: string; oauthData?: string; slidingSyncVersion: "native" | "none" };
  storePassphrase: string; dataPath: string; cachePath: string;
}

// ---- The core session (mirrors MatrixService) ----
interface MatrixSession {
  readonly userId: string;
  readonly ownServerName: string;
  // sync
  startSync(): Promise<void>; pauseSync(): Promise<void>; resumeSync(): Promise<void>;
  syncState: AsyncIterable<SyncServiceState>;
  authError: AsyncIterable<boolean /*isSoftLogout*/>;
  enableAllSendQueues(): Promise<void>;
  logOut(): Promise<void>;
  // services
  roomList: RoomListService;
  spaces: SpaceService;
  notifications: NotificationSettings;
  encryption: EncryptionApi;
  verification(): Promise<SessionVerificationController>;   // cached singleton
  // rooms
  room(roomId: string): Room | undefined;
  getDmRoom(userId: string): Room | undefined;
  createRoom(p: CreateRoomParams): Promise<string>;
  createVideoRoom(p: VideoRoomParams): Promise<string>;     // REST creation_content type
  joinRoom(address: string): Promise<string>;
  searchUsers(query: string): Promise<UserHit[]>;
  searchMessages(query: string): Promise<GlobalSearchIterator>;
  maxUploadSize(): Promise<number | undefined>;
  // media
  media: MediaLoader;                                       // getMediaContent/getMediaThumbnail + cache
  // own profile (typed client calls + REST extended profile)
  ownProfile(): Promise<ProfileInfo>;
  setDisplayName(n: string): Promise<void>;
  setAvatar(bytes: Uint8Array, mime: string): Promise<void>; removeAvatar(): Promise<void>;
  setPronouns(v: string): Promise<void>; setBio(v: string): Promise<void>;
  setStatus(v: string): Promise<void>;   setTimezone(v: string): Promise<void>;
  setSocialLinks(l: SocialLink[]): Promise<void>;
  fetchProfile(userId: string): Promise<ProfileInfo | undefined>;   // REST, cross-server
  // ephemerals (REST /sync stream): receipts + typing
  fetchRoomEphemerals(roomId: string, since?: string): Promise<RoomEphemerals | undefined>;
  // account data (emoji/stickers)
  accountData(type: string): Promise<string | undefined>;
  setAccountData(type: string, contentJson: string): Promise<void>;
  // push (Web Push instead of APNs)
  registerPusher(subscription: PushSubscription): Promise<void>;
}

// ---- Room list & spaces ----
interface RoomListService {
  entries(pageSize: number): { updates: AsyncIterable<RoomListEntriesUpdate[]>; setFilter(k: FilterKind): void };
  loadingState: AsyncIterable<RoomListLoadingState>;
}
interface SpaceService {
  topLevelJoinedSpaces(): Promise<SpaceRoom[]>;
  joinedSpaces: AsyncIterable<SpaceListUpdate[]>;
  spaceRoomList(spaceId: string): SpaceRoomList;
  addChildToSpace(childId: string, spaceId: string): Promise<void>;
  removeChildFromSpace(childId: string, spaceId: string): Promise<void>;
}

// ---- Room ----
interface Room {
  readonly id: string;
  info(): Promise<RoomInfo>;
  infoUpdates: AsyncIterable<RoomInfo>;
  latestEvent(): Promise<LatestEventValue | undefined>;
  members(): AsyncIterable<RoomMember[]>;
  powerLevels(): Promise<RoomPowerLevels>;
  timeline(config?: TimelineConfig): Promise<Timeline>;
  markAsRead(): Promise<void>; setUnreadFlag(v: boolean): Promise<void>;
  typingNotice(isTyping: boolean): Promise<void>;
  typing: AsyncIterable<string[]>;
  // membership/moderation/settings … (invite/kick/ban/leave/join/report,
  // setName/setTopic/uploadAvatar/enableEncryption/updateJoinRules/
  // updateHistoryVisibility/aliases/visibility/power-levels — all as in A.8)
  sendRaw(type: string, contentJson: string): Promise<string>;
  sendStateEventRaw(type: string, stateKey: string, contentJson: string): Promise<void>;
}

// ---- Timeline ----
interface Timeline {
  diffs: AsyncIterable<TimelineDiff[]>;                    // wrap addListener
  paginateBackwards(n: number): Promise<boolean /*reachedStart*/>;
  fetchDetailsForEvent(eventId: string): Promise<void>;
  markAsRead(): Promise<void>;
  send(content: MessageEventContent): Promise<SendHandle>;
  sendReply(content: MessageEventContent, eventId: string): Promise<SendHandle>;
  edit(id: EventOrTransactionId, content: EditedContent): Promise<SendHandle>;
  redact(id: EventOrTransactionId, reason?: string): Promise<boolean>;
  toggleReaction(id: EventOrTransactionId, key: string): Promise<void>;
  sendImage(p: UploadParameters, thumb: UploadSource | undefined, info: ImageInfo): Promise<SendHandle>;
  sendVideo(p: UploadParameters, thumb: UploadSource | undefined, info: VideoInfo): Promise<SendHandle>;
  sendFile(p: UploadParameters, info: FileInfo): Promise<SendHandle>;
  sendVoiceMessage(p: UploadParameters, info: AudioInfo, waveform: number[]): Promise<SendHandle>;
  sendLocation(o: LocationParams): Promise<void>;
  createPoll(q: string, answers: string[], kind: PollKind): Promise<void>;
  sendPollResponse(pollStartEventId: string, answers: string[]): Promise<void>;
  endPoll(pollStartEventId: string, text: string): Promise<void>;
}
// TimelineDiff, TimelineItem.asEvent()/asVirtual(), EventTimelineItem,
// TimelineItemContent/MsgLikeKind/MessageType, ShieldState, InReplyToDetails,
// Reaction, ThreadSummary, and all *Info records are re-exported WASM types (§A.12).
```

**Grouping principle (from the ViewModels):** `MatrixSession` owns control-flow
(sync, auth, services, own profile, REST helpers); `RoomListService`/
`SpaceService` are diff-stream feeds → a normalized `RoomSummary` store; `Room`
is per-room metadata + settings + membership; `Timeline` is the per-room live
message list with its own diff stream (cached ≤8 live instances, LRU-evicted, as
in `SessionScope`). Verification, calls, media, and stores (emoji/stickers/
presence/pronouns) hang off the session as sub-modules.
