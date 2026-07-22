# Parity Spec 01 — Authentication & Session Lifecycle

> Slice of the Discourse (native SwiftUI Matrix client) parity audit for the web
> (TypeScript/React) rewrite. Source of truth: `Discourse/Features/Auth/*`,
> `Discourse/Core/{MatrixService,SessionStore,RestorationToken+FFI,WellKnownDiscovery,MatrixPlatform,ListenerBridge}.swift`,
> `Discourse/App/AppState.swift`.
>
> The native app talks to `MatrixRustSDK` (UniFFI bindings over
> matrix-rust-sdk). The web rewrite targets the **WASM build of the same SDK**
> (`@matrix-org/matrix-sdk-crypto-wasm` / the rust-sdk WASM `Client`) or, where
> noted, the JS Matrix SDK. FFI symbol names in this doc are the exact ones the
> native app calls; the WASM binding names are near-identical (camelCase,
> promise-returning).

---

## 1. User-Facing Behavior — Screens & States

### 1.1 Login surface (`LoginView`)

Two mount contexts:

- **Full-window logged-out login** — shown when `AppState.phase == .loggedOut`.
  No Cancel.
- **Add-account sheet** (`isSheet == true`) — presented over an active session
  via `AppState.isAddAccountPresented`. Shows a **Cancel** action
  (top-left button on macOS; toolbar `.cancellationAction` on iOS) that
  dismisses without changing the active session.

Layout differs by platform (macOS = centered card; iOS = `Form` inside a
`NavigationStack`), but **the state machine and behavior are identical** and are
what the web must reproduce. The web is free to use one responsive layout.

Header: app icon, title "Discourse", and a **subtitle** driven by stage:
- Stage `.server` → "Sign in to Matrix"
- Stage `.methods` → the homeserver display name (the trimmed homeserver
  string, or "matrix.org" if empty).

The whole view is driven by `LoginViewModel` (`@Observable`). Its stages:

```
enum Stage { case server, methods }
```

#### Stage 1 — Homeserver entry (`.server`)

- One text field, `homeserver`, default value **`"matrix.org"`**, placeholder
  `matrix.org`.
  - iOS: URL keyboard, no autocapitalization, no autocorrect, `.continue`
    submit label. Footer text: "The Matrix server your account lives on."
- **Continue** button (also fires on field submit / Return).
  - While busy: shows a spinner in place of the label; field + button disabled.
- Action → `viewModel.discoverMethods()`:
  - Guards against re-entry while `isBusy`.
  - Sets `isBusy = true`, clears `errorMessage`.
  - `homeserverDisplayName` = trimmed `homeserver`, or `"matrix.org"` if empty.
  - Calls `MatrixService.prepare(homeserver:)`. On success stores the returned
    `PendingLogin` and advances to `.methods`.
  - On failure sets `errorMessage`:
    `"Couldn't reach {homeserver}: {error.localizedDescription}"` and stays on
    `.server`.

#### Stage 2 — Auth methods (`.methods`)

Method availability comes from the `PendingLogin` (which wraps
`homeserverLoginDetails()`): `supportsPassword`, `supportsOAuth`, `supportsSso`.
Rendering rules (exact precedence — reproduce faithfully):

1. **OAuth takes priority over SSO.** If `supportsOAuth`, show a prominent
   **"Sign In with Browser"** button (globe icon). Else if `supportsSso`, show
   **"Sign In with SSO"** (prominent only when password is *not* also
   supported).
2. **Password block** (only if `supportsPassword`):
   - If OAuth or SSO is also present, show an **"or"** divider (macOS) /
     section header "Or sign in with a password" (iOS).
   - Username field: placeholder `@user:server`, no autocapitalize, no
     autocorrect, `textContentType(.username)`. iOS submit → focus password.
   - Password field: `SecureField`, `textContentType(.password)`. Submit → Sign
     In.
   - **Sign In** button. Disabled unless `canSubmitPassword`
     (`username` non-empty after trim **AND** `password` non-empty) and not
     `isBusy`. Shows spinner while busy.
3. If **none** of the three are supported:
   "This homeserver offers no supported sign-in method."
