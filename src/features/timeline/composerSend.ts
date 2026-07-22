// The FFI send pipeline for the composer. Keeps the SDK calls out of the React
// component so the Composer stays a view.
//
// Uploads are bundled inside the typed send* calls (no separate uploadMedia):
// bytes ride UploadParameters.source = UploadSource.Data({bytes, filename}) and
// each returns a SendAttachmentJoinHandle whose join() awaits completion.

import {
  AudioInfo,
  EditedContent,
  EventOrTransactionId,
  FileInfo,
  ImageInfo,
  ThumbnailInfo,
  UploadParameters,
  UploadSource,
  VideoInfo,
  messageEventContentFromHtml,
  messageEventContentFromMarkdown,
  type TimelineInterface,
} from "@/matrix";
import {
  imageBlurhash,
  makeThumbnail,
  processImage,
  videoAttributes,
} from "@/features/media/ImageProcessing";
import type { Recording } from "@/features/media/VoiceRecorder";

// UniffiDuration is a plain number of milliseconds in this binding.
function durationMs(secs: number): number {
  return Math.round(secs * 1000);
}
// Retained for any callers still expecting the { secs, nanos } record form (unused).
function duration(secs: number): { secs: bigint; nanos: number } {
  const whole = Math.max(0, Math.floor(secs));
  const nanos = Math.max(0, Math.round((secs - whole) * 1e9));
  return { secs: BigInt(whole), nanos };
}

/** A staged attachment ready to send. */
export interface StagedAttachment {
  id: string;
  filename: string;
  file: File | Blob;
  mimetype: string;
}

/**
 * Build the message content for a text body: Markdown, unless the body contains
 * a known custom-emoji shortcode (then MSC2545 HTML plus plaintext). Given the
 * raw text, `customHtml` returns an HTML body when the text has custom emotes,
 * else undefined.
 */
export function buildTextContent(
  text: string,
  customHtml?: (text: string) => string | undefined,
) {
  const html = customHtml?.(text);
  if (html != null) return messageEventContentFromHtml(text, html);
  return messageEventContentFromMarkdown(text);
}

/** Send a plain/markdown/HTML text message, optionally as a reply. */
export async function sendText(
  timeline: TimelineInterface,
  text: string,
  opts: { replyToEventId?: string; customHtml?: (t: string) => string | undefined } = {},
): Promise<void> {
  const content = buildTextContent(text, opts.customHtml);
  if (opts.replyToEventId) {
    await timeline.sendReply(content, opts.replyToEventId);
  } else {
    await timeline.send(content);
  }
}

/** Edit an existing event's body (routes through EditedContent.roomMessage). */
export async function editMessage(
  timeline: TimelineInterface,
  eventId: string,
  text: string,
  customHtml?: (t: string) => string | undefined,
): Promise<void> {
  const content = buildTextContent(text, customHtml);
  await timeline.edit(
    new EventOrTransactionId.EventId({ eventId }),
    new EditedContent.RoomMessage({ content }),
  );
}

function uploadParams(bytes: ArrayBuffer, filename: string, inReplyTo?: string): UploadParameters {
  return UploadParameters.create({
    source: new UploadSource.Data({ bytes, filename }),
    caption: undefined,
    formattedCaption: undefined,
    mentions: undefined,
    inReplyTo,
  });
}

function isImage(mime: string): boolean {
  return mime.startsWith("image/");
}
function isVideo(mime: string): boolean {
  return mime.startsWith("video/");
}

/**
 * Send one attachment, branching by type. Images require width/height/size/
 * mimetype and a blurhash or the SDK throws; on any missing piece we fall back
 * to a plain file send. Awaits the join handle; throws propagate to the caller,
 * which restages an error chip.
 */
export async function sendAttachment(
  timeline: TimelineInterface,
  att: StagedAttachment,
  opts: { inReplyTo?: string; stripLocation: boolean },
): Promise<void> {
  const blob = att.file;
  const mime = att.mimetype || blob.type || "application/octet-stream";

  if (isVideo(mime)) {
    await sendVideoAttachment(timeline, att, mime, opts.inReplyTo);
    return;
  }
  if (isImage(mime)) {
    const sent = await trySendImage(timeline, att, mime, opts);
    if (sent) return;
    // fall through to file send on any failure
  }
  await sendFileAttachment(timeline, att, mime, opts.inReplyTo);
}

