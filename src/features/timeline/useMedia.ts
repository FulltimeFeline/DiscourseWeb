// React hooks for resolving Matrix media (MediaRef to a browser object URL) via
// the session MediaLoader, with a blurhash placeholder while it loads.

import { useEffect, useState } from "react";
import { useSession } from "@/app/context";
import { blurhashToDataURL } from "@/core/blurhash";
import type { MediaRef } from "@/models/types";

/**
 * Resolve a MediaRef to an object URL. Returns undefined until loaded. `thumb`
 * requests a server-side thumbnail at the given pixel size.
 */
export function useMedia(
  ref: MediaRef | undefined,
  thumb?: { width: number; height: number },
): string | undefined {
  const session = useSession();
  const mxc = ref?.mxc;
  const [url, setUrl] = useState<string | undefined>(() =>
    mxc ? session.mediaLoader.cached(mxc, thumb) : undefined,
  );

  useEffect(() => {
    if (!ref?.mxc && !ref?.source) {
      setUrl(undefined);
      return;
    }
    let cancelled = false;
    const cachedUrl = ref.mxc ? session.mediaLoader.cached(ref.mxc, thumb) : undefined;
    if (cachedUrl) {
      setUrl(cachedUrl);
      return;
    }
    void session.mediaLoader
      .load({ source: ref.source, mxc: ref.mxc, thumbnail: thumb })
      .then((u) => {
        if (!cancelled) setUrl(u);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ref?.mxc, thumb?.width, thumb?.height]);

  return url;
}

/** A blurhash data-URL placeholder, memoised by hash + size. */
export function useBlurhash(hash: string | undefined, width = 32, height = 32): string | undefined {
  const [url, setUrl] = useState<string | undefined>(undefined);
  useEffect(() => {
    setUrl(blurhashToDataURL(hash, width, height));
  }, [hash, width, height]);
  return url;
}