4. **"Use a different homeserver"** button → `viewModel.backToServerEntry()`:
   clears `pending`, `errorMessage`, `password`; sets stage `.server`.

**Focus behavior:** on entering `.methods`, focus the username field if password
login is available, else no focus. (iOS drives focus from the container's
`onChange(of: stage)` to avoid a lazy-Form re-focus bug — a web analog: set
focus once on stage transition, not per-render.)

#### Password login flow (`passwordLogin()`)

- Guard: `pending` exists, `canSubmitPassword`, not `isBusy`.
- `isBusy = true`, clear error.
- `pending.finishWithPassword(username: trimmed, password:)`.
  - Throws `MatrixServiceError.passwordLoginUnsupported` if password not
    supported → message
    "This homeserver doesn't support password login. OAuth sign-in is coming
    soon."
  - Under the hood: `Client.login(username, password, initialDeviceName, deviceId: nil)`.
    `initialDeviceName` = `"Discourse (iOS)"` / `"Discourse (macOS)"`.
- On success returns `(MatrixService, RestorationToken)` → `complete(result)`
  (see §1.5).
- On error → `friendlyMessage(for:)`:
  - `MatrixServiceError` → its `localizedDescription`.
  - Contains "forbidden" / "M_FORBIDDEN" (case-insensitive) →
    **"Incorrect username or password."**
  - Otherwise → "Sign-in failed: {error.localizedDescription}".

#### Browser login flow — OAuth & legacy SSO (`browserLogin(kind:)`)

Shared path for both `.oauth` and `.sso`:

1. Guard: `pending` exists, not `isBusy`. Set busy, clear error.
2. Get the authorization URL:
   - OAuth → `pending.startOAuth()`:
     `Client.urlForOauth(oauthConfiguration:, prompt:nil, loginHint:nil, deviceId:nil, additionalScopes:nil)`.
     `OAuthConfiguration` = `clientName:"Discourse"`,
     `redirectUri: "com.riiiiiiiley.discourse:/oauth-callback"`,
     `clientUri: "https://github.com/riiiiiiiley/Discourse"`, rest nil/empty.
     Stores the returned `OAuthAuthorizationData`; URL from `data.loginUrl()`.
   - SSO → `pending.startSso()`:
     `Client.startSsoLogin(redirectUrl: "com.riiiiiiiley.discourse:/sso-callback", idpId: nil)`.
     Stores the `SsoHandler`; URL from `handler.url()`.
3. Open the system browser auth session (`WebAuthSession.authenticate`) with
   `callbackScheme = "com.riiiiiiiley.discourse"`. Native uses
   `ASWebAuthenticationSession` (non-ephemeral, so existing browser session
   cookies are reused). Resolves with the callback URL, or throws on
   user-cancel / failure.
4. Finish:
   - OAuth → `pending.finishOAuth(callbackUrl:)` →
     `Client.loginWithOauthCallback(callbackUrl:)`.
   - SSO → `pending.finishSso(callbackUrl:)` → `SsoHandler.finish(callbackUrl:)`.
5. On success returns `(MatrixService, RestorationToken)` → `complete`.
6. On error:
   - If `kind == .oauth`, call `pending.abortOAuth()`
     (`Client.abortOauthAuth(authorizationData:)`) to release the pending auth.
   - **Suppress the error message on user cancellation** (`ASWebAuthenticationSessionError.canceledLogin`
     or `URLError.cancelled`). Otherwise show
     "Sign-in failed: {error.localizedDescription}".

The callback scheme is deliberately reverse-DNS/dotted
(`com.riiiiiiiley.discourse`), because MAS rejects single-word private-use
schemes during dynamic client registration (RFC 8252 §7.1). **Web analog:** a
hosted redirect-URI page (https), not a custom scheme — see §4.

#### Error display

- macOS: red centered text under the form.
- iOS: red text in its own `Section`; on a new error the form scrolls the error
  into view (it can otherwise land under the keyboard).

### 1.2 Session restore on launch

`AppState.start()` (called once at launch; guarded to `.launching`):