async function trySendImage(
  timeline: TimelineInterface,
  att: StagedAttachment,
  mime: string,
  opts: { inReplyTo?: string; stripLocation: boolean },
): Promise<boolean> {
  try {
    const processed = await processImage(att.file, opts.stripLocation);
    if (!processed) return false;
    const blurhash = await imageBlurhash(new Blob([processed.bytes], { type: processed.mimetype }));
    if (!blurhash) return false; // SDK requires a blurhash for images

    const thumb = await makeThumbnail(att.file);
    const thumbInfo: ThumbnailInfo | undefined = thumb
      ? ThumbnailInfo.create({
          height: BigInt(thumb.height),
          width: BigInt(thumb.width),
          mimetype: thumb.mimetype,
          size: BigInt(thumb.bytes.byteLength),
        })
      : undefined;
    const thumbSource = thumb
      ? new UploadSource.Data({
          bytes: thumb.bytes,
          filename: `thumb-${att.filename}`,
        })
      : undefined;

    const info = ImageInfo.create({
      height: BigInt(processed.height),
      width: BigInt(processed.width),
      mimetype: processed.mimetype,
      size: BigInt(processed.bytes.byteLength),
      thumbnailInfo: thumbInfo,
      thumbnailSource: undefined,
      blurhash,
      isAnimated: processed.isAnimated,
    });

    const params = uploadParams(processed.bytes, att.filename, opts.inReplyTo);
    const handle = timeline.sendImage(params, thumbSource, info);
    await handle.join();
    return true;
  } catch {
    return false;
  }
}

async function sendVideoAttachment(
  timeline: TimelineInterface,
  att: StagedAttachment,
  mime: string,
  inReplyTo?: string,
): Promise<void> {
  const attrs = await videoAttributes(att.file);
  const bytes = await att.file.arrayBuffer();
  if (!attrs) {
    await sendFileAttachment(timeline, att, mime, inReplyTo);
    return;
  }

  let thumbInfo: ThumbnailInfo | undefined;
  let thumbSource: UploadSource | undefined;
  if (attrs.poster) {
    thumbInfo = ThumbnailInfo.create({
      height: BigInt(attrs.poster.height),
      width: BigInt(attrs.poster.width),
      mimetype: attrs.poster.mimetype,
      size: BigInt(attrs.poster.bytes.byteLength),
    });
    thumbSource = new UploadSource.Data({
      bytes: attrs.poster.bytes,
      filename: `poster-${att.filename}`,
    });
  }

  const info = VideoInfo.create({
    duration: durationMs(attrs.durationSecs),
    height: BigInt(attrs.height),
    width: BigInt(attrs.width),
    mimetype: mime,
    size: BigInt(bytes.byteLength),
    thumbnailInfo: thumbInfo,
    thumbnailSource: undefined,
    blurhash: undefined, // no blurhash for outgoing video
  });

  const params = uploadParams(bytes, att.filename, inReplyTo);
  const handle = timeline.sendVideo(params, thumbSource, info);
  await handle.join();
}

async function sendFileAttachment(
  timeline: TimelineInterface,
  att: StagedAttachment,
  mime: string,
  inReplyTo?: string,
): Promise<void> {
  const bytes = await att.file.arrayBuffer();
  const info = FileInfo.create({
    mimetype: mime,
    size: BigInt(bytes.byteLength),
    thumbnailInfo: undefined,
    thumbnailSource: undefined,
  });
  const params = uploadParams(bytes, att.filename, inReplyTo);
  const handle = timeline.sendFile(params, info);
  await handle.join();
}

/** Send a recorded voice message (AudioInfo + waveform). */
export async function sendVoiceMessage(
  timeline: TimelineInterface,
  rec: Recording,
  inReplyTo?: string,
): Promise<void> {
  const ext = rec.mimetype.includes("mp4") ? "m4a" : rec.mimetype.includes("ogg") ? "ogg" : "webm";
  const info = AudioInfo.create({
    duration: durationMs(rec.durationSecs),
    size: BigInt(rec.bytes.byteLength),
    mimetype: rec.mimetype,
  });
  const params = uploadParams(rec.bytes, `voice-message.${ext}`, inReplyTo);
  const handle = timeline.sendVoiceMessage(params, info, rec.waveform);
  await handle.join();
}
