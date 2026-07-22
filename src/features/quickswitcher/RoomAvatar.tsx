// A small avatar used by the app-shell features (quick switcher, search,
// compose). Resolves an mxc thumbnail via the session MediaLoader, falling back
// to colored initials. Kept local to these features to avoid coupling to the
// room-list feature; can be swapped for a shared avatar later.

import { useEffect, useState } from "react";
import { useSession } from "@/app/context";
import { gradientFor } from "@/core/palette";

function initials(name: string): string {
  const parts = name.replace(/^[#!@]/, "").trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}


export function RoomAvatar({
  name,
  avatarUrl,
  size = 32,
}: {
  name: string;
  avatarUrl?: string;
  size?: number;
}) {
  const session = useSession();
  const [url, setUrl] = useState<string | undefined>(() =>
    avatarUrl ? session.mediaLoader.cached(avatarUrl, { width: size, height: size }) : undefined,
  );

  useEffect(() => {
    let alive = true;
    setUrl(avatarUrl ? session.mediaLoader.cached(avatarUrl, { width: size, height: size }) : undefined);
    if (avatarUrl && !session.mediaLoader.cached(avatarUrl, { width: size, height: size })) {
      void session.mediaLoader
        .avatar(avatarUrl, undefined, size)
        .then((u) => alive && u && setUrl(u));
    }
    return () => {
      alive = false;
    };
  }, [avatarUrl, session, size]);

  const style: React.CSSProperties = { width: size, height: size };
  if (url) {
    return <img className="qs-avatar" style={style} src={url} alt="" />;
  }
  return (
    <div
      className="qs-avatar qs-avatar--fallback"
      style={{ ...style, background: gradientFor(name) }}
      aria-hidden="true"
    >
      {initials(name)}
    </div>
  );
}