1. `accountTokens = sessionStore.loadAll()`.
2. If empty → `phase = .loggedOut`.
3. Else target = `sessionStore.activeUserId` (persisted last-active) **or**
   `accountTokens[0].session.userId`. Call `activate(userId:)`.

`activate(userId:)`:
- Find token for `userId`; if none, stay put (or `.loggedOut` if no accounts).
- If a **warm scope** already exists (in-memory `scopes[userId]`), cancel any
  reconnect, set `activeUserId`, `phase = .active(warm)`, done (instant switch).
- Otherwise `MatrixService.restore(token:)`:
  - `restoreSession(session:)` on a freshly built client.
  - Kicks off `client.encryption().waitForE2eeInitializationTasks()` in the
    background.
  - Build a `SessionScope`, register badge + auth-error monitoring, set
    `activeUserId`, **prime the cached sidebar snapshot** before flipping
    `phase = .active`, then start room-list sync.
- On restore **failure** (server unreachable / client build fails — *not* a
  revoked token, which surfaces later during sync): `phase = .disconnected` and
  `scheduleReconnect(userId:)`.

### 1.3 Reconnect-on-disconnect (`scheduleReconnect`)

- Only runs while `phase == .disconnected`; no-op if a retry loop already
  exists.
- Retries `activate(userId:)` **every 30 seconds** until it succeeds (or the
  phase leaves `.disconnected`, or the task is cancelled).
- Any successful `activate`, `logOut`, `switchAccount`, or auth-error handling
  cancels the reconnect task.

### 1.4 Soft-logout / auth-error handling (`handleAuthError`)

Distinct from a transient disconnect: this is a **confirmed dead token**
(unknown-token / soft-logout), reported by the SDK's `ClientDelegate.didReceiveAuthError(isSoftLogout:)`.
Retrying restore would loop forever, so the account is removed.

Wiring: each `SessionScope` exposes `onAuthError` and `startAuthErrorMonitor()`,
which consumes `MatrixService.authErrorStream` (fed by `ClientDelegateBridge`).
Fires with the scope's user ID.

`handleAuthError(userId:)`:
- Idempotency guard: `authErrorHandledUserIds` (the delegate can fire
  repeatedly). Also requires the account to still be in `accountTokens`.
- Tear down the scope, remove session directories, drop the room-list snapshot
  and media disk cache, remove from `scopes`.
- Remove the token from `accountTokens`, persist, update badge.
- **Skips the network logout** (token is already invalid) — this is the key
  difference from `logOut`.
- If it was the active account: clear notification handlers, cancel reconnect,
  then fall to the **next account** (`phase = .launching` → `activate`) or, if
  none, `sessionStore.clearAll()` + `phase = .loggedOut`.

### 1.5 Completing a login (`AppState.completeLogin` / `LoginView.complete`)

Every successful auth path (password, OAuth, SSO) funnels here:

- `accountTokens.removeAll { $0.userId == token.userId }` then `.append(token)`
  (re-login replaces the old entry, moving it to the end).
- `sessionStore.saveAll(accountTokens)` (throws → LoginView shows
  "Couldn't save the session: {error}").
- `sessionStore.activeUserId = token.session.userId`.
- Build `SessionScope`, store in `scopes`, register badge/auth-error reporting.
- `isAddAccountPresented = false`; `phase = .active(scope)`.
- iOS: `PushRegistry.shared.setActiveService(scope.service)`.

`AppState.logIn(homeserver:username:password:)` is a convenience wrapper:
`MatrixService.logIn` → `completeLogin`.

### 1.6 Multi-account: add & switch

- **Add account:** set `isAddAccountPresented = true` → presents `LoginView`
  as a sheet. On success `completeLogin` makes the new account active and
  dismisses. Accounts are stored **in sign-in order** in `accountTokens`.
- **Switch account** (`switchAccount(to:)`): no-op if already active; else
  `activate(userId:)` — instant if the scope is warm, else a restore. **Warm
  scopes are kept across switches** (`scopes` dict keyed by user ID), so
  switching back is immediate and sync keeps running for background accounts.
