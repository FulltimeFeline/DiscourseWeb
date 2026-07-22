# Parity Spec 04 — Composer & Media

Scope: message composition, sending, formatting, mentions/autocomplete, reply/edit,
drafts, typing notices, attachment picking, image/video preview + caption, drag/drop/paste,
upload progress and oversize rejection, voice recording + playback, blurhash, media
caching/loading (thumbnails, full-res, encrypted decryption), and outgoing image/video
processing.

Native sources this spec is derived from:
- `Discourse/Features/Timeline/ComposerView.swift`
- `Discourse/Features/Timeline/VoiceMessageView.swift`
- `Discourse/Features/Timeline/InlineImageView.swift`
- `Discourse/Features/Timeline/VideoAttachmentView.swift`
- `Discourse/Core/MediaLoader.swift`
- `Discourse/Core/MediaProcessing.swift`
- `Discourse/Core/VoiceRecorder.swift`
- `Discourse/Core/Blurhash.swift`
- Send paths in `Discourse/Features/Timeline/TimelineViewModel.swift` (`sendText`,
  `sendComposed`, `sendAttachmentData`, `sendVoiceMessage`, `sendSticker`,
  `composerIsTyping`, `stageAttachment`)
- `Discourse/Core/MatrixService.swift` (`maxUploadSize`)

---

## 1. User-Facing Behavior

### 1.1 Text composer

- **Multiline field**: vertical-growing text field, `lineLimit(1..8)` — grows from 1 to
  8 lines, then scrolls internally. Placeholder is `"Message <roomName>"`.
- **Send affordances**:
  - macOS: a `send()` on Return, governed by the `sendOnEnter` preference.
    - `sendOnEnter == true`: plain `⏎` / `⌘⏎` send; `⇧⏎` inserts newline.
    - `sendOnEnter == false` (inverted): plain `⏎` inserts newline; `⇧⏎` / `⌘⏎` send.
    - `⌥⏎` is **always** a newline regardless of preference.
  - iOS: the on-screen send arrow button; `⏎` on a hardware keyboard first tries to
    accept an open autocomplete suggestion, else falls through to submit.
- **Send button visibility (`canSend`)**: send arrow shows only when the trimmed text is
  non-empty OR there are pending attachments. Otherwise the trailing control is a mic
  (voice message).
- **Send clears the field immediately** (optimistic). A vertical field can race a stray
  newline into the binding right after clearing, so it re-clears on the next runloop
  (`DispatchQueue.main.async { text = "" }`). Web equivalent: clear synchronously and
  again on the next microtask/`requestAnimationFrame`.
- **Trim on send**: leading/trailing whitespace and newlines are trimmed
  (`.whitespacesAndNewlines`) before the message is dispatched.
- **Send haptic (iOS)**: a light impact fires on send/voice-send, gated by the
  `sendMessageHaptic` preference (a `hapticTick` counter only advances while enabled).
- **Escape key (macOS)** backs out of composer state in priority order: recording →
  edit → reply. If none active, Escape is ignored (so it can still exit fullscreen).
- **Up arrow in an empty composer (macOS)** edits your last editable message
  (`lastOwnEditableMessage()`), clearing any reply target and setting `editTarget`.

### 1.2 Formatting / Markdown

- Body text is sent as **Markdown** via `messageEventContentFromMarkdown(md:)`.
- If the body contains any known custom-emoji `:shortcode:` tokens, the emoji store
  produces an **MSC2545 HTML** body and the message is sent with
  `messageEventContentFromHtml(body:htmlBody:)` instead (plaintext body + HTML formatted
  body). Detection is `customEmoji?.htmlBody(for: text)` returning non-nil.
- Mentions are inserted as `matrix.to` Markdown links (see 1.3); the markdown send path
  converts them into real pill mentions server-side.

### 1.3 Mentions / Autocomplete

Four independent autocomplete facilities. All operate on the **trailing token** at the
end of the field (last `@` / last `:`), require the trigger char to be at a word start
(start of field or preceded by whitespace), and cap the visible list.

- **User mentions (`@`)**:
  - Trigger: a trailing `@token` where `token` has no whitespace and `@` is at a word
    start.
  - Filter: fold query once (`RoomSummary.foldedForSearch`) and match against each
    member's precomputed `foldedName`, or the lowercased mxid contains the lowercased
    query. Excludes own user id. **Stops at 6 matches** (hot path optimization).
  - Empty query (`@` alone) lists the first 6 members.
  - Row: avatar + display name + mxid (mxid truncated middle).
  - Accept: replaces trailing `@token` with `[Name](https://matrix.to/#/@mxid)` + a
    trailing space; refocuses the field.
  - Re-filters when `viewModel.members` changes (members load async).
