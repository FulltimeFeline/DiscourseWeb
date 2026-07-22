# Parity Spec 07 — Calls / Device Verification / Presence

Audit of the native SwiftUI Discourse client for the TypeScript/React web rewrite.
Slice: **Element Call embedding, session/device verification (SAS), and presence.**

Source files audited:
- `Discourse/Features/Call/CallView.swift`
- `Discourse/Features/Call/CallViewModel.swift`
- `Discourse/Features/Call/IncomingCallView.swift`
- `Discourse/Features/Verification/VerificationSheet.swift`
- `Discourse/Features/Verification/VerificationViewModel.swift`
- `Discourse/Core/PresenceService.swift`
- `Discourse/Core/RingtonePlayer.swift`
- Supporting: `Discourse/Core/WellKnownDiscovery.swift`, `Discourse/Core/MatrixService.swift`,
  `Discourse/Core/ListenerBridge.swift`, `Discourse/Core/NotificationManager.swift`,
  `Discourse/App/AppState.swift`, `Discourse/App/DiscourseApp.swift`,
  `Discourse/Models/RoomSummary+FFI.swift`, `Discourse/Features/Timeline/TimelineViewModel.swift`

> **Environmental caveats (NOT client bugs — carry these into the web build's docs):**
> - The `fulltimefeline.com` homeserver (Tuwunel) has **presence disabled server-side**. Every
>   `GET .../presence/{userId}/status` returns **403**. The native client detects this and stops
>   polling (`unsupported = true`). The web client must degrade identically — no presence dots,
>   no errors surfaced to the user.
> - That homeserver's `.well-known/matrix/client` **lacks `rtc_foci`** (and `io.element.call`),
>   so calls fall back to `https://call.element.io/room` but may still fail to find a SFU. This is
>   a server config gap, not a client defect.

---

## 1. CALLS — Element Call (MatrixRTC) embedding

### 1.1 Native architecture (what we're porting FROM)

The native client does **not** implement WebRTC. It embeds **Element Call** (the standalone
MatrixRTC SPA) inside a `WKWebView` and bridges the Matrix **widget postMessage API** between
the web content and the Rust SDK's **widget driver**. The SDK builds a signed widget URL, runs
a driver that answers `fromWidget` requests (room state, to-device, encryption keys, etc.), and
Element Call handles all media (camera/mic/SFU/WebRTC) itself inside the web view.

Flow:

```
CallView (SwiftUI)
  └─ CallWebView (WKWebView)  ──postMessage bridge──┐
                                                    ▼
                                       CallViewModel  ── WidgetDriverHandle
                                                    ▲            │
  Element Call SPA (widget) ◀── driver→widget ──────┘            ▼
                                                        SDK WidgetDriver.run(room:, capabilitiesProvider:)
```

### 1.2 Building the call URL (`CallViewModel.start()`)

1. **Discover Element Call base URL** — `WellKnownDiscovery.elementCallWidgetURL(userId:)`:
   - Parses the homeserver from `@user:server` (`userId.split(":").dropFirst().first`).
   - Fetches `https://{server}/.well-known/matrix/client`.
   - Reads `io.element.call.widget_url`. If the URL has an empty/`/` path, appends `/room`
     (the widget entrypoint; a bare origin loads the standalone SPA which cannot auth as a widget).
   - Caches: `200` (URL or absent) and `404` (definitively none) are cached; `5xx/429/redirect`
     are treated as transient and retried.
   - Falls back to `"https://call.element.io/room"` when no self-hosted EC is advertised.
2. **Build the virtual widget** — `newVirtualElementCallWidget(props:config:)`:
   - `VirtualElementCallWidgetProperties`: `elementCallUrl`, random `widgetId` (`UUID`),
     **`parentUrl = elementCallUrl`** (so the widget posts messages to itself, in-page, where the
     injected bridge captures them), `encryption: .perParticipantKeys`, all PostHog/Sentry/rageshake
     fields `nil`, `fontScale/font: nil`.
   - `VirtualElementCallWidgetConfig`: **`intent: joinExisting ? .joinExisting : .startCall`**,
     `skipLobby: false`, `hideHeader: true`, `appPrompt: false`, `confineToRoom: true`,
     `hideScreensharing: false`, `header/preload/controlledAudioDevices/sendNotificationType: nil`.
3. **Generate the signed URL** — `generateWebviewUrl(widgetSettings:room:props:)` with
   `ClientProperties(clientId: "com.riiiiiiiley.discourse", languageTag: nil, theme: nil)`.
   Returns the fully-parameterized Element Call URL (includes room ID, device, base URLs, etc.).
4. **Create + run the driver** — `makeWidgetDriver(settings:)` → `(driver, handle)`.
   - `driver.run(room:, capabilitiesProvider:)` on a background `Task`.
   - **Pump task**: `while let message = await handle.recv()` → forward each driver→widget message
     into the web view via `window.postMessage(<message>, '*')`.
   - Objects (`driver`, `handle`, capabilities bridge) are retained for the call's lifetime.
5. Set `webViewURL` → the view loads it.

### 1.3 The widget postMessage bridge (`CallWebView`)

- `WKWebViewConfiguration.mediaTypesRequiringUserActionForPlayback = []` (autoplay allowed).
- **Injected JS** (`atDocumentStart`) listens for `window`'s `message` events and forwards to the
  native handler `widgetBridge` **only** the relevant frames:
  - `data.response && data.api == 'toWidget'`  (driver's response to the widget), OR
  - `!data.response && data.api == 'fromWidget'` (widget's request to the driver).
- Native → widget: `viewModel.postToWebView` runs `window.postMessage(<json>, '*')`.
- Widget → native: `Coordinator.userContentController(...didReceive:)` → `receiveFromWebView`.
- **Media capture permission** (`requestMediaCapturePermissionFor`): granted **only** when
  `origin.host == allowedHost` (the validated call URL host). A rogue `.well-known` URL is denied.
  → **Web mapping: an `<iframe allow="camera; microphone; display-capture; ...">` with the EC origin.**

### 1.4 Message routing quirks (`receiveFromWebView`)

Parses each incoming JSON message's `action`:
- **Hangup/close detection**: if `action` contains `"hangup"` or equals `"close"`,
  `"im.vector.hangup"`, or `"io.element.close"` → set `didHangUp = true` (the view then dismisses).
- **Host-handled actions** (acked locally, **NOT** forwarded to the driver, else the driver returns
  an "unknown variant" error that desyncs EC's state machine — mic shows muted while unmuted, join
  stalls):
  - `"io.element.join"`, `"io.element.device_mute"`, `"set_always_on_screen"`,
    `"io.element.tile_layout"`.
  - Ack = echo the request back with a `response` key: `{"success": true}` for
    `set_always_on_screen`, else `{}` (empty = success, matched by `requestId`).
- Everything else → `await handle.send(msg: message)`.

### 1.5 Mute audio/video, participant strip, screenshare

- **Mute / camera / screenshare / tile layout are all handled inside Element Call's own UI** — the
  native client renders no call controls of its own. `hideScreensharing: false` keeps EC's
  screenshare button; `hideHeader: true` hides EC's header. The native chrome is only a title bar
  ("Call — {roomName}") plus a leave button.
- **Participant strip** is EC's own in-iframe UI. Separately, the room list/timeline show a
  MatrixRTC participant preview outside the call: `RoomSummary.callParticipantIds`
  (from `RoomInfo.activeRoomCallParticipants`) drives `CallParticipantsStrip` in `SidebarView`.

### 1.6 Join vs. start; active-call state

- `TimelineViewModel.callViewModel()` builds a `CallViewModel(room:client:ownUserId:
  joinExisting: hasActiveCall)`. `hasActiveCall` comes from `RoomInfo.hasRoomCall` (streamed via
  the room-info listener; also mirrored on `RoomSummary.hasActiveCall`).
- `intent = joinExisting ? .joinExisting : .startCall`.
- **Active-call registry**: `CallRegistry.localRooms` (a `Set<String>` of room IDs). `start()`
  inserts, `stop()` removes. Used so the ringing UI skips a call we started ourselves.
- **`activeCallRoomIds`** (on `AppState`) tracks rooms whose call is open in a detached window,
  so the in-room "join call" banner is hidden while the call window is up.

### 1.7 Leave / lifecycle

- `CallView`: `.task { await viewModel.start() }`, `.onDisappear { viewModel.stop() }`.
- Leave button: macOS dismisses immediately; iOS shows a confirmation dialog first
  ("Leave the call?"). Keyboard shortcut = `.cancelAction`.
- `.onChange(of: didHangUp)` → dismiss when EC reports hangup.
- `stop()` cancels pump + driver tasks, clears `handle`/retained/`postToWebView`, ends the
  keep-alive activity, removes from `CallRegistry`.
- **macOS keep-alive** (`beginCallActivity`): `ProcessInfo.beginActivity([.userInitiated,
  .idleSystemSleepDisabled])` so an occluded call window's JS timers (the MatrixRTC "delayed leave"
  membership heartbeat) aren't throttled by App Nap and the server doesn't drop us for everyone.
- **iOS deliberately does NOT touch `AVAudioSession`** during a call — WebKit owns the WebRTC
  capture session; reconfiguring it desyncs the mic. The `audio` background mode + WebKit's active
  capture session grant background execution.

### 1.8 Incoming-call ring detection & UI

- **Detection is polling-based off room state, not a signaling event.**
  `NotificationManager.maybeNotifyCall(room:accountUserId:)` compares `room.hasActiveCall` against
  a per-room `lastCallActive` cache:
  - Rising edge (`hasActiveCall` false→true) → `onIncomingCall?(room)` **only when `room.isDirect`
    and NOT in `CallRegistry.localRooms`** (1:1 rings; group calls get a banner, not a ringtone).
  - Falling edge (true→false) → `onCallEnded?(roomId)`, and remove the delivered call notification.
- Wired in `DiscourseApp`: `onIncomingCall` sets `appState.ringingCall` (guarded so only one rings
  at a time); `onCallEnded` clears it if it matches.
- `AppState.RingingCall { roomId, roomName, avatarURL, isDirect }` (Identifiable by `roomId`).
- **`IncomingCallView`** (floating glass banner over the main window):
  - `RoomAvatarView` + room name + "Incoming call…".
  - Decline (red `phone.down.fill`) / Accept (green `phone.fill`) circular buttons.
  - `.onAppear { RingtonePlayer.shared.start() }` / `.onDisappear { ...stop() }`.
  - **`.task`**: sleep 45s, then auto-`decline()` (ring timeout).
  - Accept sets `pendingCallJoin` (the room's timeline then joins the call and clears the ring).

### 1.9 Ringtone (`RingtonePlayer`)

- A **synthesized** classic telephone ring — no shipped audio asset. Generates a 16-bit mono WAV in
  code: 440 Hz + 480 Hz dual-tone, 2s on / 4s silent over a 6s loop, 22050 Hz, 20 ms fade in/out to
  avoid clicks, amplitude 0.22 each tone, volume 0.6, `numberOfLoops = -1`.
- iOS: sets `AVAudioSession` category `.playback` (rings through the silent switch) on start,
  deactivates with `.notifyOthersOnDeactivation` on stop.

### 1.10 Video rooms

- A room can be a **video room** (`isVideoRoom`, from room metadata). When it is, the timeline shows
  a call/join affordance instead of a message composer. `hasActiveCall` (from `RoomInfo.hasRoomCall`)
  distinguishes "video room, call in progress" (green) from an idle video room. Same
  `CallViewModel`/Element Call embed path; `joinExisting` is set from `hasActiveCall`.

---

## 2. VERIFICATION — session / device verification (SAS)

Two entry points into `VerificationViewModel` (`@Observable`, `@MainActor`), both driven by one
shared `SessionVerificationController`:

- **Outgoing** ("Verify This Session"): user asks to verify this device against another signed-in one.
- **Incoming**: another device requests verification; surfaced via `AppState.incomingVerification`
  → `VerificationSheet(incoming:)`.
- **Recovery-key** alternative: restore cross-signing/backup from the saved recovery key.

### 2.1 Steps (`VerificationViewModel.Step`)

`intro`, `waitingForOtherDevice`, `comparingEmojis([VerificationEmoji])`, `confirming`, `done`,
`failed(String)`, `recoveryKeyEntry`, `recovering`.

### 2.2 Controller wiring (`attachController`)

- `service.sessionVerificationController()` returns **one shared controller for the whole session**
  (cached in `MatrixService.cachedVerificationController`). Rationale in source: `getSession
  VerificationController` mints a NEW controller each call, and separate controllers get separate
  delegates — so an active flow's accept/emoji events would land on the incoming-watcher's delegate
  and stall. One instance keeps every event on the currently-set delegate.
- A `SessionVerificationDelegateBridge` is set as the controller's delegate; it yields
  `VerificationEvent`s into an `AsyncStream`, consumed by an event task calling `handle(_:)`.

### 2.3 Delegate → event mapping (`SessionVerificationDelegateBridge`)

Implements `SessionVerificationControllerDelegate`:

| Delegate callback | Emits |
|---|---|
| `didReceiveVerificationRequest(details:)` | `.requestReceived(senderId: details.senderProfile.userId, flowId: details.flowId)` |
| `didAcceptVerificationRequest()` | `.acceptedByOtherDevice` |
| `didStartSasVerification()` | `.sasStarted` |
| `didReceiveVerificationData(data:)` | if `case .emojis(let emojis, _)` → `.emojis([VerificationEmoji])` (each: `emoji.symbol()`, `emoji.description()`) |
| `didFail()` | `.failed` |
| `didCancel()` | `.cancelled` |
| `didFinish()` | `.finished` |

### 2.4 Outgoing flow

1. `beginDeviceVerification()` → `attachController()` → `controller.requestDeviceVerification()` →
   step `waitingForOtherDevice`.
2. Event `acceptedByOtherDevice` → `controller.startSasVerification()`.
3. Event `emojis(...)` → step `comparingEmojis(emojis)` — a 4-column grid of emoji symbol + label.
4. User taps **They Match** → step `confirming` + `controller.approveVerification()`.
   User taps **They Don't Match** → `controller.declineVerification()` + step `failed(...)`.
5. Event `finished` → step `done`. Event `failed`/`cancelled` → step `failed(...)`.

### 2.5 Incoming flow

- `beginIncomingVerification(senderId:flowId:)` → `attachController()` →
  `controller.acknowledgeVerificationRequest(senderId:flowId:)` →
  `controller.acceptVerificationRequest()` → step `waitingForOtherDevice`. Then same emoji path.
- **Incoming-request watcher** (`AppState.watchForIncomingVerification()`): sets a delegate bridge on
  the shared controller and, on `.requestReceived`, sets `incomingVerification =
  IncomingVerification(senderId, flowId)`. When the sheet appears it takes over the delegate; on
  dismiss (`VerificationSheet.onDisappear`) it hands the delegate **back** to the watcher via
  `scope.watchForIncomingVerification()`.

### 2.6 Cancel / cleanup

- `cancel()` → `controller.cancelVerification()` + `cleanUp()`.
- `VerificationSheet.cancelIfInFlight()` cancels only when step ∈
  {`waitingForOtherDevice`, `comparingEmojis`, `confirming`}.
- `cleanUp()`: cancel event task, `controller.setDelegate(delegate: nil)`, drop controller + bridge.
- `reset()` → cleanUp + step `intro` + clear recovery key.

### 2.7 Recovery key (cross-signing / backup restore)

- `showRecoveryKeyEntry()` → step `recoveryKeyEntry` (secure text field; hint "looks like EsT… groups
  of four").
- `submitRecoveryKey()`: trim; if empty, no-op. Step `recovering` →
  `service.recover(recoveryKey:)` → `client.encryption().recover(recoveryKey:)`. Success → `done`;
  throw → `failed("That recovery key didn't work…")`.

### 2.8 Verification state (gate for the whole feature)

- `MatrixService.verificationState` → `client.encryption().verificationState()` returns a
  `VerificationState` (`.verified` / `.unverified` / `.unknown`).
- `MatrixService.verificationStates()` returns a live stream via
  `client.encryption().verificationStateListener(listener:)` (bridged to an `AsyncStream`).
- `AppState` sets `needsVerification = (state == .unverified)` from that stream, which is what
  prompts the verify sheet and keeps encrypted messages "locked" until verified.

---

## 3. PRESENCE (`PresenceService`)

**The Rust SDK does not surface presence.** This service polls the Client-Server API directly with
the session's access token.

### 3.1 States & model

- `State`: `online` (green), `unavailable` = "Idle" (orange), `offline` (gray). Raw values match the
  Matrix `presence` enum. `.init(rawValue:)` maps the API string.
- `Entry { state, lastActiveAgo: TimeInterval?, fetchedAt: Date, statusMessage: String? }`.
- `statusMessage` = the Matrix presence **`status_msg`** — where Commet-family clients store the
  user's custom status (NOT a profile field).
- Per-user boxed `@Observable UserPresence { entry }` so one update re-renders only that user's dots.

### 3.2 Fetch (`fetch(userId:maxAge:)`)

- `GET {baseURL}/_matrix/client/v3/presence/{userId}/status`, `Authorization: Bearer {token}`.
- Response JSON: `presence` (string → `State`), `last_active_ago` (ms → seconds), `status_msg`
  (blank trimmed to nil).
- **403 → `unsupported = true`**, cancel the poll task, stop asking forever (server has presence
  disabled — the fulltimefeline case).
- Non-200 (other) or unparsable → ignored, entry unchanged.
- Dedup: `inFlight` set prevents concurrent fetches for the same user; `maxAge` skips a fetch if the
  cached `entry.fetchedAt` is fresh enough.
- **Own presence suppression**: if `userId == ownUserId` and `Preferences.shared.sharePresence` is
  off, skip — each GET is activity the server reads as "online".

### 3.3 Polling model (NOT /sync-based here)

- Single shared poll `Task` for all visible dots, **20 s interval** (`pollInterval`). Each tick
  fetches every watched user with `maxAge = pollInterval * 0.75`.
- **Watcher refcounting**: `register(userId)` increments `watchers[userId]`, refreshes
  (`maxAge = pollInterval * 1.25`), starts the poll if needed. `unregister` decrements; when
  `watchers` is empty, the poll task is cancelled.
- `pause()` / `resume()` for backgrounding (park the poll, keep watchers).
- `startPollingIfNeeded()` guards on `pollTask == nil && !unsupported && !isPaused`.

> Note on the brief's "/sync-based approach": presence here is **HTTP polling**, not read from
> `/sync`. On web, the SDK's `/sync` presence EDUs (`client.subscribeToPresence` / presence stream
> if exposed) are the natural replacement, with the same 403-degrade fallback.

### 3.4 UI plumbing

- `PresenceDot(userId:size:)` reads `presence.state(of:)`, draws a colored circle with a background
  stroke ring; `.task(id:userId)` registers/unregisters and parks until cancelled.
- `View.presenceIndicator(userId:size:)` overlays the dot bottom-trailing on an avatar.
- Helpers: `state(of:)`, `statusMessage(of:)`, `detailText(of:)` ("Online" / "Idle" /
  "Last active {duration} ago" / "Offline").
- Injected via `EnvironmentValues.presenceService`.

---

## 4. FLAT FFI SYMBOL CATALOG (MatrixRustSDK)

Every SDK symbol touched by this slice.

### Calls / widget driver
- `newVirtualElementCallWidget(props:config:)` → widget settings
- `VirtualElementCallWidgetProperties(elementCallUrl:widgetId:parentUrl:fontScale:font:encryption:posthogUserId:posthogApiHost:posthogApiKey:rageshakeSubmitUrl:sentryDsn:sentryEnvironment:)`
- `VirtualElementCallWidgetConfig(intent:skipLobby:header:hideHeader:preload:appPrompt:confineToRoom:hideScreensharing:controlledAudioDevices:sendNotificationType:)`
- `EncryptionSystem.perParticipantKeys` (the `encryption:` value)
- `WidgetIntent` — `.startCall`, `.joinExisting` (the `intent:` value)
- `generateWebviewUrl(widgetSettings:room:props:)` → `String`
- `ClientProperties(clientId:languageTag:theme:)`
- `makeWidgetDriver(settings:)` → `(driver: WidgetDriver, handle: WidgetDriverHandle)`
- `WidgetDriver.run(room:capabilitiesProvider:)`
- `WidgetDriverHandle.recv()` → `String?` (driver→widget)
- `WidgetDriverHandle.send(msg:)` → `Bool` (widget→driver)
- `WidgetCapabilitiesProvider` (protocol) — impl `CallCapabilitiesBridge.acquireCapabilities(capabilities:)`
- `WidgetCapabilities` (type passed to/returned from `acquireCapabilities`)
- `getElementCallRequiredPermissions(ownUserId:ownDeviceId:)` → `WidgetCapabilities`
- `Room` (passed to driver + widget URL generation)
- `Room.displayName()` → `String?`
- `Room.id()` → `String`
- `Client.deviceId()` → `String` (own device id for capabilities)

### Call state (room info)
- `RoomInfo.hasRoomCall` → `Bool`  (drives `hasActiveCall`, ring detection)
- `RoomInfo.activeRoomCallParticipants` → `[String]`  (participant strip)
- `RoomInfoListener` (protocol) / `Room.subscribeToRoomInfoUpdates(listener:)` — streams `RoomInfo`
  (bridged via `RoomInfoBridge`)

### Session / device verification
- `Client.getSessionVerificationController()` → `SessionVerificationController`
- `SessionVerificationController`
  - `.setDelegate(delegate:)`  (accepts `nil` to detach)
  - `.requestDeviceVerification()`
  - `.acknowledgeVerificationRequest(senderId:flowId:)`
  - `.acceptVerificationRequest()`
  - `.startSasVerification()`
  - `.approveVerification()`
  - `.declineVerification()`
  - `.cancelVerification()`
- `SessionVerificationControllerDelegate` (protocol) — callbacks:
  `didReceiveVerificationRequest(details:)`, `didAcceptVerificationRequest()`,
  `didStartSasVerification()`, `didReceiveVerificationData(data:)`,
  `didFail()`, `didCancel()`, `didFinish()`
- `SessionVerificationRequestDetails`
  - `.senderProfile` → (`.userId`)
  - `.flowId` → `String`
- `SessionVerificationData` — enum, case `.emojis(emojis:_)` (array of emoji + indices)
- `SessionVerificationEmoji`
  - `.symbol()` → `String`
  - `.description()` → `String`

### Encryption / cross-signing / recovery
- `Client.encryption()` → `Encryption`
- `Encryption.verificationState()` → `VerificationState`
- `VerificationState` — enum `.verified` / `.unverified` / `.unknown`
- `Encryption.verificationStateListener(listener:)` → handle (streams `VerificationState`)
- `VerificationStateListener` (protocol) — bridged by `VerificationStateBridge`
- `Encryption.recover(recoveryKey:)`  (async, throws)
- `Encryption.waitForE2eeInitializationTasks()`  (session bring-up; adjacent)
- `Encryption.waitForBackupUploadSteadyState(progressListener:)`  (adjacent)

### Presence
- **None.** SDK exposes no presence API here — presence is raw C-S HTTP:
  `GET /_matrix/client/v3/presence/{userId}/status` with `Authorization: Bearer`.
- (`Client.session()` is used elsewhere in `MatrixService` for the access token / homeserver URL.)

### NOT used in this slice
- `Room.matrixToEventPermalink(...)` — referenced in the brief but **not** used by any call/
  verification/presence path in this codebase. No permalink is generated for calls.

---

## 5. WEB MAPPING (TypeScript / React)

### 5.1 Calls → Element Call in an `<iframe>` (simpler than native)

- **Embed EC in an `<iframe>`**, not a WKWebView. Because both the app and EC run in the browser,
  the postMessage bridge is a **direct `window.addEventListener('message')` + `iframe.contentWindow
  .postMessage`** — no injected JS, no native message handler. This is strictly simpler than the
  native WKWebView bridge.
- **WebRTC lives entirely inside the EC iframe** — do not reimplement it. Grant media via the iframe
  `allow` attribute: `allow="camera; microphone; display-capture; autoplay; clipboard-write;
  fullscreen"`. Constrain to the EC origin.
- **Reuse the SDK's widget driver** exactly: `newVirtualElementCallWidget` →
  `generateWebviewUrl` → `makeWidgetDriver` → `driver.run(room, capabilitiesProvider)`; pump
  `handle.recv()` → `iframe.contentWindow.postMessage(msg, ecOrigin)`; forward inbound messages via
  `handle.send(msg)`. Filter inbound messages by `event.origin === ecOrigin` (replaces the native
  host-allowlist media check) and by the same `api`/`response` predicate.
- **Port the host-handled action list verbatim**: `io.element.join`, `io.element.device_mute`,
  `set_always_on_screen`, `io.element.tile_layout` — ack locally, don't forward. Same
  `{"success": true}` / `{}` reply shape matched by `requestId`.
- **Hangup detection**: same action match (`hangup` / `close` / `im.vector.hangup` /
  `io.element.close`) → close the call view.
- **URL discovery**: same `.well-known` `io.element.call.widget_url` lookup (append `/room`),
  fallback `https://call.element.io/room`. (Environmental: fulltimefeline lacks `rtc_foci` —
  degrade gracefully; a call may fail to find an SFU. Not a client bug.)
- **Keep-alive**: no App Nap equivalent, but the MatrixRTC membership heartbeat still runs inside
  the EC iframe's JS timers. A **backgrounded tab throttles timers** — consider a Web Worker or a
  visibility warning; accept that a hidden tab may drop from the call.
- **Config**: `hideHeader: true`, `confineToRoom: true`, `intent` from `hasRoomCall`.

### 5.2 Incoming call ring

- **Detection**: same polling-on-room-state model — compare `RoomInfo.hasRoomCall` transitions per
  room (rising edge + `isDirect` + not-self-started → ring). Track own-started calls in a
  `Set<roomId>` equivalent of `CallRegistry`.
- **Ring UI**: a floating banner (accept / decline), 45 s auto-decline timeout.
- **Ringtone**: an `<audio loop>` element. Either ship a small asset or reproduce the synthesized
  440+480 Hz WAV via the **Web Audio API** (two `OscillatorNode`s, 2s on / 4s off gain envelope).
  Autoplay of a ring requires the tab to have prior user interaction, or use the browser's
  notification sound.
- **Notifications**: use the **Notification API** for a call notification when the tab is hidden.

### 5.3 Verification — pure SDK, one-to-one port

- Same `SessionVerificationController` API surface and delegate callbacks; wire delegate events to a
  React state machine mirroring `Step`. Render the emoji grid from `symbol()`/`description()`.
- Keep the **single shared controller** invariant, and the **hand-off** between the incoming-request
  watcher and the active sheet (set delegate on open, restore watcher on close).
- Recovery key → `encryption().recover(recoveryKey)`. `verificationState()` +
  `verificationStateListener` gate the "needs verification" prompt.

### 5.4 Presence

- Prefer the SDK's `/sync` presence stream if the web SDK exposes it; otherwise **poll**
  `GET /_matrix/client/v3/presence/{userId}/status` with the bearer token, identical semantics:
  20 s interval, watcher refcount, in-flight dedup, own-presence suppression under a "share presence"
  pref, **403 → disable permanently** (fulltimefeline). Read `presence`, `last_active_ago`,
  `status_msg`. Color map: online=green, unavailable=orange, offline=gray.

---

## 6. PARITY CHECKLIST (acceptance criteria)

### Calls
- [ ] Starting a call builds the widget URL via `newVirtualElementCallWidget` +
      `generateWebviewUrl` (NOT a hand-rolled URL) with `intent` derived from `hasRoomCall`.
- [ ] EC base URL is discovered from `.well-known` `io.element.call.widget_url` (with `/room`
      appended for bare origins), caching 200/404, retrying 5xx/429; falls back to
      `call.element.io/room`.
- [ ] EC loads in a same-origin-constrained `<iframe>`; camera/mic/display-capture granted via
      `allow`; inbound messages filtered by `event.origin === ecOrigin`.
- [ ] Widget driver runs; driver→widget messages posted to the iframe; widget→driver forwarded via
      `handle.send`. Only `api: fromWidget` (no response) / `api: toWidget` (response) frames bridged.
- [ ] The four host-handled actions are acked locally with the correct reply shape and NOT forwarded
      (verify mic-state / join don't desync).
- [ ] Hangup/close actions close the call view.
- [ ] Mute audio, mute video, screenshare, tile layout, and the participant strip all work via EC's
      own in-iframe UI (no reimplementation).
- [ ] Leave/close tears down the driver + pump and removes the room from the active-call set;
      confirmation prompt on touch/mobile.
- [ ] Video rooms: idle vs. "call in progress" reflected; join uses `joinExisting`.
- [ ] Room list / timeline show MatrixRTC participants from `activeRoomCallParticipants`.

### Incoming call ring
- [ ] Rising-edge `hasRoomCall` on a **direct** room not started locally triggers a ring; group
      calls get a banner only.
- [ ] Only one ring at a time; ring auto-declines after 45 s; ringtone loops and stops on
      accept/decline; falling-edge clears the ring and removes any call notification.
- [ ] Accept joins the call; decline dismisses.

### Verification
- [ ] "Verify this session" runs the full SAS flow: request → accepted → SAS → emoji compare →
      approve/decline → done/failed, with the correct emoji grid (symbol + description).
- [ ] Incoming verification requests surface (senderId + flowId), acknowledge + accept, then the
      same emoji path.
- [ ] A single shared `SessionVerificationController`; delegate is handed between the incoming
      watcher and the active sheet and restored on close.
- [ ] Cancel/dismiss cancels only in-flight flows; cleanup detaches the delegate.
- [ ] Recovery-key entry calls `encryption().recover`; wrong key → clear error.
- [ ] `verificationState()` + its listener gate the "needs verification" prompt.

### Presence
- [ ] Dots poll `/presence/{userId}/status` every 20 s with watcher refcounting + in-flight dedup.
- [ ] Colors: online=green, idle/unavailable=orange, offline=gray; detail text shows Online/Idle/
      "Last active … ago"/Offline.
- [ ] `status_msg` surfaced as the custom status.
- [ ] Own presence not polled when "share presence" is off.
- [ ] **403 permanently disables presence** (no dots, no repeated calls, no user-facing error) — the
      fulltimefeline case.
- [ ] Poll pauses on background/hidden and resumes with watchers intact.