- `AppState.isQuickSwitcherPresented` drives an account quick-switcher UI.
- Background accounts continue to sync; the app badge is the **unread sum over
  all warm scopes** (`updateAggregateBadge`), and each warm scope's auth-error
  signal is monitored so a revoked *background* account is also signed out.
- `sessionForNotificationAction(accountUserId:)` resolves which session a
  notification action targets, switching accounts first if needed.

### 1.7 Sign-out (`logOut`)

- `isSignOutConfirmPresented` gates a confirmation dialog.
- `logOut()`:
  - Cancel reconnect. If not `.active`, just `phase = .loggedOut`.
  - Tear down scope; clear notification handlers.
  - `await scope.service.logOut()`:
    - Stop sync monitor / send-queue tasks, end macOS background activity.
    - `syncService.stop()`.
    - **Best-effort, time-bounded (8s)** `encryption().waitForBackupUploadSteadyState(progressListener:nil)`
      so recent message keys reach key backup before the store is destroyed.
    - `client.logout()` (the network logout).
  - Remove session directories, room-list snapshot, media disk cache; drop from
    `scopes`; update badge.
  - Remove token, persist. Fall to **next account** (`activate`) or
    `clearAll()` + `.loggedOut`.

---

## 2. State Machine & Data Flow

### 2.1 `AppState.Phase`

```
enum Phase {
  case launching                // initial; restoring last-active account
  case loggedOut                // no accounts (show LoginView full-window)
  case disconnected             // token kept, server unreachable, retrying/30s
  case active(SessionScope)     // signed in and running
}
```

Transitions:

```
launching ──start(): no tokens──────────────────► loggedOut
launching ──start(): restore OK─────────────────► active(scope)
launching ──restore fails (network)─────────────► disconnected ──(retry 30s)──► active
active ────logOut(): last account───────────────► loggedOut
active ────logOut(): other accounts remain──────► launching → active(next)
active ────handleAuthError: last account────────► loggedOut
active ────handleAuthError: other accounts──────► launching → active(next)
active ────switchAccount / activate─────────────► active(other)
loggedOut ─completeLogin (or add-account)───────► active(new)
```

Note: `disconnected` covers only restore-time network failure. A **revoked
token** does *not* go through `disconnected`; it surfaces later via the auth
error stream and routes to `handleAuthError`.

### 2.2 In-memory state owned by `AppState`

- `phase: Phase`
- `accountTokens: [RestorationToken]` — all signed-in accounts, in sign-in
  order (persisted).
- `scopes: [String: SessionScope]` — warm sessions keyed by user ID (in-memory
  only).
- `reconnectTask: Task?` — the 30s retry loop.
- `authErrorHandledUserIds: Set<String>` — once-per-account teardown guard.
- Sign-in UI flags: `isAddAccountPresented`, `isQuickSwitcherPresented`,
  `isSignOutConfirmPresented`.

### 2.3 `SessionScope` contents (per signed-in session; torn down wholesale)

- `service: MatrixService` (owns the FFI `Client` + sync).
- `token: RestorationToken`.
- `roomList: RoomListViewModel`, `mediaLoader`, `stickers`, `customEmoji`,
  `presence`, `pronouns`.
- Own-profile state: `ownAvatarURL`, `ownDisplayName`, `ownPronouns`, `ownBio`,
  `ownStatus`, `ownTimezone`, `ownBannerURL`, `ownSocialLinks`.
- Encryption/verification: `needsVerification`, `incomingVerification`,
  verification monitor tasks & delegate bridge.
- `onAuthError: ((String) -> Void)?` + `startAuthErrorMonitor()`.
- Live-timeline LRU cache (cap **8**), call view-model cache.
- `userId` = `service.userId`.

### 2.4 `RestorationToken` (persisted, `Codable`)

```
struct RestorationToken {
  var session: SessionData        // mirror of FFI Session (see below)
  var storePassphrase: String     // random 32-byte base64; keys SQLCipher store
  var dataPath: String            // per-session store dir
  var cachePath: String           // per-session cache dir
}
struct SessionData {              // exact FFI Session field mirror
  var accessToken: String
  var refreshToken: String?
  var userId: String
  var deviceId: String
  var homeserverUrl: String
  var oauthData: String?          // opaque OAuth/MAS metadata blob from SDK
  var slidingSyncVersion: String  // "native" | "none"
}
```