- **Emoji / custom-emote (`:`)**:
  - Trigger: a trailing `:token` with `token.count >= 2`, all shortcode-legal chars
    (`CustomEmojiStore.isShortcodeCharacter`), colon at a word start. **Suppressed while
    a mention query is active** so `@user:server` isn't read as an emote query.
  - Sources, in order: custom emotes (prefix matches first, then contains, cap 6 each),
    then unicode emoji from `EmojiShortcodes.matches(needle, limit: 6)`. Final list is
    `(prefix + unicode + contains).prefix(8)`.
  - Row: emote image (via `EmoteImageView` + media loader) or the unicode glyph, plus
    the label (`:shortcode:` or emote token).
  - Accept: custom emote inserts its `:shortcode:` token + space (converted to HTML at
    send); unicode inserts the literal glyph.
- **Inline shortcode auto-replace**: typing the **closing colon** of an exact unicode
  shortcode (`:pleading_face:`) replaces it in place with the glyph
  (`autoReplacingTrailingShortcode`). Single-character growth only (so pastes are not
  rewritten); word-start only (so `10:30:` survives); custom emotes stay as tokens.
- **No slash/command autocomplete** exists in the composer. (Slash commands are not
  implemented in this slice.)

**Autocomplete navigation**: `↑`/`↓` move `selectedSuggestion`; `Tab` accepts; iOS
hardware `⏎` and macOS `⏎` accept the highlighted row first. Hover sets the selection
index. First list precedence: mentions render if non-empty, else emote suggestions.

### 1.4 Reply / Edit modes

- **Reply**: `viewModel.replyTarget` set (from timeline). A "Replying to <name>" glass
  banner shows above the bar with an ✕ to cancel. On send, the message is dispatched with
  a reply relation. With **no text but attachments**, the reply relation rides the
  **first attachment** (`inReplyTo` on the first `UploadParameters`); `sendText` is
  skipped.
- **Edit**: `viewModel.editTarget` set. On entering edit:
  - The current draft is **stashed** (`stashedDraft`) only on the draft→edit transition
    (switching between two edit targets keeps the original pre-edit draft).
  - The field is prefilled with the target's text body (`if case .text(let body)`).
  - An "Editing message" banner with ✕ shows. Cancelling restores `stashedDraft`.
  - Send routes to `timeline.edit(...)` with `newContent: .roomMessage(content:)`.

### 1.5 Draft persistence

- **Per-room draft** kept on the view model (`draftText`, observation-ignored) so
  switching rooms (which tears down the composer view) doesn't lose half-typed text.
- macOS: on appear, if the field is empty and not editing, restore `viewModel.draftText`.
  On text change (when not editing), persist to `viewModel.draftText`.
- Draft is **not** persisted while an edit occupies the field (the real draft is in
  `stashedDraft`).
- Draft persistence is only wired on macOS in this view; iOS relies on the same view-model
  field surviving because the room VM is cached, but the auto-restore `onAppear` is macOS-
  only. Web should persist per-room drafts (e.g. keyed by room id in memory + localStorage)
  and restore on room open for both platforms.

### 1.6 Typing notifications (outgoing)

- `composerIsTyping()` called on every keystroke that leaves non-empty text.
  - Gated by the `sendTypingNotifications` preference.
  - **Throttled to one `typingNotice(isTyping: true)` per 4 seconds.**
  - Schedules an automatic **stop after 6 seconds idle** (`typingNotice(false)`).
  - `sendTypingNotice(false)` also fires explicitly right before a text send.
- Incoming typing shown as a banner ("<name> is typing…" / "<a> and <b> are typing…" /
  "Several people are typing…"), gated by `showTypingIndicators`.

### 1.7 Attachment picking

- **iOS**: "Photo Library" (PhotosPicker, `.any(of: [.images, .videos])`) and
  "Attach File…" (file importer, `.item`, multi-select).
  - Photo picker: each item loaded as `Data`; if the content type conforms to `.movie`,
    staged as `video.<ext>`, else staged as `image` (extension derived from bytes).
- **macOS**: a `+` menu with "Attach File…"; also poll and location entries.
- **Shared menu items**: Attach File, Create Poll, Share Location (location is
  confirmation-gated before broadcasting).
- Files stage as **preview chips** immediately; the (possibly multi-MB) read happens
  off-main (`Task.detached`), with security-scoped resource access for sandboxed URLs.

