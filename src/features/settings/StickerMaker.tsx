// Personal sticker maker (Settings Stickers). Pick an image, name it, choose a
// pack; it's center-square cropped and downscaled to a 512px PNG (alpha
// preserved), uploaded, and saved to the account-wide im.ponies.user_emotes
// pack (foreign entries preserved by StickerStore.save). Existing stickers list
// with per-item delete.

import { useCallback, useEffect, useState } from "react";
import { useSession } from "@/app/context";
import { useStickerStore } from "@/features/emotes/emojiSession";
import type { Sticker } from "@/core/StickerStore";
import { Section, Row, TextField, Button } from "./primitives";
import { pickImage } from "./media";
import { useMediaUrl } from "./useMediaUrl";
import { Icon } from "@/ui/Icon";

const STICKER_PX = 512;

/** Center-square crop and downscale to a 512px-or-smaller PNG, preserving transparency. */
async function makeStickerPng(data: ArrayBuffer, mimeType: string): Promise<Blob | undefined> {
  try {
    const bmp = await createImageBitmap(new Blob([data], { type: mimeType }));
    const side = Math.min(bmp.width, bmp.height);
    const out = Math.min(STICKER_PX, side);
    const canvas = document.createElement("canvas");
    canvas.width = out;
    canvas.height = out;
    const ctx = canvas.getContext("2d");
    if (!ctx) return undefined;
    const sx = (bmp.width - side) / 2;
    const sy = (bmp.height - side) / 2;
    ctx.drawImage(bmp, sx, sy, side, side, 0, 0, out, out);
    bmp.close?.();
    return await new Promise<Blob | undefined>((res) =>
      canvas.toBlob((b) => res(b ?? undefined), "image/png"),
    );
  } catch {
    return undefined;
  }
}

function sanitizeShortcode(raw: string): string {
  return raw.toLowerCase().replace(/\s+/g, "_").replace(/[^a-z0-9_.-]/g, "");
}

function StickerThumb({ mxc }: { mxc: string }) {
  const url = useMediaUrl(mxc, { thumb: 96 });
  return url ? <img className="sticker-maker__thumb" src={url} alt="" loading="lazy" /> : <span className="sticker-maker__thumb" />;
}

export function StickerMaker() {
  const session = useSession();
  const store = useStickerStore(session);
  const [stickers, setStickers] = useState<Sticker[]>([]);
  const [name, setName] = useState("");
  const [pack, setPack] = useState("Discourse");
  const [pending, setPending] = useState<{ url: string; mxc: string; w: number; h: number; size: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  const reload = useCallback(async () => {
    await store.refresh();
    setStickers(store.allStickers());
  }, [store]);

  useEffect(() => {
    void reload();
  }, [reload]);

  async function chooseImage() {
    setError(undefined);
    const picked = await pickImage();
    if (!picked) return;
    setBusy(true);
    try {
      const png = await makeStickerPng(picked.data, picked.mimeType);
      if (!png) {
        setError("Couldn't process that image.");
        return;
      }
      const buf = await png.arrayBuffer();
      const mxc = await session.client.uploadMedia("image/png", buf, undefined);
      setPending({ url: URL.createObjectURL(png), mxc, w: STICKER_PX, h: STICKER_PX, size: png.size });
      URL.revokeObjectURL(picked.previewUrl);
    } catch {
      setError("Upload failed.");
    } finally {
      setBusy(false);
    }
  }

  async function add() {
    const code = sanitizeShortcode(name);
    if (!code || !pending) return;
    if (stickers.some((s) => s.shortcode === code)) {
      setError(`":${code}:" already exists.`);
      return;
    }
    setBusy(true);
    setError(undefined);
    const next: Sticker = {
      shortcode: code,
      url: pending.mxc,
      body: name.trim() || code,
      pack: pack.trim() || "Discourse",
      info: { w: pending.w, h: pending.h, mimetype: "image/png", size: pending.size },
    };
    const ok = await store.save([...stickers, next]);
    setBusy(false);
    if (ok) {
      URL.revokeObjectURL(pending.url);
      setPending(null);
      setName("");
      await reload();
    } else {
      setError("Couldn't save the sticker.");
    }
  }

  async function remove(code: string) {
    setBusy(true);
    const ok = await store.save(stickers.filter((s) => s.shortcode !== code));
    setBusy(false);
    if (ok) await reload();
    else setError("Couldn't remove.");
  }

  return (
    <>
      <Section title="Make a sticker" footnote="Images are cropped square and scaled to 512px. Saved to your account.">
        <Row
          label="Image"
          control={
            pending ? (
              <div className="dm-inline">
                <img className="sticker-maker__thumb" src={pending.url} alt="" />
                <Button onClick={() => { URL.revokeObjectURL(pending.url); setPending(null); }}>Change</Button>
              </div>
            ) : (
              <Button busy={busy} onClick={() => void chooseImage()}>Choose image…</Button>
            )
          }
        />
        {pending && (
          <>
            <Row label="Name" control={<TextField value={name} onChange={setName} placeholder="party_blob" />} />
            <Row label="Pack" control={<TextField value={pack} onChange={setPack} placeholder="Discourse" />} />
            <Button busy={busy} disabled={!sanitizeShortcode(name)} onClick={() => void add()}>Add sticker</Button>
          </>
        )}
        {error && <p className="dm-muted emote-editor__error">{error}</p>}
      </Section>

      <Section title={`My stickers (${stickers.length})`}>
        {stickers.length === 0 ? (
          <p className="dm-muted">No stickers yet.</p>
        ) : (
          <div className="sticker-maker__grid">
            {stickers.map((s) => (
              <div className="sticker-maker__item" key={s.shortcode}>
                <StickerThumb mxc={s.url} />
                <span className="sticker-maker__code">:{s.shortcode}:</span>
                <button
                  className="emote-editor__remove"
                  aria-label={`Remove :${s.shortcode}:`}
                  disabled={busy}
                  onClick={() => void remove(s.shortcode)}
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