`RestorationToken.SessionData` <-> FFI `Session` conversion lives in
`RestorationToken+FFI.swift`. `slidingSyncVersion` maps `.native`→`"native"`,
else `"none"`; restore maps `"native"`→`.native`, else `.none`.

### 2.5 Token persistence & rotation (`SessionStore`)

- Keychain-backed (native): service `"com.riiiiiiiley.Discourse"`, account
  `"sessions"` = JSON array of `RestorationToken`. Legacy single-account item
  `"activeSession"` is migrated on first `loadAll` then deleted.
- `activeUserId` persisted in `UserDefaults` (`"activeUserId"`).
- **All array mutations serialized under `NSLock`.** Critical: OAuth token
  refreshes arrive on background (Rust) threads and can overlap; without the
  lock a load→mutate→save race drops a freshly-rotated refresh token.
- `mutate(_:)` = locked read-modify-write; used by `SessionDelegate` to persist
  a rotated token while preserving `storePassphrase`/`dataPath`/`cachePath`.
- Keychain accessibility: `kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly`
  (never syncs to iCloud, readable by background relaunch). iOS uses a shared
  access group when push is enabled so the NSE can read the token.
- **Store directories** (`makeSessionDirectories(id:)`): `id` is a UUID minted
  at login *before* the user ID is known, persisted in the token. Data →
  Application Support/`Sessions/<id>`, cache → Caches/`Sessions/<id>` (or App
  Group container on iOS with push). `currentSessionDirectories` re-resolves
  the paths against the current container (iOS moves the sandbox between
  installs; only the dir *name* is stable). `removeSessionDirectories` on
  logout/auth-error.
- `randomPassphrase()` = 32 bytes from `SecRandomCopyBytes` (CSPRNG fallback),
  base64. Keys the SQLCipher store.

### 2.6 Client construction (`MatrixService.buildClient`)

`ClientBuilder` chain (login uses `slidingSyncVersion: .discoverNative`;
restore passes the stored version to skip rediscovery):

```
ClientBuilder()
  .serverNameOrHomeserverUrl(serverNameOrUrl: homeserver)
  .sqliteStore(SqliteStoreBuilder(dataPath, cachePath).passphrase(passphrase))
  .slidingSyncVersionBuilder(versionBuilder: <.discoverNative | .native | .none>)
  .setSessionDelegate(sessionDelegate:)          // persists token refreshes
  .autoEnableCrossSigning(true)
  .autoEnableBackups(true)
  .backupDownloadStrategy(.afterDecryptionFailure)
  .enableShareHistoryOnInvite(true)
  .build()
```

`MatrixService.init` calls `client.setDelegate(clientDelegateBridge)` to arm the
auth-error stream (covers both login and restore).

`MatrixPlatform.initializeOnce()` (`initPlatform(config:useLightweightTokioRuntime:)`)
runs once before any `ClientBuilder`. **Web analog:** the WASM SDK's one-time
`initAsync()` / module init.

### 2.7 Session-delegate token refresh (`SessionDelegate: ClientSessionDelegate`)

- `retrieveSessionFromKeychain(userId:)` → the stored `Session`, or throws
  `MatrixServiceError.sessionNotFound` (expected during fresh login).
- `saveSessionInKeychain(session:)` → locked `mutate` that overwrites just the
  `SessionData` for the matching user (preserving passphrase/paths). Unknown
  user (fresh login before `completeLogin` persists it) → no-op.

This is what keeps **rotating MAS refresh tokens** valid across relaunches;
without it restore would be fed an already-consumed token.

---

## 3. FFI Symbol Catalog (this slice)

Flat catalog of every `MatrixRustSDK` symbol used across the auth/session
lifecycle. Grouped for readability; treat as the checklist for the WASM binding
surface the web must cover.

**Platform init**
- `initPlatform(config:useLightweightTokioRuntime:)`
- `TracingConfiguration(logLevel:traceLogPacks:extraTargets:writeToStdoutOrSystem:writeToFiles:sentryConfig:)`

