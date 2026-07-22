// Shared hooks for received-media components. They drive the MediaLoader
// (memory → SDK IndexedDB store → network) and expose object URLs + load state
// to InlineImage / VideoAttachment / FileAttachment / VoiceMessagePlayer.

import { useEffect, useState } from "react";
import type { MediaLoader } from "@/core/MediaLoader";
import type { MediaRef } from "@/models/types";

export interface MediaState {
  url?: string;
  loading: boolean;
  failed: boolean;
  /** Bump to retry after a failure. */
  retry: () => void;
}

interface Options {
  /** Thumbnail pixel size; omit for full content. */
  thumbnail?: { width: number; height: number };
  mimetype?: string;
  /** When false, don't fetch until `retry`/gate is lifted (data-saver). */
  enabled?: boolean;
}

/**
 * Resolve a MediaRef to an object URL via the loader. Encrypted sources resolve
 * inside the loader (full download + local decode); we just await the URL.
 */
export function useMediaUrl(
  loader: MediaLoader,
  ref: MediaRef | undefined,
  opts: Options = {},
): MediaState {
  const { thumbnail, mimetype, enabled = true } = opts;
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<{ url?: string; loading: boolean; failed: boolean }>(() => {
    const cached = ref ? loader.cached(ref.mxc, thumbnail) : undefined;
    return { url: cached, loading: false, failed: false };
  });

  useEffect(() => {
    if (!ref || !enabled) return;
    const cached = loader.cached(ref.mxc, thumbnail);
    if (cached) {
      setState({ url: cached, loading: false, failed: false });
      return;
    }
    let alive = true;
    setState((s) => ({ ...s, loading: true, failed: false }));
    loader
      .load({ source: ref.source, mxc: ref.mxc, mimetype, thumbnail })
      .then((url) => {
        if (!alive) return;
        setState({ url, loading: false, failed: !url });
      })
      .catch(() => {
        if (alive) setState({ url: undefined, loading: false, failed: true });
      });
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ref?.mxc, thumbnail?.width, thumbnail?.height, mimetype, enabled, attempt]);

  return {
    ...state,
    retry: () => setAttempt((a) => a + 1),
  };
}