### 1.8 Attachment preview strip + captions

- Horizontal scrolling strip of 64×64 chips.
- Chip shows a decoded preview thumbnail (256px max, decoded off-main) for images, else a
  document icon + filename.
- Overlays: a spinner while `isLoading` (excluded from sends until the read lands); a red
  border + error badge if `uploadFailed`; an ✕ remove button (44pt hit target on iOS).
- **No per-attachment caption UI** exists in this composer. `UploadParameters.caption`
  and `formattedCaption` are always sent as `nil`. Text typed in the composer is sent as a
  **separate following text message**, not as the attachment caption. (Web parity: match
  this — send attachments first, then the text as its own message. A caption-per-image UI
  would be a divergence, not parity.)
- Inline **received** images/videos DO render a caption below them if the event carries
  one (`image.caption` / `video.caption`).

### 1.9 Drag / drop / paste

- **Drop onto the bar** (`dropDestination(for: ComposerDropItem.self)`): `ComposerDropItem`
  is `.file(data, filename)` (Finder files imported as a sandbox-readable copy) or
  `.image(data)` (Photos data-only drags). Each staged via `stageAttachment`.
- **Files dropped into the text field** arrive as their **paths** (one per line for multi-
  file). Detected only on bulk growth (`newValue.count - oldValue.count > 1`) so
  `filePaths()` doesn't stat the filesystem per keystroke. Valid, existing, non-directory
  paths are staged; the text is cleared.
- **Paste (macOS)**: `onPasteCommand(of: [.fileURL, .png, .tiff, .image])` →
  `stagePasteboardContents()`: file URLs stage as attachments; raw PNG/TIFF image data
  stages as `image`. Plain text pastes normally.
- **Drag out (macOS)**: inline images are `.draggable(TimelineImageTransfer)` — full-res
  downloads to a temp file at drop time and is exported as a file.

### 1.10 Upload progress & oversize rejection

- **Oversize rejection**: before uploading, `service.maxUploadSize()` (cached
  `getMaxMediaUploadSize()`) is checked. If `data.count > maxSize`, the send is rejected
  with a composer error `"<filename> is too large to send (limit <N> MB)."` and the bytes
  are dropped (not restaged).
- **Progress**: there is **no percent progress UI**. The send handle is awaited
  (`handle.join()`); the chip shows a generic spinner while staging (`isLoading`) and the
  send is fire-and-forget from the UI's perspective (optimistic clear). A failed
  `join()` restages the chip with an error border/badge (`restageFailedUpload`).
  - A `join()` throw within 3 seconds of a deliberate `cancelSend` (stamped
    `lastUploadCancelAt`) reads as "Upload cancelled", not a failure — no restage.
- Web can add a real progress bar if the WASM SDK exposes upload progress, but parity
  minimum is: spinner during in-flight, error chip on failure with retry-on-send.

### 1.11 Voice message recording (iOS-primary, macOS supported)

Recorder: `VoiceRecorder` (AAC/m4a, see §2.4).

- **iOS hold-to-record gesture** (`voiceHoldGesture`, zero-distance drag, global coord
  space):
  - Finger down on the mic starts recording; mic scales up (1.25×) and turns red.
  - **Slide left past −80pt** (`voiceCancelThreshold`) discards (trash tint appears at
    half-threshold). A "Slide to cancel" hint rides the finger toward the trash.
  - **Slide up past −60pt** (`voiceLockThreshold`) locks into hands-free recording; a
    lock pill floats above the mic and fills in as the slide approaches.
  - **Release**: if not cancelled/locked and duration ≥ 0.5s, send; a shorter release is
    treated as a tap (discarded) with hint "Hold to record, release to send".
  - **Locked mode**: recording continues; the bar shows a trash (delete) and a send
    arrow. Tap send to finalize.
  - VoiceOver: the mic's accessibility double-tap toggles a **locked** recording (drag
    can't be driven by VoiceOver).
  - **Interruption**: if the system stops the recorder (call/Siri/session flip),
    `recorder.interrupted` flips; the UI tears down and shows "Recording interrupted".
- **macOS**: a mic button starts recording; the bar shows a red-dot timer, live
  `WaveformBars`, an ✕ cancel and a send arrow. `⎋` cancels.
- **Recording bar**: red dot + `m:ss` timer (`durationLabel`) + live level bars
  (last 60 samples of `recorder.levels`).
- **Teardown**: on view disappear (room switch / back-nav) a live recording is stopped
  (`stop(cancelled: true)`) to release the timer, audio session, and temp file.

### 1.12 Voice message playback