**Client construction**
- `ClientBuilder()`
- `ClientBuilder.serverNameOrHomeserverUrl(serverNameOrUrl:)`
- `ClientBuilder.sqliteStore(config:)`
- `SqliteStoreBuilder(dataPath:cachePath:)`
- `SqliteStoreBuilder.passphrase(passphrase:)`
- `ClientBuilder.slidingSyncVersionBuilder(versionBuilder:)`
- `SlidingSyncVersionBuilder` (enum: `.discoverNative`, `.native`, `.none`)
- `ClientBuilder.setSessionDelegate(sessionDelegate:)`
- `ClientBuilder.autoEnableCrossSigning(autoEnableCrossSigning:)`
- `ClientBuilder.autoEnableBackups(autoEnableBackups:)`
- `ClientBuilder.backupDownloadStrategy(backupDownloadStrategy:)` — `.afterDecryptionFailure`
- `ClientBuilder.enableShareHistoryOnInvite(enableShareHistoryOnInvite:)`
- `ClientBuilder.build()`

**Client — auth & session**
- `Client.userId()`
- `Client.session()` → `Session`
- `Client.homeserverLoginDetails()` → `HomeserverLoginDetails`
- `HomeserverLoginDetails.supportsPasswordLogin()`
- `HomeserverLoginDetails.supportsOauthLogin()`
- `HomeserverLoginDetails.supportsSsoLogin()`
- `Client.login(username:password:initialDeviceName:deviceId:)`
- `Client.urlForOauth(oauthConfiguration:prompt:loginHint:deviceId:additionalScopes:)` → `OAuthAuthorizationData`
- `OAuthConfiguration(clientName:redirectUri:clientUri:logoUri:tosUri:policyUri:staticRegistrations:)`
- `OAuthAuthorizationData.loginUrl()`
- `Client.loginWithOauthCallback(callbackUrl:)`
- `Client.abortOauthAuth(authorizationData:)`
- `Client.startSsoLogin(redirectUrl:idpId:)` → `SsoHandler`
- `SsoHandler.url()`
- `SsoHandler.finish(callbackUrl:)`
- `Client.restoreSession(session:)`
- `Client.logout()`
- `Client.setDelegate(delegate:)` → `TaskHandle`

**Session record**
- `Session(accessToken:refreshToken:userId:deviceId:homeserverUrl:oauthData:slidingSyncVersion:)`
- `Session.accessToken`, `.refreshToken`, `.userId`, `.deviceId`,
  `.homeserverUrl`, `.oauthData`, `.slidingSyncVersion`
- `SlidingSyncVersion` (enum: `.native`, `.none`)

**Session delegate (token refresh persistence)**
- `ClientSessionDelegate` (protocol)
- `ClientSessionDelegate.retrieveSessionFromKeychain(userId:)` → `Session`
- `ClientSessionDelegate.saveSessionInKeychain(session:)`

**Client delegate (auth-error / soft-logout signal)**
- `ClientDelegate` (protocol)
- `ClientDelegate.didReceiveAuthError(isSoftLogout:)`
- `ClientDelegate.onBackgroundTaskErrorReport(taskName:error:)`
- `BackgroundTaskFailureReason`

**Encryption (touched during restore / logout)**
- `Client.encryption()` → `Encryption`
- `Encryption.waitForE2eeInitializationTasks()`
- `Encryption.waitForBackupUploadSteadyState(progressListener:)`

**Sync lifecycle (created after auth; adjacent to this slice)**
- `Client.syncService()` → `SyncServiceBuilder`
- `SyncServiceBuilder.withOfflineMode()`
- `SyncServiceBuilder.withRoomListTimelineLimit(limit:)`
- `SyncServiceBuilder.finish()` → `SyncService`
- `SyncService.roomListService()` → `RoomListService`
- `SyncService.state(listener:)` → `TaskHandle`
- `SyncService.start()`, `SyncService.stop()`
- `SyncServiceState` (enum: `.idle`, `.running`, `.error`, `.offline`, `.terminated`)
- `SyncServiceStateObserver` (protocol; `onUpdate(state:)`)
- `Client.subscribeToSendQueueStatus(listener:)` → `TaskHandle`
- `SendQueueRoomErrorListener` (protocol; `onError(roomId:error:)`)
- `Client.enableAllSendQueues(enable:)`
- `ClientError`
- `TaskHandle`

