// Circular avatar with a synchronous cache-hit first paint and a deterministic
// colored-initials fallback. Recycled rows show the cached thumbnail on the
// first frame instead of flashing initials, then the async load fills in.

import { useEffect, useState } from "react";
import { useSession } from "@/app/context";
import { gradientFor } from "@/core/palette";

export { gradientFor };

export function initialsFor(name: string): string {
  const stripped = name.replace(/^[#@!+\s]+/, "").trim();
  if (!stripped) return "?";
  const words = stripped.split(/\s+/).slice(0, 2);
  const letters = words.map((w) => w[0]).join("");
  return letters.toUpperCase() || "?";
}

export function RoomAvatar({
  name,
  avatarUrl,
  size = 28,
}: {
  name: string;
  avatarUrl?: string;
  size?: number;
}) {
  const session = useSession();
  const px = size * 2; // request 2x for retina
  // Synchronous cache hit → paint immediately, no initials flash.
  const cachedKey = avatarUrl ? { width: px, height: px } : undefined;
  const [url, setUrl] = useState<string | undefined>(() =>
    avatarUrl ? session.mediaLoader.cached(avatarUrl, cachedKey) : undefined,
  );

  useEffect(() => {
    let alive = true;
    if (!avatarUrl) {
      setUrl(undefined);
      return;
    }
    const hit = session.mediaLoader.cached(avatarUrl, { width: px, height: px });
    if (hit) {
      setUrl(hit);
      return;
    }
    setUrl(undefined);
    void session.mediaLoader
      .avatar(avatarUrl, session.mediaSourceFor(avatarUrl), px)
      .then((u) => {
        if (alive) setUrl(u);
      });
    return () => {
      alive = false;
    };
  }, [avatarUrl, px, session]);

  const style: React.CSSProperties = {
    width: size,
    height: size,
    borderRadius: "50%",
    flexShrink: 0,
    objectFit: "cover",
  };

  if (url) {
    return <img className="rl-avatar" src={url} alt="" style={style} aria-hidden decoding="async" />;
  }
  return (
    <div
      className="rl-avatar rl-avatar--initials"
      aria-hidden
      style={{
        ...style,
        background: gradientFor(name),
        color: "#fff",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        fontSize: Math.round(size * 0.42),
        fontWeight: 500,
        letterSpacing: "0.01em",
      }}
    >
      {initialsFor(name)}
    </div>
  );
}
