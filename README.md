# Discourse for Matrix — Web

A browser port of the native SwiftUI Discourse client. It runs the **same
`matrix-rust-sdk`** the native app uses, compiled to WebAssembly with a
TypeScript FFI (via `uniffi-bindgen-react-native`). So this is a *port*, not a
rewrite: `Client`, `SyncService`, `RoomListService`, `Room`, `Timeline`,
`Encryption`, verification, etc. carry across from the Swift app almost
name-for-name. Only the UI layer (SwiftUI → React) is new.

## Running

```bash
npm install --ignore-scripts   # --ignore-scripts: the uniffi runtime's postinstall
                               # builds React-Native native modules we don't use;
                               # the web build consumes the prebuilt wasm directly.
npm run dev                    # http://localhost:5173  (first load fetches a ~48MB wasm)
npm run build                  # production bundle
npm run typecheck              # tsc over src (generated bindings excluded)
```

## Architecture

Mirrors the native app's layering so each `*.swift` file has a clear counterpart:

- `src/matrix/` — the Rust SDK: prebuilt `generated/` bindings + `index_bg.wasm`
  (vendored from Element's `aurora` experiment) and `uniffiInitAsync()`. Import
  everything from `@/matrix`.
- `src/core/` — services (the `Core/` analog): `reactive.ts` (a `ViewModel`
  base that reproduces Swift's `@Observable` + a `useViewModel` hook),
  `MatrixSession` (sync lifecycle + authenticated client-server REST),
  `SessionStore` (multi-account, IndexedDB-isolated stores), `clientBuilder`,
  `MediaLoader`, `Preferences`, `CustomEmojiStore`, `StickerStore`,
  `PresenceService`, listener bridges.
- `src/models/types.ts` — the value-type layer (`Models/`): `RoomSummary`,
  `TimelineEntry`, the `EventContent` union. FFI objects are mapped to these
  once, up front, so SDK calls stay off React's render path.
- `src/features/` — one folder per screen (the `Features/` analog): `auth`,
  `roomlist`, `timeline`, `pickers`/`emotes`, `compose`, `search`,
  `quickswitcher`, `settings`, `profile`, `call`, `verification`.
- `src/app/` — `AppState` (root state machine: launching → loggedOut →
  disconnected → active), `MainShell` (three-pane layout + cross-cutting
  overlays), context, keyboard shortcuts.

## Important: generated-bindings patch

The vendored bindings are generated with `async public method()` modifier
ordering, which `tsc` tolerates but **esbuild rejects**. They were rewritten to
`public async method()` (253 sites in `matrix_sdk_ffi.ts`). If you ever
regenerate the bindings, re-apply:

```bash
perl -pi -e 's/\basync (public|private|protected|static) /$1 async /g' \
  src/matrix/generated/*.ts
```

The SDK version in the vendored bindings differs slightly from the Swift app's
`26.06.06`; a few methods are renamed (OAuth → `urlForOidc`) or absent
(`withRoomListTimelineLimit`, `sendStateEventRaw`, `searchMessages`) — the port
adapts to the vendored surface. To match the Swift API exactly, rebuild the
bindings at 26.06.06 with `ubrn` (the toolchain is installed).

## Status

Builds, typechecks, and serves. Login (password + OIDC), room list/spaces,
timeline, composer/media, reactions/emoji/stickers/polls, settings/profile,
calls (Element Call widget bridge), verification, and presence are all
implemented. Runtime behavior against a live homeserver still needs
in-browser verification.

### Known gaps (consolidated from implementation notes)

- **Web Push / Service Worker** background delivery is not built (foreground
  `Notification` only) — the analog of the iOS NSE pipeline is a follow-up.
- **Custom-emoji / sticker / power-tag stores** are implemented but not yet
  provisioned per-session into the timeline/composer, so those enrichments are
  inactive until a session-scoped provider is wired.
- **Message search** — this SDK build exposes no `searchMessages`; only user +
  public-room search are wired.
- **State-event writes** (`sendStateEventRaw` absent) — Cinny role labels and
  space banners fall back to raw REST `PUT .../state/...` where implemented.
- Two parallel prefs stores exist (`core/Preferences` + `settings/settingsPrefs`)
  and should be unified.
- Cold-launch room-list snapshot, scroll-position restore, and receipt-avatar
  images are deferred.