**Errors**
- `ClientBuildError` / SDK errors surfaced as `Error` (mapped to friendly text).

> Web note: the WASM binding names match closely (e.g.
> `clientBuilder.build()`, `client.login(...)`, `client.urlForOauth(...)`,
> `client.loginWithOauthCallback(...)`, `client.startSsoLogin(...)`,
> `ssoHandler.finish(...)`, `client.restoreSession(...)`, `client.logout()`,
> `client.setDelegate(...)`, `client.session()`). Verify exact camelCase and
> promise semantics against the shipped `.d.ts`.

---

## 4. Web-Platform Mapping

| Native concern | Native mechanism | Web analog |
|---|---|---|
| SDK platform init | `initPlatform(...)` once | WASM module `init()`/`initAsync()` once at boot |
| Client store | `SqliteStore` at `dataPath`/`cachePath` with SQLCipher passphrase | WASM SDK **IndexedDB** store; pass a store name/prefix per account. Passphrase → an IndexedDB store encryption key (WebCrypto). `dataPath`/`cachePath` collapse to an IndexedDB DB name derived from the per-account UUID. |
| Store passphrase | 32-byte CSPRNG (`SecRandomCopyBytes`) | `crypto.getRandomValues(new Uint8Array(32))`; base64 |
| Restoration token storage | Keychain (`kSecAttr...AfterFirstUnlockThisDeviceOnly`) | **IndexedDB** record (or `localStorage` for non-secret parts). For at-rest protection, wrap `accessToken`/`refreshToken` with a non-extractable WebCrypto key stored in IndexedDB, or keep the client store's own persisted session and only persist minimal metadata. In-memory-only is the fallback for a "don't remember me" mode. No true secure enclave on web — document this as a security delta. |
| `activeUserId` (UserDefaults) | UserDefaults key | `localStorage["activeUserId"]` |
| Concurrent token-refresh RMW lock | `NSLock` around the token array | A JS async mutex (single-threaded JS avoids data races, but refresh + save still interleave across awaits — serialize with a promise queue) |
| OAuth/SSO browser flow | `ASWebAuthenticationSession` + custom scheme `com.riiiiiiiley.discourse:/oauth-callback` | **Web redirect flow**: register an **https redirect URI page** (e.g. `https://app.example/oauth-callback`) in `OAuthConfiguration.redirectUri`. Redirect the top-level window (or a popup) to `loginUrl()`; the callback page reads `window.location.href` and hands the full URL to `loginWithOauthCallback(...)`. Persist the pre-redirect `PendingLogin`/`OAuthAuthorizationData` in `sessionStorage` since a full-page redirect loses in-memory state (popup avoids this). MAS's dotted-scheme requirement is a native quirk; https redirect URIs are the norm on web. |
| SSO handler | `SsoHandler.url()` / `.finish(callbackUrl:)` | same, with the https redirect page supplying the callback URL |
| User-cancel detection | `ASWebAuthenticationSessionError.canceledLogin` / `URLError.cancelled` | Popup closed / redirect page reports `error=access_denied` / no code param → treat as cancel, suppress error toast |
| Token-refresh delegate | `ClientSessionDelegate` writing keychain | Same delegate interface in the WASM SDK, persisting the rotated `Session` to **IndexedDB** under the account key |
| Auth-error signal | `ClientDelegate.didReceiveAuthError(isSoftLogout:)` | Same delegate; route to the `handleAuthError` equivalent |
| iOS App Group / NSE token sharing | shared keychain access group + App Group store dir | **Native-only** — no web analog (no push service extension). Web push (if any) is a separate service worker; omit for parity v1. |
| macOS App Nap suppression | `ProcessInfo.beginActivity` | **Native-only.** Web analog: keep the tab's sync alive; a Service Worker or the Page Visibility API can help, but background throttling in hidden tabs is a platform delta to document. |
| App badge (aggregate unread) | `Platform.setBadge` | `navigator.setAppBadge()` (PWA, where supported) or document-title/favicon badge |
| Per-account store cleanup on logout | delete SQLite dirs | `indexedDB.deleteDatabase(...)` for the account's DBs |

