# Parity Spec 05 — Emoji / Stickers / Custom Emotes / Polls / Reactions

Scope: the standard emoji picker, MSC2545 custom emoji/emotes (room + space + personal
packs), the sticker picker + sending, poll creation/rendering/voting/ending, message
reactions (unicode + custom-image), and Cinny-compatible power-level tags/badges. Target
for the rewrite is TypeScript/React over `matrix-js-sdk` (or the rust SDK WASM bindings);
this document maps every native behavior and FFI call to a web equivalent.

Source files audited:
`Discourse/Features/Timeline/EmojiPickerView.swift`,
`Discourse/Features/Timeline/EmoteViews.swift`,
`Discourse/Features/Timeline/PollView.swift`,
`Discourse/Features/Stickers/StickerPickerView.swift`,
`Discourse/Core/StickerStore.swift`,
`Discourse/Core/CustomEmojiStore.swift`,
`Discourse/Core/PowerLevelTags.swift`,
`Discourse/Features/Settings/EmotePackEditor.swift`,
plus `TimelineViewModel.swift`, `ComposerView.swift`, `MessageRow.swift`,
`Models/TimelineEntry.swift`, `Models/TimelineEntry+FFI.swift`, `Core/MediaLoader.swift`,
`Core/UsageTracker.swift`, `Core/MatrixService.swift`, `App/AppState.swift`.

---

## 1. User-facing behaviors

### 1.1 Standard emoji picker (`EmojiPickerView`)

The system emoji palette can't be anchored to a button (it follows the text caret), so the
app draws its own picker. Fixed **320×320** on macOS; fills the popover/expression panel on iOS.

- **Categories** — 11 hard-coded unicode categories, in a fixed order, each with an SF-Symbol
  icon and a localized title. The full glyph lists live inline in the Swift source
  (`EmojiPickerView.categories`) — roughly 1400 glyphs across:
  Smileys, People & Body, People & Clothing, Animals & Nature, Food & Drink, Activity,
  Travel & Places, Objects, Symbols, Flags. (The catalog is deliberately curated — **no skin-tone
  variant grid**; see below.)
- **Single continuous scroll**: every category renders as a titled `LazyVStack` section in one
  scroll view (not tab-swapped). A bottom **category bar** jumps to a section on tap
  (`scrollTo(index, anchor: .top)`), and the bar highlight *follows the scroll* — the section
  whose header most recently crossed the top line (minY ≤ 90 in the scroll coordinate space)
  is the active tab. Header positions are tracked in an out-of-observation reference box so
  per-frame scroll writes don't invalidate the ~1400-cell grid; only the derived active index
  hits state, on flip.
