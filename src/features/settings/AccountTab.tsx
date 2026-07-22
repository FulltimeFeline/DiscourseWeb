// Account tab: the profile editor. Fields seed once from the loaded profile
// (guarded by a `loaded` flag so a later refresh doesn't clobber typing) and
// Save writes only changed fields. Display name + avatar go through the SDK;
// every extended field goes through the REST writers in profileWrites.ts.

import { useEffect, useRef, useState } from "react";
import { useApp, useSession } from "@/app/context";
import { useStore } from "@/core/reactive";
import type { OwnProfile } from "@/core/MatrixSession";
import { Section, Row, TextField, Button } from "./primitives";
import { pickImage } from "./media";
import { useMediaUrl } from "./useMediaUrl";
import { useCustomEmoji } from "@/features/emotes/emojiSession";
import { EmojiPicker } from "@/features/pickers";
import {
  setPronouns,
  setBio,
  setStatus,
  setTimezone,
  setBanner,
  removeBanner,
  setSocialLinks,
  type SocialLink,
} from "./profileWrites";

interface Draft {
  displayName: string;
  pronouns: string;
  status: string;
  bio: string;
  timezone: string;
  links: SocialLink[];
}

function toDraft(p: OwnProfile): Draft {
  return {
    displayName: p.displayName ?? "",
    pronouns: p.pronouns ?? "",
    status: p.status ?? "",
    bio: p.bio ?? "",
    timezone: p.timezone ?? "",
    links: p.socialLinks.map((l) => ({ ...l })),
  };
}

const norm = (s: string) => s.trim();

function linksEqual(a: SocialLink[], b: SocialLink[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((l, i) => l.title === b[i].title && l.link === b[i].link && (l.img ?? "") === (b[i].img ?? ""));
}

export function AccountTab() {
  const app = useApp();
  const session = useSession();
  const profile = useStore(session.ownProfile);

  const [draft, setDraft] = useState<Draft>(() => toDraft(profile));
  const loaded = useRef(false);
  const [saving, setSaving] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null);

  // Seed once, after the profile has actually loaded, so we don't overwrite the
  // draft on later background refreshes while the user is typing.
  useEffect(() => {
    if (loaded.current) return;
    if (profile.displayName !== undefined || profile.socialLinks.length || profile.bio || profile.pronouns) {
      setDraft(toDraft(profile));
      loaded.current = true;
    }
  }, [profile]);

  // Kick a load in case the shell didn't.
  useEffect(() => {
    void session.loadOwnProfile();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const avatarUrl = useMediaUrl(profile.avatarUrl, { thumb: 176 });
  const bannerUrl = useMediaUrl(profile.bannerUrl);

  const changed = {
    name: norm(draft.displayName) !== norm(profile.displayName ?? ""),
    pronouns: norm(draft.pronouns) !== norm(profile.pronouns ?? ""),
    status: norm(draft.status) !== norm(profile.status ?? ""),
    bio: norm(draft.bio) !== norm(profile.bio ?? ""),
    timezone: norm(draft.timezone) !== norm(profile.timezone ?? ""),
    links: !linksEqual(draft.links, profile.socialLinks),
  };
  const hasChanges = Object.values(changed).some(Boolean);

  async function saveAll() {
    setSaving(true);
    setResult(null);
    let allOk = true;
    try {
      if (changed.name && norm(draft.displayName)) {
        await session.client.setDisplayName(norm(draft.displayName));
      }
      if (changed.pronouns) allOk = (await setPronouns(session, norm(draft.pronouns))) && allOk;
      if (changed.status) allOk = (await setStatus(session, norm(draft.status))) && allOk;
      if (changed.bio) allOk = (await setBio(session, norm(draft.bio))) && allOk;
      if (changed.timezone) allOk = (await setTimezone(session, norm(draft.timezone))) && allOk;
      if (changed.links) allOk = (await setSocialLinks(session, draft.links)) && allOk;
      await session.loadOwnProfile();
      setResult(allOk ? { ok: true, message: "Profile saved." } : { ok: false, message: "Some fields didn't save." });
    } catch (e) {
      setResult({ ok: false, message: e instanceof Error ? e.message : "Save failed." });
    } finally {
      setSaving(false);
    }
  }

  async function changeAvatar() {
    const img = await pickImage();
    if (!img) return;
    try {
      await session.client.uploadAvatar(img.mimeType, img.data);
      await session.loadOwnProfile();
    } finally {
      URL.revokeObjectURL(img.previewUrl);
    }
  }
  async function removeAvatar() {
    await session.client.removeAvatar();
    await session.loadOwnProfile();
  }
  async function changeBanner() {
    const img = await pickImage();
    if (!img) return;
    try {
      await setBanner(session, img.data, img.mimeType);
      await session.loadOwnProfile();
    } finally {
      URL.revokeObjectURL(img.previewUrl);
    }
  }
  async function clearBanner() {
    await removeBanner(session);
    await session.loadOwnProfile();
  }

  const ffi = session.session();

  return (
    <div className="dm-account">
      <Section>
        <div className="dm-banner-edit">
          <div className="dm-banner-edit__img" style={bannerUrl ? { backgroundImage: `url(${bannerUrl})` } : undefined} />
          <div className="dm-banner-edit__actions">
            <Button onClick={changeBanner}>{profile.bannerUrl ? "Change Banner…" : "Add Banner…"}</Button>
            {profile.bannerUrl && <Button variant="destructive" onClick={clearBanner}>Remove</Button>}
          </div>
        </div>

        <div className="dm-avatar-edit">
          <div className="dm-avatar-edit__img" style={avatarUrl ? { backgroundImage: `url(${avatarUrl})` } : undefined}>
            {!avatarUrl && (draft.displayName || session.userId).slice(0, 1).toUpperCase()}
          </div>
          <div className="dm-avatar-edit__actions">
            <Button onClick={changeAvatar}>Change Photo</Button>
            {profile.avatarUrl && <Button variant="destructive" onClick={removeAvatar}>Remove</Button>}
          </div>
        </div>
      </Section>

      <Section title="Profile" footnote="Shows at the top of your profile card.">
        <Row label="Name" control={<TextField value={draft.displayName} onChange={(v) => setDraft({ ...draft, displayName: v })} placeholder="Display name" />} />
        <Row label="Pronouns" control={<TextField value={draft.pronouns} onChange={(v) => setDraft({ ...draft, pronouns: v })} placeholder="they/them" />} />
        <Row label="Status" control={<TextField value={draft.status} onChange={(v) => setDraft({ ...draft, status: v })} placeholder="What you're up to" />} />
        <Row label="Bio" control={<TextField multiline value={draft.bio} onChange={(v) => setDraft({ ...draft, bio: v })} />} />
        <Row
          label="Timezone"
          control={
            <div className="dm-inline">
              <TextField value={draft.timezone} onChange={(v) => setDraft({ ...draft, timezone: v })} placeholder="Continent/City" />
              <Button onClick={() => setDraft({ ...draft, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone })}>Use current</Button>
            </div>
          }
        />
      </Section>

      <SocialLinksEditor links={draft.links} onChange={(links) => setDraft({ ...draft, links })} />

      <Section>
        <div className="dm-save">
          <Button variant="primary" disabled={!hasChanges} busy={saving} onClick={saveAll}>
            Save Profile
          </Button>
          {result && <span className={result.ok ? "dm-msg dm-msg--ok" : "dm-msg dm-msg--err"}>{result.message}</span>}
        </div>
      </Section>

      <Section title="Account Info">
        <InfoRow label="User ID" value={session.userId} />
        <InfoRow label="Homeserver" value={ffi?.homeserverUrl ?? "—"} />
        <InfoRow label="Device ID" value={ffi?.deviceId ?? "—"} />
      </Section>

      <Section>
        <Button
          variant="destructive"
          onClick={() => {
            if (confirm(`Sign out of ${session.userId}?\nLocal session data is removed from this device.`)) {
              void app.logOut();
            }
          }}
        >
          Sign Out…
        </Button>
      </Section>
    </div>
  );
}

function InfoRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="dm-info">
      <span className="dm-info__label">{label}</span>
      <span className="dm-info__value" onClick={(e) => selectAll(e.currentTarget)}>{value}</span>
    </div>
  );
}