`AudioPlaybackController` (one per timeline; survives row recycling), keyed by timeline
item id.

- `toggle(itemId:source:loader:)`: if the tapped item is active, play/pause toggles;
  else it stops any current playback, downloads via `loader.fullContent(for:)`, builds an
  `AVAudioPlayer`, and plays. Only one download in flight (`loadingItemId` guard).
- Per-row UI state survives recycling: `loadingItemId` (spinner), `failedItemIds`
  (retry). A failed download shows an `arrow.clockwise` retry control.
- **Audio session (iOS)**: `.playback` category set active on play (audible with the
  silent switch); deactivated with `.notifyOthersOnDeactivation` on pause/stop.
- **Progress timer**: 0.1s timer updates `progress = currentTime/duration`; auto-stops
  and resets when the player finishes.
- **Waveform** (`WaveformBars`): 36 bars, resampled from the event's waveform samples
  (clamped 0.12…1); played portion tinted; if no samples, a deterministic sine-based
  fallback shape. Time label counts **down** while playing/scrubbed (remaining), else
  shows total.

### 1.13 Inline image display (received)

`InlineImageView`:
- Fixed footprint from the event's `ImageInfo` (`displaySize`), filled by the SDK
  thumbnail when it lands.
- **Blurhash placeholder** decoded (24px wide, height by aspect) shown behind the spinner
  so images fade in from their colors. Skipped if the real image is already available.
- **Data-saver gate**: with `autoDownloadImages` off, non-sticker images wait behind a
  "Tap to load image" placeholder; the first tap requests the download. Stickers always
  load; an already-cached image never gates.
- **Failure**: an empty thumbnail fetch shows "Tap to retry" (retry bumps `loadAttempt`).
- Tap on a loaded image opens full-res in a Quick Look preview (downloads full content to
  a stable temp file named by source hash so repeat opens reuse it).
- Aspect: `.fill` when a known size exists, `.fit` otherwise; stickers always `.fit`
  (never cropped).
- Thumbnail pixel size = `max(displaySize.w, displaySize.h) * thumbnailScale`, where
  `thumbnailScale = clamp(displayScale, 1, 3)`.

### 1.14 Inline video display (received)

`VideoAttachmentView` mirrors the image view:
- Poster from `video.thumbnailSource` via `loader.thumbnail`; blurhash placeholder
  behind it; a neutral "film" placeholder if no poster.
- Play overlay + duration badge (`video.durationText`).
- Tap downloads + decrypts the full file to a stable temp file (extension from filename
  or mime: `video/quicktime`→mov, `video/webm`→webm, else mp4), then plays in Quick Look
  (scrubbing + fullscreen for free). A download failure shows a retry control; a
  re-open in the same session reuses the temp file without re-fetching.

---

## 2. Data Flow

### 2.1 Staging → send pipeline

1. **Stage** (`stageAttachment(fileURL:)` or `(data:filename:)`): a `PendingAttachment`
   (`id, filename, data, previewImage, isLoading, uploadFailed`) is appended.
   - `fileURL` path: chip appears immediately with `isLoading = true`; bytes read
     off-main via `Task.detached` with security-scoped access; `finishStaging` fills
     `data` and clears `isLoading`. Empty/unreadable → chip removed + "Couldn't read
     <file>" error.
   - `data` path: raw image drags get a derived filename (`image.<ext>` from
     `imageType(of:)`).
   - Preview thumbnail (256px, decoded off-main via ImageIO) attached to the chip.