- **Search** — a top search field (carved out via `safeAreaInset(.top)`). Matching is a
  case-insensitive `contains` over each glyph's **Unicode name** (`applyingTransform(.toUnicodeName)`,
  e.g. "grinning face"), built once into a `searchIndex`. ZWJ sequences flatten to component
  names — fine for contains-matching. Empty results show `ContentUnavailableView.search`.
  Autocorrection is disabled (shortcodes aren't dictionary words). A clear (✕) button appears
  when non-empty. Search focus is reported up (`onSearchFocusChange`) so the iOS expression
  panel coexists with the keyboard.
- **Frequently Used / recents** — persisted in `@AppStorage("recentEmoji")` as a space-joined
  string, **max 24**, most-recent-first, de-duplicated. Shown as a "Frequently Used" section
  (index `-1`) at the top when non-empty, with a clock icon in the bar. Every insert calls
  `remember(emoji)`.
- **Skin tones** — **NOT IMPLEMENTED.** There is no skin-tone modifier UI; the catalog stores
  default-toned glyphs only. **The web rewrite may add a skin-tone selector, but it is not
  required for parity.** If added, it must not change the recents storage format (plain glyph
  strings) incompatibly.
- **Insert** — tapping a unicode glyph calls `insert(emoji)` + `remember(emoji)`. The consumer
  (composer inserts into text; reaction surface toggles a reaction).
- **Custom packs above unicode** — when the surface supports custom emoji (`insertCustom != nil`),
  every custom pack with ≥1 emoticon renders as its own titled section *above* the unicode
  categories (section index `100 + packOrder`), with a pack tab in the bar whose icon is the
  pack avatar (or a star fallback). Sticker-only packs are excluded here (they'd send literal
  `:text:`). Custom search results (matching shortcode or body, colons stripped) render above
  unicode search results. Opening the picker fires `customEmoji.refreshIfStale()`.

### 1.2 Custom emoji / emotes (MSC2545)

Custom emoji ("emotes") are MSC2545 image emoji. An emote has: a shortcode (no colons), an
`mxc://` url, a body, a pack id, an optional `usage` set (`emoticon` / `sticker`; **empty = usable
as both**), and optional `info` (w/h/mimetype/size). `token` is `:shortcode:`.

Sources (aggregated by `CustomEmojiStore`):
- **Personal pack** — `im.ponies.user_emotes` account data, only emoticon-usage images.
  Display name "My Emoji". (Note: the same account-data event also carries the user's *stickers*
  — see `StickerStore` — so writes to it must merge, never replace.)
- **Space packs** — `im.ponies.room_emotes` state events in every joined **space** (state key may
  vary; a room can carry multiple packs under different state keys).
- **Opted-in room packs** — rooms listed in `im.ponies.emote_rooms` account data
  (`content.rooms` keys).
- **Session rooms** — any room whose timeline was opened this session (`ensureRoomPack`), fetched
  once per room.

Behaviors:
- **`:shortcode:` autocomplete** (composer) — typing a colon at a word start followed by ≥2
  shortcode characters opens a suggestion list: custom emotes first (prefix matches, then contains),
  then unicode-shortcode matches (`EmojiShortcodes.matches`), capped at 8. Suppressed while a
  mention (`@`) query is active. Accepting a custom emote inserts its `:shortcode: ` (kept as a
  token, converted at send). Accepting a unicode suggestion inserts the glyph.
- **Closing-colon auto-replace** — typing the closing `:` of a *complete known unicode* shortcode
  (`:pleading_face:`) swaps it for the glyph inline. Custom emotes stay as `:token:`. Guarded so
  `10:30:` and `@user:server` survive.
- **Send as inline** — on send, `CustomEmojiStore.htmlBody(for:)` scans the plain text for known
  `:shortcode:` tokens and, if any match, produces an MSC2545 **formatted (HTML) body** where each
  token becomes `<img data-mx-emoticon src="mxc://…" alt=":code:" title=":code:" height="32" />`.
  The plain body keeps the `:token:` text (the img alt). mxc urls are validated to reject anything
  breaking out of an HTML attribute.
- **Render inline** (`EmoteBodyText`) — incoming messages: MSC2545 `<img data-mx-emoticon>` tags in
  the formatted body are parsed (`InlineEmotes.parse`) into a `:shortcode: → mxc` map; the plain
  body is split on those tokens and each is swapped for its image. Also accepts any mxc `<img>`
  whose alt/title is a bare `:shortcode:` (some clients omit the marker attribute). A **fallback**
  (`CustomEmojiStore.knownEmotes(in:)`) maps `:tokens:` in a plain body to locally-known emotes when
  the HTML never arrived. Emotes render **inline** at a text-tracking cap height (base 18pt macOS /
  21pt iOS, scaled 0.8–1.4 by the chat text-size preference), or **jumbo** (44pt image views) when the
  message is nothing but emotes + whitespace and ≤6 emotes. Until the bitmap lands, the literal
  `:token:` shows in secondary color.
- **Send as reaction** — from the reaction picker, a custom emote reacts with **its mxc url as the
  reaction key** (`toggleReaction(emote.url)`). Reaction chips render `mxc://` keys as images and
  resolve them back to `:shortcode:` for labels/hover via `customEmoji.byUrl`.
- **Editing room/space packs** (`EmotePackEditor`) — for the default (state key `""`) pack of a
  room/space, list current emotes with usage label + delete, and add one: name → shortcode
  (sanitized lowercased, spaces→`_`, `[a-z0-9_.-]`), usage segmented control (Emoji / Sticker /
  Both), and an image. Small animated GIF/WebP (>1 frame, ≤512 KB) is kept as-is; everything else
  is downscaled to ≤256 px and flattened to PNG (transparency preserved). Writes require state-event
  permission (M_FORBIDDEN → "You don't have permission…"). Footer clarifies emotes are shared with
  everyone in the room/space.

### 1.3 Sticker picker + sending (`StickerPickerView`, `StickerStore`)

Two sticker sources shown in one picker:
- **Personal stickers** — `StickerStore`, backed by `im.ponies.user_emotes` account data entries
  with `usage: ["sticker"]` (or the `es.discourse.pack` tag). Organized into Discourse-specific
  named **packs** (`es.discourse.pack`, default "My Stickers"). Created/managed in Settings.
- **Room/space pack stickers** — `CustomEmojiStore.stickerPacks` (room packs with ≥1 sticker-usage
  emote), only shown when a `sendPackSticker` handler is present.

Behaviors:
- Grid of ~72px thumbnails, 4 columns (macOS fixed) / adaptive (iOS). Personal packs first (each
  as a titled section), then room packs. A bottom **pack bar** (same follow-the-scroll highlight as
  the emoji picker) jumps between packs; each tab icon is the pack's first sticker (or pack avatar).
- **Recently Used** — `StickerUsage.recents` (UserDefaults `recentStickers`, max 16, keyed by
  shortcode), shown as a top section + clock tab when non-empty.
- **Search** — case-insensitive contains over shortcode or body, across both personal and room-pack
  stickers.
- **Send** — tapping a sticker calls `send`/`sendPackSticker`; the panel stays up for chaining and
  fires a light haptic on iOS. Recents are recorded for personal stickers.
- Empty state: "No stickers yet — Make some in Settings → Stickers."

### 1.4 Polls (`PollView`, `NewPollSheet`)

- **Creation** (`NewPollSheet`) — question + 2–8 options (add/remove; min 2 enforced), and a
  "Show results while the poll is open" toggle (disclosed vs undisclosed). Create is disabled until
  the question is non-empty and ≥2 non-empty options. iOS: Form in a NavigationStack with
  Cancel/Create toolbar and medium/large detents; macOS: fixed 380px panel. Trims + drops empty
  options on submit; `maxSelections` is hard-coded to **1** (single-choice).
- **Rendering** (`PollView`, max width 380) — chart icon + question, then each answer as a
  votable row: a radio/check indicator (filled when voted by me), the answer text, and — when
  results are shown — the vote count with a proportional tint fill bar behind the row.
  Results are shown when `isDisclosed || isEnded || votedByMe`. Footer: total-vote count (or
  "Final result — N votes" when ended), a "Results shown when the poll ends" hint for undisclosed
  polls, and an **End Poll** button for the author (`message.isOwn && !isEnded`).
- **Voting** — tapping an answer (allowed only while not ended) sends a poll response for that
  answer id. Voting flips `answer.votedByMe` and re-reveals results.
- **Ending** — the author's "End Poll" button ends the poll with text "The poll has ended."
  Ended polls disable all rows and always show final results.
- Full a11y: each option is one spoken element (text + vote count + selected trait); the status
  captions are combined into one element.

### 1.5 Reactions (`MessageRow` / `ReactionChips`, `TimelineViewModel.toggleReaction`)

- **Model** — `MessageReaction { key: String, senders: [String] }`; `count = senders.count`;
  `includesOwn(userId:)`. Built from FFI `msgLike.reactions` (`key`, `senders[].senderId`).
- **Add / remove** — a single **toggle**: `toggleReaction(key, on: message)`. Unicode keys are
  recorded in `ReactionUsage` (feeds the quick-react palette); mxc (custom) keys are not.
- **Reaction chips** — under each message: one chip per reaction key with its glyph/image + count;
  the current user's own reactions are tinted. mxc keys render as images (`EmoteImageView`) and
  resolve to `:shortcode:` labels via `customEmoji.byUrl`. Tapping a chip toggles your reaction. A
  trailing "+" chip opens the reaction picker. Hover/long-press reveals who reacted (sender names).
- **Quick reactions** — a palette row of the top-5 most-used unicode reactions
  (`ReactionUsage.top(5)`, defaults `👍 ❤️ 😂 🎉 😮 😢 🔥 👀`, filtered to true emoji so text keys
  like "+1" don't render blank), plus a "More Reactions…" entry opening the full picker.
- **Reaction keys are arbitrary strings** — a Matrix reaction key can be a unicode glyph, an mxc
  url (custom emote), or arbitrary text ("+1", "lol"); the UI handles all three.

### 1.6 Power-level tags / badges (`PowerLevelTags`)

Cinny-compatible named roles, from the `in.cinny.room.power_level_tags` state event (flat map
`powerLevel → { name, color?, icon: { key } }`). `icon.key` is either a **unicode emoji** or an
**mxc:// custom-emote url** (`iconIsMxc`). `displayTag(forLevel:)` returns the exact tag, else the
nearest defined tag at or below the level (so a room creator with "infinite" power inherits the top
role), else a coarse built-in default (Muted <0, Member 0–49, Moderator 50–99, Admin ≥100). Editable
in room settings (writes the whole map, dropping tags equal to the default). Displayed as a badge near
member names / in the member list.

---

## 2. Data flow

### 2.1 Custom-emoji discovery & caching (`CustomEmojiStore`)

- **Aggregation** into `packs` (personal first, then room packs A–Z, empty packs dropped), plus two
  derived indexes rebuilt on every change:
  - `byShortcode: [shortcode → Emote]` — emoticon-usage only, first-wins with personal prioritized
    (backs autocomplete + inline send/render).
  - `byUrl: [mxc → Emote]` — any usage (backs labelling image reactions).
- **`refreshIfStale(force:)`** — full refresh throttled to **1 pass / 5 min**, *unless the space set
  changed* (a change bypasses the throttle). Concurrent calls await the in-flight task. Safe to call
  on every picker open and autocomplete keystroke. Called: on picker/sticker-panel open, and once
  ~5 s after login (`AppState.init`) so reactions label and autocomplete work before any picker opens.
- **`ensureRoomPack(roomId:roomName:)`** — one fetch per room per session when a timeline opens.
- **Per-room fetch strategy** (cost control — full room state is multi-MB for big spaces):
  - **Full state** via raw REST `GET /_matrix/client/v3/rooms/{roomId}/state` (the FFI exposes no
    arbitrary state read) — records **all** `im.ponies.room_emotes` state keys (even empty packs) so
    later refreshes can poll each key cheaply. Runs nonisolated (off main actor).
  - **Per-key poll** via `GET …/state/im.ponies.room_emotes/{stateKey}` — used when the state-key set
    is known and the last full fetch is < **45 min** old. `.found` updates, `404 → .absent` drops a
    deleted pack, `.failed` (timeout etc.) keeps the cached pack (distinct from absent so a timeout is
    never treated as an empty pack).
  - Full re-fetch runs at most every 45 min per room (only path that discovers packs under *new* state
    keys).
- **Emote parsing** — `content.images` (`shortcode → {url, body?, usage?, info?}`); an image's `usage`
  falls back to the pack's `pack.usage`, then to empty (=both). mxc urls validated (reject whitespace or
  `"'<>&`). Pack meta: `pack.display_name`, `pack.avatar_url`.
- **Spaces provider dependency** — `CustomEmojiStore.spacesProvider: () -> [(id, name)]` is wired by
  the session scope (`AppState.init`) to `roomList.spaces` (weakly held) so the store sees the current
  space rail without owning room-list state. The refresh compares the current space set against the last
  to decide whether to bypass the throttle. **Web mapping:** inject a `getSpaces()` accessor from the
  room-list store; do not couple the emoji store to it directly.
- **Editing** (`addToRoomPack` / `removeFromRoomPack`) — read-modify-write of the default (state key
  `""`) pack: **a read failure MUST abort** the write (writing over a pack we couldn't read would wipe
  everyone's emotes), then `room.sendStateEventRaw(...)`, then a local refetch so pickers update
  immediately.

### 2.2 Personal sticker/emoji storage (`StickerStore`)

- Backed by `im.ponies.user_emotes` account data, key `images` (`shortcode → entry`).
- **Ownership discrimination** (`isSticker`) — an entry is "ours" (a sticker) iff `usage` contains
  `"sticker"`, or it carries the `es.discourse.pack` tag. **Foreign** custom-emoji entries in the same
  event must never be imported, rewritten, or overwritten.
- **Add** — square-crop + downscale image to **512px PNG**, `uploadMedia`, uniquify shortcode against
  both foreign and local entries (numeric suffix), write entry with `usage:["sticker"]`,
  `es.discourse.pack`, and `info` (w/h/mimetype/size).
- **Save** — merges into current server content: drops only our own entries, re-adds all local
  stickers, leaves foreign entries verbatim, never overwrites a foreign shortcode. Adds a default
  `pack.display_name: "Discourse"` if absent.
- Packs are a display-only grouping (`packs` computed from distinct `pack` names in order).

### 2.3 Power-level tags — read via the same raw-REST state read
(`MatrixService.stateEventContent(roomId:type:)` → `GET …/state/{type}` using `apiBase()` for
well-known delegation), parsed by `PowerLevelTags.parse`. Written via `room.sendStateEventRaw`.

---

## 3. FFI symbol catalog (MatrixRustSDK / raw REST)

**Reactions**
- `timeline.toggleReaction(itemId:key:) async throws` — add/remove a reaction; `key` = unicode glyph,
  arbitrary text, or an `mxc://` url for a custom-emote reaction.
- Read: `msgLike.reactions` → `[{ key: String, senders: [{ senderId: String }] }]` on the timeline
  item (`EventTimelineItem` msg-like content).

**Polls**
- `timeline.createPoll(question:answers:maxSelections:pollKind:) async throws` —
  `pollKind: PollKind` (`.disclosed` / `.undisclosed`); app passes `maxSelections: 1`.
- `timeline.sendPollResponse(pollStartEventId:answers:) async throws` — `answers: [String]` (answer ids).
- `timeline.endPoll(pollStartEventId:text:) async throws`.
- Read: timeline item `.poll(question, pollKind: PollKind, maxSelections, answers: [{id, text}],
  votes: [answerId: [userId]], endTime: UInt64?, …)` — `endTime != nil` ⇒ ended;
  `pollKind == .disclosed` ⇒ show live results; `votedByMe` from `votes[id].contains(ownUserId)`.
- Enum `PollKind { .disclosed, .undisclosed }`.

**Stickers (raw event send)**
- `room.sendRaw(eventType:content:) async throws` — sends `m.sticker` with a JSON string content
  (`{ body, url, info: { w, h, mimetype, size } }`). Used for both personal stickers and room-pack
  (MSC2545) stickers.
- For pack stickers missing `info`, pixel size is recovered client-side via
  `MediaSource.fromUrl(url:) throws` + `mediaLoader.fullContent(for:)` + ImageIO.

**Account data (personal emoji/stickers)**
- `client.accountData(eventType:) async throws -> String?` — reads `im.ponies.user_emotes` and
  `im.ponies.emote_rooms` (returns raw JSON string).
- `client.setAccountData(eventType:content:) async throws` — writes `im.ponies.user_emotes`
  (merged JSON string).

**Room state (custom emoji packs, power-level tags)**
- `room.sendStateEventRaw(eventType:stateKey:content:) async throws` — writes
  `im.ponies.room_emotes` (default state key `""`) and `in.cinny.room.power_level_tags`.
- `client.getRoom(roomId:) throws -> Room?` — obtains the `Room` handle for state writes.
- `room.getPowerLevels() async throws` → `.canOwnUserSendState(stateEvent:)` — permission gating.
- **Arbitrary state reads have no FFI** — done via raw client-server REST with the SDK session's
  access token:
  - `GET /_matrix/client/v3/rooms/{roomId}/state` (full state; enumerate all `im.ponies.room_emotes`).
  - `GET /_matrix/client/v3/rooms/{roomId}/state/im.ponies.room_emotes/{stateKey}` (per-pack poll;
    404 ⇒ absent).
  - `GET /_matrix/client/v3/rooms/{roomId}/state/{type}` (power-level tags, via `stateEventContent`).
- `client.session() throws -> Session` — provides `homeserverUrl` + `accessToken` for the raw reads
  (note MEMORY: use `apiBase()`/well-known for the client API base, not the bare `homeserverUrl`).

**Media (emote/sticker/avatar images)**
- `MediaSource.fromUrl(url:) throws -> MediaSource` — mxc → media source.
- `client.getMediaThumbnail(mediaSource:width:height:) async throws -> [UInt8]` — sized thumbnails
  (emote/sticker/avatar rendering via `MediaLoader.thumbnail`/`avatar`).
- `client.getMediaContent(mediaSource:) async throws -> [UInt8]` — full bytes
  (`MediaLoader.fullContent`, e.g. to recover a pack sticker's pixel size before send).
- `client.uploadMedia(mimeType:data:progressWatcher:) async throws -> String` — uploads
  processed sticker/emote PNG (or kept GIF/WebP), returns the `mxc://` url.

**Composer send (context)**
- The formatted-body send path consumes `CustomEmojiStore.htmlBody(for:)` (MSC2545 HTML) as the
  message's formatted body; the plain body keeps `:token:` text. (Send call itself is in the composer
  send path, outside this slice.)

---

## 4. Web mapping (TypeScript/React)

### 4.1 Unicode emoji dataset — **self-hosted, no external CDN**

- Ship a static emoji dataset as bundled JSON — **emojibase** (`@emoji-mart/data` or
  `emojibase-data/en/data.json` + `shortcodes`) — served from the app's own origin. Do **not**
  fetch from a CDN at runtime (matches the native app's fully local catalog and the CSP constraints
  used elsewhere in this project's artifacts).
- Category ordering + curated glyph set: either reuse the dataset's category grouping, or port the
  native `categories` array verbatim for exact parity. The native app has **no skin-tone grid**; if
  the web adds skin tones, gate it behind a modifier so recents storage stays plain-glyph.
- **Shortcodes** — the native app derives shortcodes from Unicode names at runtime
  (`EmojiShortcodes`, e.g. "PLEADING FACE" → `pleading_face`, ZWJ/variation-selector stripped). On
  web, prefer the dataset's own shortcode table but ensure the same normalization so `:code:`
  autocomplete and closing-colon auto-replace behave identically. Provide `matches(needle, limit)`
  = prefix-first then contains.
- **Recents** — `localStorage["recentEmoji"]`, space-joined glyphs, max 24, most-recent-first,
  de-duplicated. **Quick reactions** — `localStorage` usage counts, top-5, filtered to true emoji,
  padded with the default set.

### 4.2 Rendering mxc emote images

- `mxc://` → HTTP thumbnail via the media repo (`/_matrix/client/v1/media/thumbnail/{server}/{id}`
  with auth, or the SDK's `mxcUrlToHttp`). In the browser, inline emotes are simply `<img>` at a cap
  height (base ~18–21px, scaled 0.8–1.4 by chat text-size), so the native ImageIO rasterize-to-exact-
  height cache is **not needed** — the browser scales `<img>` natively; keep a request de-dup + HTTP
  cache. Jumbo mode: `<img>` at ~44px when the message is only emotes (≤6).
- **Inline parse/replace parity** — port `InlineEmotes.parse` (regex over `<img>` tags: accept
  `data-mx-emoticon`, or any mxc img whose alt/title is a `:shortcode:`) and `segments()` (split plain
  body on known `:token:`). Fallback: `knownEmotes(in:)` maps `:tokens:` to locally-known emotes.
- **Send parity** — port `htmlBody(for:)`: scan text for known `:shortcode:`, emit
  `<img data-mx-emoticon src alt title height="32">`, HTML-escape everything, validate the mxc url
  (reject `"'<>&` / whitespace), keep the plain body's `:token:` text; set `format:"org.matrix.custom.html"`.

### 4.3 Autocomplete UI

- Colon-triggered popover: colon at a word start + ≥2 shortcode chars, suppressed during `@` mention
  queries. List = custom emotes first (prefix then contains, cap 6) + unicode shortcode matches
  (cap 6), truncated to 8, keyboard-navigable, Enter/Tab commits. Custom → insert `:shortcode: `;
  unicode → insert glyph. Closing-colon auto-replace for complete known unicode shortcodes only,
  guarded against `10:30:` / `@user:server`.
- Emoji picker: a search field, a scrollable category+pack grid, a bottom category/pack tab bar with a
  follow-the-scroll active-tab highlight (IntersectionObserver on section headers is the natural web
  equivalent of the native minY tracking). Custom packs (emoticon-only) render above unicode categories;
  reaction surface toggles a reaction, composer inserts text.

### 4.4 Stickers, polls, power-level tags on web

- **Sticker picker** mirrors the emoji picker structure (packs + recents + search + pack bar). Send an
  `m.sticker` event `{ body, url, info: {w,h,mimetype,size} }`. Personal stickers in
  `im.ponies.user_emotes` account data (with the `usage`/`es.discourse.pack` ownership discrimination
  and foreign-entry preservation ported exactly). Recover missing `info` w/h from the image before send.
- **Polls** — use `matrix-js-sdk` poll helpers (m.poll.start / m.poll.response / m.poll.end,
  MSC3381). Map `PollKind` disclosed/undisclosed, `maxSelections: 1`, results gate
  `isDisclosed || isEnded || votedByMe`, proportional result bars, author-only End Poll.
- **Reactions** — `m.reaction` relations; toggle add/remove; render chips (unicode/text/mxc-image),
  own-reaction tint, sender list on hover, quick-react palette. mxc reaction keys are custom emotes,
  resolved to `:shortcode:` labels via a `byUrl` map.
- **Power-level tags** — read/parse/write `in.cinny.room.power_level_tags`; nearest-at-or-below
  lookup; badge with color + unicode-or-mxc icon near member names.

---

## 5. Parity checklist (acceptance criteria)

### Emoji picker
- [ ] All native categories present in the same order; ~1400 glyphs (or dataset-equivalent).
- [ ] Single continuous scroll with a bottom tab bar; active tab follows scroll (header-crossing).
- [ ] Search matches by Unicode name (contains, case-insensitive); empty-state view; clear button.
- [ ] Recents ("Frequently Used") persisted, max 24, MRU, de-duped; updates on every insert.
- [ ] Custom emoticon packs render above unicode categories with avatar tabs; sticker-only packs excluded.
- [ ] Picker open triggers `refreshIfStale`.
- [ ] (Optional) skin tones, if added, don't corrupt recents format.

### Custom emoji / emotes
- [ ] `:shortcode:` autocomplete: custom-first (prefix→contains) then unicode, cap 8, `@`-suppressed.
- [ ] Closing-colon auto-replace for known unicode shortcodes only; `10:30:` / `@user:server` survive.
- [ ] Send produces MSC2545 HTML (`<img data-mx-emoticon …>`) with escaping + mxc validation; plain
      body keeps `:token:`.
- [ ] Incoming inline render swaps tokens for images; accepts marker-less mxc imgs with `:code:`
      alt/title; fallback maps known tokens from plain body.
- [ ] Jumbo (all-emote, ≤6) vs inline sizing, text-size-scaled; literal token shown until image loads.
- [ ] Custom emote reacts with its **mxc url** as the key; chip renders image + resolves `:shortcode:` label.
- [ ] Pack editor: sanitized shortcode, Emoji/Sticker/Both usage, ≤256px PNG (small GIF/WebP kept),
      read-before-write aborts on read failure, permission (M_FORBIDDEN) handled, immediate refetch.

### Stickers
- [ ] Personal packs + room/space packs in one picker; recents (max 16); search over shortcode+body.
- [ ] Send emits `m.sticker` with `{body,url,info}`; recovers missing w/h before send.
- [ ] Panel stays open for chaining; recents recorded; empty-state points to Settings.
- [ ] `im.ponies.user_emotes` ownership discrimination + foreign-entry preservation on save.

### Polls
- [ ] Create: 2–8 options, min-2 enforced, disclosed toggle, single-choice (maxSelections 1).
- [ ] Render: question + votable rows, radio/check, proportional result bars.
- [ ] Results gated by `isDisclosed || isEnded || votedByMe`; footer total / "Final result".
- [ ] Vote sends a poll response; author-only End Poll; ended polls disabled + final results.

### Reactions
- [ ] Single toggle add/remove; own reactions tinted; count = distinct senders.
- [ ] Unicode/text/mxc keys all render; mxc as image with `:shortcode:` label.
- [ ] Quick-react palette (top-5 used, emoji-filtered, default-padded) + "More Reactions" picker.
- [ ] Sender list revealed on hover/long-press.

### Power-level tags
- [ ] Parse/write `in.cinny.room.power_level_tags`; nearest-at-or-below fallback; built-in defaults.
- [ ] Badge shows name + color + unicode-or-mxc icon; editor drops default-equal tags.

### Data flow / caching
- [ ] Emoji store aggregates personal + space + emote_rooms + session-room packs; `byShortcode`/`byUrl` indexes.
- [ ] `refreshIfStale` throttled 5 min, bypassed on space-set change, concurrent-safe.
- [ ] Room packs: full-state discovery + per-key polling (45-min full-refetch), 404=absent vs
      failed=keep-cached.
- [ ] Spaces provider injected (not directly coupled).
