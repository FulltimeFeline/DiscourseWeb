// Room emote/sticker pack editor (settings, Emotes tab). Add/remove custom
// images in a room's MSC2545 `im.ponies.room_emotes` pack. Reads/writes go
// through CustomEmojiStore; the image is uploaded to the media repo first for
// its mxc:// url.

import { useCallback, useEffect, useState } from "react";
import { useSession } from "@/app/context";
import { useCustomEmoji } from "@/features/emotes/emojiSession";
import type { Emote, EmoteUsage } from "@/core/CustomEmojiStore";
import { Section, Row, TextField, Segmented, Button } from "./primitives";
import { pickImage } from "./media";
import { useMediaUrl } from "./useMediaUrl";
import { Icon } from "@/ui/Icon";

/** Lowercase, spaces→_, drop anything outside [a-z0-9_-.]. */
function sanitizeShortcode(raw: string): string {
  return raw.toLowerCase().replace(/\s+/g, "_").replace(/[^a-z0-9_.-]/g, "");
}

const USAGE_OPTIONS = [
  { value: "both" as const, label: "Both" },
  { value: "emoticon" as const, label: "Emoji" },
  { value: "sticker" as const, label: "Sticker" },
];
type UsageChoice = (typeof USAGE_OPTIONS)[number]["value"];

function usageArray(c: UsageChoice): EmoteUsage[] {
  return c === "both" ? [] : [c];
}
function usageLabel(u: EmoteUsage[]): string {
  if (u.length === 0) return "Both";
  if (u.includes("emoticon") && u.includes("sticker")) return "Both";
  return u.includes("sticker") ? "Sticker" : "Emoji";
}

function EmoteThumb({ mxc }: { mxc: string }) {
  const url = useMediaUrl(mxc, { thumb: 64 });
  return url ? (
    <img className="emote-editor__thumb" src={url} alt="" loading="lazy" />
  ) : (
    <span className="emote-editor__thumb emote-editor__thumb--empty" />
  );
}

export function EmotePackEditor({ roomId, canEdit }: { roomId: string; canEdit: boolean }) {
  const session = useSession();
  const store = useCustomEmoji(session);
  const [emotes, setEmotes] = useState<Emote[]>([]);
  const [loading, setLoading] = useState(true);
  const [shortcode, setShortcode] = useState("");
  const [usage, setUsage] = useState<UsageChoice>("both");
  const [pending, setPending] = useState<{ url: string; mxc: string; w?: number; h?: number; mime: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();

  const reload = useCallback(async () => {
    setLoading(true);
    const list = await store.roomPackEmotes(roomId);
    setEmotes(list);
    setLoading(false);
  }, [store, roomId]);

  useEffect(() => {
    void reload();
  }, [reload]);

  async function chooseImage() {
    setError(undefined);
    const picked = await pickImage();
    if (!picked) return;
    setBusy(true);
    try {
      // Natural dimensions for the emote `info` (best-effort).
      let w: number | undefined, h: number | undefined;
      try {
        const bmp = await createImageBitmap(new Blob([picked.data], { type: picked.mimeType }));
        w = bmp.width;
        h = bmp.height;
        bmp.close?.();
      } catch {
        /* dimensions optional */
      }
      const mxc = await session.client.uploadMedia(picked.mimeType, picked.data, undefined);
      setPending({ url: picked.previewUrl, mxc, w, h, mime: picked.mimeType });
    } catch {
      setError("Upload failed.");
    } finally {
      setBusy(false);
    }
  }

  async function add() {
    const code = sanitizeShortcode(shortcode);
    if (!code || !pending) return;
    if (emotes.some((e) => e.shortcode === code)) {
      setError(`":${code}:" already exists.`);
      return;
    }
    setBusy(true);
    setError(undefined);
    const res = await store.addToRoomPack(roomId, {
      shortcode: code,
      url: pending.mxc,
      body: code,
      usage: usageArray(usage),
      info: { w: pending.w, h: pending.h, mimetype: pending.mime },
    });
    setBusy(false);
    if (res.ok) {
      URL.revokeObjectURL(pending.url);
      setPending(null);
      setShortcode("");
      await reload();
    } else {
      setError(res.forbidden ? "You don't have permission to edit emotes here." : res.error ?? "Couldn't save.");
    }
  }

  async function remove(code: string) {
    setBusy(true);
    setError(undefined);
    const res = await store.removeFromRoomPack(roomId, code);
    setBusy(false);
    if (res.ok) await reload();
    else setError(res.forbidden ? "You don't have permission." : res.error ?? "Couldn't remove.");
  }

  if (!canEdit) {
    return (
      <Section title="Emotes & Stickers">
        <p className="dm-muted">You don't have permission to edit this room's emotes.</p>
      </Section>
    );
  }

  return (
    <>
      <Section title="Add emote" footnote="Custom emoji and stickers for this room (MSC2545).">
        <Row
          label="Image"
          control={
            pending ? (
              <div className="dm-inline">
                <img className="emote-editor__thumb" src={pending.url} alt="" />
                <Button onClick={() => { URL.revokeObjectURL(pending.url); setPending(null); }}>
                  Change
                </Button>
              </div>
            ) : (
              <Button busy={busy} onClick={() => void chooseImage()}>Choose image…</Button>
            )
          }
        />
        {pending && (
          <>
            <Row
              label="Shortcode"
              control={
                <div className="dm-inline">
                  <span className="dm-prefix">:</span>
                  <TextField value={shortcode} onChange={setShortcode} placeholder="party_blob" />
                  <span className="dm-prefix">:</span>
                </div>
              }
            />
            <Row
              label="Use as"
              control={<Segmented value={usage} onChange={setUsage} options={USAGE_OPTIONS} />}
            />
            <Button busy={busy} disabled={!sanitizeShortcode(shortcode)} onClick={() => void add()}>
              Add to pack
            </Button>
          </>
        )}
        {error && <p className="dm-muted emote-editor__error">{error}</p>}
      </Section>

      <Section title={`Pack (${emotes.length})`}>
        {loading ? (
          <p className="dm-muted">Loading…</p>
        ) : emotes.length === 0 ? (
          <p className="dm-muted">No custom emotes yet.</p>
        ) : (
          <div className="emote-editor__grid">
            {emotes.map((e) => (
              <div className="emote-editor__item" key={e.shortcode}>
                <EmoteThumb mxc={e.url} />
                <div className="emote-editor__meta">
                  <span className="emote-editor__code">:{e.shortcode}:</span>
                  <span className="emote-editor__usage">{usageLabel(e.usage)}</span>
                </div>
                <button
                  className="emote-editor__remove"
                  aria-label={`Remove :${e.shortcode}:`}
                  disabled={busy}
                  onClick={() => void remove(e.shortcode)}
                >
                  <Icon name="trash" size={15} />
                </button>
              </div>
            ))}
          </div>
        )}
      </Section>
    </>
  );
}