2. **Send** (`sendComposed(text:)`): filters out still-loading chips (they stay staged),
   clears the rest, then for each attachment calls `sendAttachmentData` (first one carries
   the reply relation if there's no text), then sends the text (if any) as its own
   message. Ordering preserved.
3. **Per-attachment dispatch** (`sendAttachmentData`): oversize check → branch by type:
   - **Video** (`isVideo` by UTType movie/video): compute `VideoAttributes` (duration,
     oriented dimensions, poster thumbnail) via `MediaProcessing.videoAttributes`; build
     `VideoInfo` + `ThumbnailInfo`; `timeline.sendVideo(params:thumbnailSource:videoInfo:)`.
     Falls back to file send if the asset can't be read.
   - **Image** (bytes are a recognized image type): off-main, optionally strip GPS
     (`stripLocationMetadata` pref → `sanitizedImage`, else `imageAttributes` keeps EXIF),
     compute **blurhash** and an 800px **thumbnail**; build `ImageInfo` + `ThumbnailInfo`;
     `timeline.sendImage(params:thumbnailSource:imageInfo:)`. The SDK **requires**
     width+height+size+mimetype **and** a blurhash or it throws `InvalidAttachmentData`;
     if any is missing, falls back to a file send.
   - **Everything else**: `FileInfo` + `timeline.sendFile(params:fileInfo:)`.
   - Each awaits `handle.join()`; on throw, `restageFailedUpload` (unless it was a
     deliberate cancel).
4. **Upload mechanics**: bytes travel inside `UploadParameters.source =
   .data(bytes:filename:)` (an `UploadSource`). The SDK's send* calls handle the actual
   `uploadMedia` internally (encrypting for E2EE rooms) and return an
   `SendAttachmentJoinHandle` whose `join()` awaits the upload+send completion. There is
   **no separate app-level `uploadMedia` call**; upload is bundled into `sendImage` /
   `sendVideo` / `sendFile` / `sendVoiceMessage`.

### 2.2 Blurhash & dimensions (client-side)

- **Dimensions**: read from ImageIO props (`kCGImagePropertyPixelWidth/Height`) in
  `imageAttributes` / `sanitizedImage`. For video, `AVAssetTrack.naturalSize` applying
  `preferredTransform` (orientation-corrected).
- **Blurhash**: `Blurhash.encode(imageData:)` downsamples to a 32px thumbnail via ImageIO,
  then DCT-encodes with `componentsX=4, componentsY=3` into the base-83 blurhash string.
  Full pure-Swift implementation (sRGB↔linear, DC/AC quantization, base-83). Decoding
  (`Blurhash.decode`) rebuilds a small CGImage placeholder. **Images are only sent if a
  blurhash was produced** (required by the SDK).
- **Video** currently sends `blurhash: nil` in `VideoInfo` (no blurhash computed for
  outgoing video). Web should match unless it can cheaply blurhash the poster.

### 2.3 MediaLoader cache tiers

`MediaLoader` (main-actor, one per session):
- **Tier 1 — memory**: `NSCache<url#side, PlatformImage>`, cost = pixel bytes (w*h*4).
  Limit 256 MB (macOS) or `min(256MB, physicalMemory/8)` (iOS). Cleared on memory
  warning (iOS).
- **Tier 2 — disk**: per-account `Caches/thumbnails/<safeUserId>/` of already-downsampled
  bitmaps, filenames = SHA-256 of `"<url>#<side>"`. JPEG@0.8 unless the bitmap has alpha
  (then PNG). ~100 MB cap, LRU-trimmed by modification date at init and every 200 writes.
  Excluded from backup; iOS writes with file protection until first unlock.
- **Key**: `url # roundedPixelSide`. `cachedSizes[url]` tracks which sizes exist (NSCache
  isn't enumerable) so a request can reuse a **larger cached size**, decoded down, before
  hitting the network.
- **In-flight dedup**: `inFlight[key]` (thumbnails) and `inFlightContent[url]` (full
  content) share one fetch across concurrent callers.
- **thumbnail(for:pixelSize:)** resolution order: memory → in-flight → disk (exact) →
  disk (larger, downsampled) → network (server `getMediaThumbnail`, or for encrypted
  sources full `getMediaContent`) → decode + cache.
- **fullContent(for:)**: `client.getMediaContent(mediaSource:)`, dedup per URL.
- **avatar(mxcUrl:pixelSize:)**: builds `MediaSource.fromUrl(url:)`, then `thumbnail`.
- **prewarmThumbnails**: bulk-loads disk thumbnails into memory before first sidebar paint.
- **cachedThumbnail / cachedImage**: synchronous memory-only lookups (seed views before
  async fetch); kick off no work.

### 2.4 Encrypted media handling

- Whether a source is encrypted is memoized: `source.toJson().contains("\"key\"")`
  (the AES key presence), cached per URL (`encryptedByUrl`) because `toJson()` is costly.
- Encrypted sources **cannot be server-thumbnailed** (asking hangs) — the loader
  downloads full content (`getMediaContent`) and decodes locally. Decryption itself is
  done inside the SDK/`getMediaContent`; the app never handles keys directly.
- Outgoing E2EE: images/videos are sent **with a client-generated thumbnail** so
  recipients in encrypted rooms can preview without downloading the full file (there's no
  server thumbnailing for E2EE). The SDK encrypts on upload.

### 2.5 Outgoing image processing (`MediaProcessing`)

- `sanitizedImage(data:)`: re-encode nulling the GPS dictionary
  (`kCGImagePropertyGPSDictionary = kCFNull`), keeping orientation and other metadata.
  Multi-frame (GIF/APNG) passes through untouched (re-encoding index 0 would flatten
  animation). Returns data + mimetype + pixel w/h.
- `thumbnail(from:maxPixelSize:800)`: ImageIO downsample with orientation transform baked
  in; JPEG@0.75 unless alpha (then PNG). Returns data + mimetype + w/h.
- `videoAttributes(data:filename:)`: writes bytes to a temp file (AVAsset needs a URL),
  loads duration + orientation-corrected natural size, and extracts a poster frame
  (seeked ~1s in to avoid a black frame 0, max 800×800), encoded like a thumbnail.

### 2.6 Voice recording (`VoiceRecorder`)

- Format: AAC in m4a (`kAudioFormatMPEG4AAC`, 48 kHz, mono, 64 kbps).
- iOS: requires mic permission (`AVCaptureDevice.requestAccess(.audio)`); activates a
  `.playAndRecord` session (`.defaultToSpeaker, .allowBluetooth`) before recording.
- Metering timer at 0.05s: `averagePower` (−160…0 dB) normalized to 0…1 as
  `max(0, min(1, (db+50)/50))`, appended to `levels`; also updates `duration`. If the
  recorder was externally stopped, it finalizes gracefully and sets `interrupted`.
- `stop(cancelled:)`: returns a `Recording(data, duration, waveform)` only if not
  cancelled and `finalDuration >= 0.5s`. Waveform is downsampled to ~100 points (max per
  bucket). Temp file deleted afterward.
- Send: `AudioInfo(duration, size, mimetype: "audio/mp4")` +
  `timeline.sendVoiceMessage(params:audioInfo:waveform:)`.

---

## 3. MatrixRustSDK FFI Symbol Catalog (flat)

Every SDK symbol touched by this composer/media slice.

**Timeline send methods**
- `Timeline.send(msg:)` — plain text/markdown message. Returns a `SendHandle`.
- `Timeline.sendReply(msg:eventId:)` — reply relation.
- `Timeline.edit(eventOrTransactionId:newContent:)` — edit an existing event.
- `Timeline.sendImage(params:thumbnailSource:imageInfo:)` — returns `SendAttachmentJoinHandle`.
- `Timeline.sendVideo(params:thumbnailSource:videoInfo:)` — returns `SendAttachmentJoinHandle`.
- `Timeline.sendFile(params:fileInfo:)` — returns `SendAttachmentJoinHandle`.
- `Timeline.sendVoiceMessage(params:audioInfo:waveform:)` — returns `SendAttachmentJoinHandle`.
- `Timeline.sendLocation(body:geoUri:description:zoomLevel:assetType:repliedToEventId:)` — location share.

**Send handles**
- `SendAttachmentJoinHandle.join()` — await upload + send completion (throws on failure).
- `SendHandle.tryResend()` — retry a failed local echo (used by retry path).

**Message content builders**
- `messageEventContentFromMarkdown(md:)` — markdown → `RoomMessageEventContentWithoutRelation`.
- `messageEventContentFromHtml(body:htmlBody:)` — plaintext + HTML formatted body (MSC2545 custom emoji).
- `EditedContent.roomMessage(content:)` — wraps new content for `edit`.
- `EventOrTransactionId.eventId(eventId:)` — identifies the edit target.

**Upload payload types**
- `UploadParameters(source:caption:formattedCaption:mentions:inReplyTo:)` — attachment
  send params. `caption`/`formattedCaption`/`mentions` sent as `nil` in this app.
- `UploadSource.data(bytes:filename:)` — in-memory bytes source for uploads.
- `ImageInfo(height:width:mimetype:size:thumbnailInfo:thumbnailSource:blurhash:isAnimated:)`.
- `VideoInfo(duration:height:width:mimetype:size:thumbnailInfo:thumbnailSource:blurhash:)`.
- `AudioInfo(duration:size:mimetype:)`.
- `FileInfo(mimetype:size:thumbnailInfo:thumbnailSource:)`.
- `ThumbnailInfo(height:width:mimetype:size:)`.

**Media download / sources**
- `Client.getMediaContent(mediaSource:)` — full bytes (E2EE-decrypted server-side).
- `Client.getMediaThumbnail(mediaSource:width:height:)` — server-side thumbnail
  (unencrypted sources only).
- `Client.getMaxMediaUploadSize()` — homeserver upload cap (bytes).
- `MediaSource` (opaque) — carried in `MediaSourceBox`.
- `MediaSource.fromUrl(url:)` — build a source from an `mxc://` URL (avatars, packs).
- `MediaSource.toJson()` — used to sniff for an AES `"key"` (encrypted detection).

**Room ephemeral / raw**
- `Room.typingNotice(isTyping:)` — outgoing typing notice.
- `Room.sendRaw(eventType:content:)` — raw `m.sticker` events (stickers).

**Assets / enums**
- `AssetType.sender` — location share asset type.

Notes: there is **no** direct `uploadMedia`, `AttachmentConfig`, `sendAttachment`,
`sendAudio`, or `msgLikeContent` FFI call in this slice — uploads are bundled inside the
typed `sendImage`/`sendVideo`/`sendFile`/`sendVoiceMessage` calls. If the web WASM SDK
exposes a lower-level `uploadMedia` + `sendAttachment(AttachmentConfig)`, the app can
recompose the same behavior, but parity is defined by the typed-send semantics above.

---

## 4. Web Mapping (TypeScript / React)

| Native concept | Web equivalent |
| --- | --- |
| PhotosPicker / fileImporter | `<input type="file" accept="image/*,video/*" multiple>` and a general file input |
| Multiline growing TextField (1..8 lines) | `<textarea>` with auto-grow (scrollHeight, capped at ~8 rows) |
| Drop on bar (`dropDestination`) | `dragover`/`drop` handlers reading `DataTransfer.files` and `.items` (image `getAsFile`) |
| Path-drop into field | Not applicable on web — browser gives `File` objects, not paths. Rely on `DataTransfer.files`. |
| macOS paste (`onPasteCommand`) | `paste` event → `ClipboardEvent.clipboardData.files` / `.items` (image blobs), else plain text |
| Preview chip thumbnail | `URL.createObjectURL(file)` for the chip; revoke on remove/send |
| Full-res open (Quick Look) | Object URL in a lightbox / `<video controls>`; revoke after |
| Voice recording (`AVAudioRecorder` AAC/m4a) | `MediaRecorder` (prefer `audio/mp4;codecs=mp4a` where supported, else `audio/webm;codecs=opus`) after `getUserMedia({audio})` |
| Live meter (`averagePower`) | `AudioContext` + `AnalyserManager`/`getByteTimeDomainData` (RMS) sampled ~20 Hz, normalized like `(db+50)/50` |
| Waveform bars | `<canvas>` or flex divs; 36 bars resampled from stored samples; played-portion tint |
| Voice playback (`AVAudioPlayer`) | `<audio>` element or `AudioBufferSourceNode`; a single controller keyed by item id, survives component unmount (store in context/zustand) |
| Blurhash encode/decode | `blurhash` npm package (`encode`/`decode`); downsample source to ~32px on an offscreen `<canvas>` first |
| Image GPS strip / re-encode | `<canvas>` re-encode drops EXIF entirely (browsers don't preserve it) — GPS strip is effectively free; but so is all metadata. Do it in a **Web Worker** with `OffscreenCanvas` + `createImageBitmap` to stay off the main thread |
| ImageIO downsample thumbnail (800px) | Worker: `createImageBitmap(file, {resizeWidth,resizeHeight})` → `OffscreenCanvas.convertToBlob({type, quality})` (JPEG 0.75, PNG if alpha) |
| Video attributes (AVAsset) | `<video>` element off-DOM: `loadedmetadata` for duration + `videoWidth/Height`; seek ~1s + draw to canvas for poster |
| Dimensions from ImageIO props | `createImageBitmap(file)` → `.width/.height`, or `<img>.naturalWidth/Height` |
| `getMediaContent` bytes | WASM SDK returns the media as a `Uint8Array`/`ArrayBuffer` (decrypted); wrap in a `Blob` + `URL.createObjectURL` for display |
| MediaLoader memory cache | `Map<key, {bitmap|blobUrl}>` with an LRU byte-budget; key `url#side` |
| MediaLoader disk cache | IndexedDB (per-account object store) of downsampled `Blob`s, keyed by SHA-256 of `url#side`; LRU-trim to a byte cap |
| In-flight dedup | `Map<key, Promise>` shared across callers |
| Oversize rejection | `getMaxMediaUploadSize()` from WASM SDK; compare `file.size` before upload |
| Typing notice throttle | `room.typingNotice(true)` at most every 4s; `setTimeout(6s)` for the stop; send `false` before a text send |
| Upload | Prefer the WASM equivalents of `sendImage/sendVideo/sendFile/sendVoiceMessage`; if only `uploadMedia` + `sendAttachment` exist, upload the (worker-processed) bytes then send with the same `ImageInfo/VideoInfo/...` metadata |
| Send haptic | `navigator.vibrate` (best-effort; gated by preference) |

Worker guidance: run image sanitize/downsample and blurhash encoding in a Web Worker
(they're CPU-heavy and native does them off the main actor). Voice waveform metering can
stay on the main thread (cheap), matching native's 0.05s timer at ~20 Hz.

---

## 5. Parity Checklist (acceptance criteria)

### Text & sending
- [ ] Textarea grows 1→8 rows then scrolls; placeholder is `Message <roomName>`.
- [ ] Send is disabled unless trimmed text is non-empty OR attachments are staged.
- [ ] Enter-to-send honors a `sendOnEnter` preference; Shift/Alt/Cmd modifiers behave as
      in §1.1; Alt+Enter is always a newline.
- [ ] Sending clears the field immediately and can't leave a stray trailing newline.
- [ ] Body is sent as Markdown; a message containing known `:shortcode:` custom emoji is
      sent as HTML+plaintext instead.
- [ ] Escape backs out of recording → edit → reply (in that order) where applicable.

### Autocomplete
- [ ] `@` at a word start opens a member list; matches by folded name or mxid substring;
      excludes self; caps at 6; empty query lists first 6.
- [ ] Accepting a mention inserts `[Name](https://matrix.to/#/@mxid) ` and refocuses.
- [ ] `:` at a word start with ≥2 shortcode chars opens custom-emote + unicode suggestions
      (prefix custom first, then unicode, then contains; ≤8 shown); suppressed while a
      mention query is active.
- [ ] Typing the closing `:` of an exact unicode shortcode replaces it inline (single-char
      growth only, word-start only, `10:30:` survives).
- [ ] Up/Down move selection, Tab/Enter accept, hover selects.
- [ ] No slash-command autocomplete (matches native).

### Reply / edit / drafts / typing
- [ ] Reply banner with cancel; reply relation attaches to the first attachment when there
      is no text.
- [ ] Edit prefills the target body, stashes the in-progress draft, restores it on cancel;
      send routes to edit.
- [ ] Per-room draft persists across room switches (and, on web, page reloads).
- [ ] Typing notice sent at most once per 4s; auto-stop after 6s idle; explicit stop
      before a text send; gated by preference.

### Attachments
- [ ] Image/video/file picking; multi-select; videos routed to the video send path.
- [ ] Drop and paste stage attachments (files + raw image data); plain text pastes
      normally.
- [ ] Staged chips render an object-URL preview (image) or doc icon + filename; spinner
      while loading; ✕ removes; still-loading chips are excluded from the current send and
      kept for the next.
- [ ] Text typed alongside attachments is sent as a **separate following message** (no
      per-attachment caption UI).
- [ ] Oversize files are rejected before upload with a "too large (limit N MB)" error and
      dropped.
- [ ] Failed uploads restage as an error chip (red border + badge) and retry on next send;
      a deliberate cancel doesn't restage.

### Media processing (outgoing)
- [ ] Images send with client-computed width/height, mimetype, size, an 800px thumbnail,
      and a **blurhash** (send falls back to a file send if any is missing).
- [ ] GPS/EXIF is stripped when the strip preference is on (canvas re-encode); animated
      GIF/APNG pass through without flattening.
- [ ] Videos send with duration, orientation-corrected dimensions, and a poster frame
      seeked ~1s in.

### Voice
- [ ] Record in AAC/m4a where supported (else opus/webm); require mic permission.
- [ ] Hold-to-record with slide-left cancel (−80pt) and slide-up lock (−60pt); release
      ≥0.5s sends, shorter is treated as a tap; locked mode shows delete + send.
- [ ] Live timer + waveform while recording; interruption tears down and warns.
- [ ] Recording downsampled to ~100 waveform points; sent with duration + waveform.
- [ ] Playback: single controller keyed by item id survives row unmount; only one download
      in flight; retry on failure; progress + countdown time label; auto-stop at end.

### Media loading (received)
- [ ] Inline image shows a blurhash placeholder, then the SDK thumbnail; data-saver gate
      ("Tap to load") when auto-download is off (stickers exempt); "Tap to retry" on
      failure; tap opens full-res.
- [ ] Inline video shows poster (or blurhash/film placeholder), play + duration badge; tap
      downloads + decrypts, then plays with scrubbing.
- [ ] Thumbnails resolve memory → disk(IndexedDB) → larger-cached-size → network; encrypted
      sources download full content and decode locally (no server thumbnail).
- [ ] Memory + disk cache keyed by `url#side`; disk trimmed to a byte cap (LRU); caches
      wiped on logout; per-account namespacing.