**Native-only, no web equivalent needed for v1:** keychain access groups, NSE
session sharing, App Group container relocation logic, App Nap background
activity, `PushRegistry.setActiveService`.

---

## 5. Parity Checklist (acceptance criteria)

**Homeserver & discovery**
- [ ] Homeserver field defaults to `matrix.org`; empty → treated as `matrix.org`.
- [ ] Continue triggers discovery via `homeserverLoginDetails()`; busy spinner
      shown; field/button disabled while busy.
- [ ] Discovery failure shows "Couldn't reach {homeserver}: {error}" and stays
      on the server stage.
- [ ] "Use a different homeserver" resets to the server stage and clears the
      password + error.

**Method rendering precedence**
- [ ] OAuth shown as prominent "Sign In with Browser" and **takes priority over
      SSO**.
- [ ] SSO shown only when OAuth absent; prominent only if password also absent.
- [ ] Password block shown iff supported; "or" divider only when a browser
      method is also present.
- [ ] "This homeserver offers no supported sign-in method." shown when all three
      are false.
- [ ] Sign In disabled unless username (trimmed) non-empty **and** password
      non-empty.

**Password login**
- [ ] Success routes to `completeLogin`; account made active and persisted.
- [ ] `initialDeviceName` set to a Discourse-branded value.
- [ ] M_FORBIDDEN / "forbidden" maps to "Incorrect username or password."
- [ ] `passwordLoginUnsupported` maps to the exact native message.

**OAuth / SSO browser flow**
- [ ] Redirect uses the configured redirect URI; callback URL is passed intact
      to `loginWithOauthCallback` / `SsoHandler.finish`.
- [ ] OAuth failure calls `abortOauthAuth` to release the pending auth.
- [ ] User cancellation suppresses the error message; other failures show
      "Sign-in failed: {error}".
- [ ] `OAuthConfiguration.clientName` = "Discourse", `clientUri` set.

**Session restore on launch**
- [ ] With stored accounts, restores `activeUserId` (or first account) without a
      login screen.
- [ ] Warm scope → instant activation; cold → `restoreSession` then sync.
- [ ] Restore network failure → `.disconnected`, retried every 30s until
      reachable.
- [ ] Cached sidebar snapshot painted before flipping to `.active`.

**Token rotation & persistence**
- [ ] Mid-session OAuth/MAS refresh is persisted via the session delegate
      (rotated refresh token survives relaunch).
- [ ] Concurrent refresh/save is serialized (no dropped rotated token).
- [ ] Each account has an isolated store keyed by its login-time UUID; passphrase
      is 32-byte CSPRNG.

**Auth-error / soft-logout**
- [ ] `didReceiveAuthError` (soft-logout or unknown token) removes the account
      **without a network logout**, dropping its store/snapshot/cache.
- [ ] Handling is idempotent per account (repeated delegate fires are ignored).
- [ ] Active dead account falls to the next account, or `.loggedOut` if none.
- [ ] A revoked **background** account is also signed out.

**Multi-account**
- [ ] Add-account presents login as a cancelable sheet; success makes the new
      account active and dismisses.
- [ ] Accounts stored in sign-in order; re-login replaces the existing entry.
- [ ] Switch is instant for warm scopes; background accounts keep syncing.
- [ ] App badge is the unread sum across all warm accounts.

**Sign-out**
- [ ] Confirmation gate before sign-out.
- [ ] Best-effort, ≤8s key-backup flush before store destruction.
- [ ] Network `logout()` called; store/snapshot/cache removed; notification
      handlers cleared.
- [ ] Falls to next account, or `.loggedOut` if it was the last.

**Platform-delta documentation**
- [ ] Token storage security delta (no secure enclave on web) documented in the
      implementation.
- [ ] Custom-scheme → https redirect-URI substitution documented and the
      redirect page implemented.