function selectAll(el: HTMLElement) {
  const r = document.createRange();
  r.selectNodeContents(el);
  const s = window.getSelection();
  s?.removeAllRanges();
  s?.addRange(r);
}

function SocialLinksEditor({ links, onChange }: { links: SocialLink[]; onChange: (l: SocialLink[]) => void }) {
  const session = useSession();
  const customEmoji = useCustomEmoji(session);
  const [pickerFor, setPickerFor] = useState<number | null>(null);
  const set = (i: number, patch: Partial<SocialLink>) =>
    onChange(links.map((x, j) => (j === i ? { ...x, ...patch } : x)));
  return (
    <Section title="Social Links" footnote="Each row: a title, an https:// link, and an optional icon (emoji or custom emote).">
      {links.map((l, i) => (
        <div key={i} className="dm-link-row">
          <TextField value={l.title} onChange={(v) => set(i, { title: v })} placeholder="Title" />
          <TextField value={l.link} onChange={(v) => set(i, { link: v })} placeholder="https://…" />
          <button
            type="button"
            className="dm-link-icon"
            onClick={() => setPickerFor((p) => (p === i ? null : i))}
            aria-label="Choose icon"
          >
            <LinkIconPreview img={l.img} />
          </button>
          <Button variant="destructive" onClick={() => onChange(links.filter((_, j) => j !== i))}>Remove</Button>
          {pickerFor === i && (
            <div className="dm-link-picker">
              <EmojiPicker
                customEmoji={customEmoji}
                allowCustom
                onPick={(pick) => {
                  set(i, { img: pick.kind === "unicode" ? pick.glyph : pick.mxc });
                  setPickerFor(null);
                }}
              />
            </div>
          )}
        </div>
      ))}
      <Button onClick={() => onChange([...links, { title: "", link: "", img: undefined }])}>Add Link</Button>
    </Section>
  );
}

function LinkIconPreview({ img }: { img?: string }) {
  const isMxc = !!img && img.startsWith("mxc://");
  const url = useMediaUrl(isMxc ? img : undefined, { thumb: 32 });
  if (!img) return <span>＋</span>;
  if (isMxc) return url ? <img className="dm-link-icon__mxc" src={url} alt="" /> : <span>🖼️</span>;
  return <span>{img}</span>;
}
