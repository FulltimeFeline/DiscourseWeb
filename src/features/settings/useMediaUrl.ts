// Resolve an mxc:// URL to a browser object URL via the session MediaLoader.
// Returns undefined until resolved. Thumbnail size optional (full content when
// omitted, e.g. banners at their natural width).

import { useEffect, useState } from "react";
import { useSession } from "@/app/context";

export function useMediaUrl(
  mxc: string | undefined,
  opts?: { thumb?: number },
): string | undefined {
  const session = useSession();
  const [url, setUrl] = useState<string | undefined>(() =>
    mxc ? session.mediaLoader.cached(mxc, opts?.thumb ? { width: opts.thumb, height: opts.thumb } : undefined) : undefined,
  );

  useEffect(() => {
    let alive = true;
    if (!mxc || !mxc.startsWith("mxc://")) {
      setUrl(undefined);
      return;
    }
    const thumb = opts?.thumb ? { width: opts.thumb, height: opts.thumb } : undefined;
    const cached = session.mediaLoader.cached(mxc, thumb);
    if (cached) {
      setUrl(cached);
      return;
    }
    void session.mediaLoader
      .load({ source: session.mediaSourceFor(mxc), mxc, thumbnail: thumb })
      .then((u) => {
        if (alive) setUrl(u);
      });
    return () => {
      alive = false;
    };
  }, [mxc, opts?.thumb, session]);

  return url;
}
