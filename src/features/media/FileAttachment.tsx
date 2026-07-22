// Inline received file. A document row: icon + filename + size, tap to download
// (fetches full content via the loader and triggers a browser download).

import { useState } from "react";
import { Icon } from "@/ui/Icon";
import type { MediaLoader } from "@/core/MediaLoader";
import type { FileContent } from "@/models/types";
import "./media.css";

interface Props {
  content: FileContent;
  loader: MediaLoader;
}

export function FileAttachment({ content, loader }: Props) {
  const [busy, setBusy] = useState(false);

  const download = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const url = await loader.load({
        source: content.source.source,
        mxc: content.source.mxc,
        mimetype: content.mimetype,
      });
      if (url) {
        const a = document.createElement("a");
        a.href = url;
        a.download = content.body || "download";
        document.body.appendChild(a);
        a.click();
        a.remove();
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <button className="dc-file-attachment" onClick={download} disabled={busy} type="button">
      <span className="dc-file-icon" aria-hidden>
        <Icon name="file" size={20} />
      </span>
      <span className="dc-file-meta">
        <span className="dc-file-name">{content.body || "File"}</span>
        {content.size != null && (
          <span className="dc-file-size">{formatBytes(content.size)}</span>
        )}
      </span>
      {busy && <span className="dc-spinner small" />}
    </button>
  );
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let v = bytes / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v < 10 ? 1 : 0)} ${units[i]}`;
}
