// The Space Home sheet: banner image, space avatar + name, and the space bio
// (topic, rendered as markdown). Opened by tapping the space banner row in the
// list. Admins can set/remove the banner.

import { useEffect, useState } from "react";
import type { SpaceItem, SpacesViewModel } from "./SpacesViewModel";
import { RoomAvatar } from "./RoomAvatar";
import { renderMarkdown } from "@/features/timeline/render";
import { pickImage } from "@/features/settings/media";
import { Icon } from "@/ui/Icon";
import "./roomlist.css";

export function SpaceHomeView({
  space,
  spaces,
  bannerUrl,
  onBannerChanged,
  onClose,
}: {
  space: SpaceItem;
  spaces: SpacesViewModel;
  bannerUrl?: string;
  onBannerChanged: (mxc: string | undefined) => void;
  onClose: () => void;
}) {
  const topic = space.topic?.trim();
  const [canEdit, setCanEdit] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let alive = true;
    void spaces.canEditSpaceBanner(space.id).then((ok) => {
      if (alive) setCanEdit(ok);
    });
    return () => {
      alive = false;
    };
  }, [spaces, space.id]);

  async function editBanner() {
    const picked = await pickImage();
    if (!picked) return;
    setBusy(true);
    const mxc = await spaces.setSpaceBanner(space.id, picked.data, picked.mimeType);
    URL.revokeObjectURL(picked.previewUrl);
    setBusy(false);
    if (mxc) onBannerChanged(mxc);
  }

  async function removeBanner() {
    setBusy(true);
    const ok = await spaces.removeSpaceBanner(space.id);
    setBusy(false);
    if (ok) onBannerChanged(undefined);
  }

  return (
    <div className="rl-sheet-scrim" onClick={onClose} role="presentation">
      <div
        className="rl-sheet"
        role="dialog"
        aria-label={`${space.name} details`}
        onClick={(e) => e.stopPropagation()}
      >
        <button className="rl-sheet__close" type="button" onClick={onClose} aria-label="Close">
          <Icon name="x" size={16} />
        </button>
        {bannerUrl && (
          <div className="rl-sheet__banner" style={{ backgroundImage: `url(${bannerUrl})` }} />
        )}
        {canEdit && (
          <div className="rl-sheet__banner-actions">
            <button type="button" disabled={busy} onClick={() => void editBanner()}>
              <Icon name="image" size={14} /> {bannerUrl ? "Change banner" : "Add banner"}
            </button>
            {bannerUrl && (
              <button type="button" disabled={busy} onClick={() => void removeBanner()}>
                <Icon name="trash" size={14} /> Remove
              </button>
            )}
          </div>
        )}
        <div className="rl-sheet__head">
          <RoomAvatar name={space.name} avatarUrl={space.avatarUrl} size={56} />
          <h2 className="rl-sheet__name">{space.name}</h2>
        </div>
        {topic ? (
          <div
            className="rl-sheet__bio"
            dangerouslySetInnerHTML={{ __html: renderMarkdown(topic) }}
          />
        ) : (
          <div className="rl-sheet__bio rl-sheet__bio--empty">No description.</div>
        )}
      </div>
    </div>
  );
}
