// React hooks for resolving Matrix media (MediaRef to a browser object URL) via
// the session MediaLoader, with a blurhash placeholder while it loads.

import { useEffect, useMemo, useState } from "react";
import { useSession } from "@/app/context";
import { blurhashToDataURL } from "@/core/blurhash";
import type { MediaRef } from "@/models/types";

/**
 * Resolve a MediaRef to an object URL, reporting terminal failure. Returns
 * `{ url: undefined, failed: false }` while loading, `failed: true` when the
 * load resolved without a URL. `thumb` requests a server-side thumbnail at the
 * given pixel size.
 */
export function useMediaWithStatus(
  ref: MediaRef | undefined,
  thumb?: { width: number; height: number },
): { url: string | undefined; failed: boolean } {
  const session = useSession();
  const mxc = ref?.mxc;
  const [url, setUrl] = useState<string | undefined>(() =>
    mxc ? session.mediaLoader.cached(mxc, thumb) : undefined,
  );
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    setFailed(false);
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
        if (cancelled) return;
        setUrl(u);
        if (u === undefined) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ref?.mxc, thumb?.width, thumb?.height]);

  return { url, failed };
}

/**
 * Resolve a MediaRef to an object URL. Returns undefined until loaded. `thumb`
 * requests a server-side thumbnail at the given pixel size.
 */
export function useMedia(
  ref: MediaRef | undefined,
  thumb?: { width: number; height: number },
): string | undefined {
  return useMediaWithStatus(ref, thumb).url;
}

/**
 * A blurhash data-URL placeholder. Decoding is pure and globally cached by
 * hash+size, so compute it synchronously with `useMemo`: the placeholder is
 * present on the first paint (no undefined→url flash and no extra render that
 * an effect would cause), which keeps image rows from reflowing as you scroll.
 */
export function useBlurhash(hash: string | undefined, width = 32, height = 32): string | undefined {
  return useMemo(() => blurhashToDataURL(hash, width, height), [hash, width, height]);
}
