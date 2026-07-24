// "Get the app" links: native builds for each platform. Reused on the login
// screen (logged out), above the rail's settings cog (logged in), and on the
// mobile placeholder.

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import "./download.css";

interface AppLink {
  id: string;
  label: string;
  href: string;
  glyph: React.ReactNode;
}

const APPLE = (
  <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" aria-hidden>
    <path d="M16.4 12.9c0-2 1.6-3 1.7-3.1-.9-1.4-2.4-1.5-2.9-1.6-1.2-.1-2.4.7-3 .7-.6 0-1.6-.7-2.6-.7-1.3 0-2.6.8-3.2 2-1.4 2.4-.4 6 1 8 .7 1 1.4 2 2.5 2 1 0 1.3-.6 2.5-.6s1.5.6 2.5.6c1 0 1.7-.9 2.4-1.9.5-.8.8-1.5 1-2.4-2.4-.9-2.4-3.5-1.4-3.5zM14.6 6.9c.5-.7.9-1.6.8-2.5-.8 0-1.7.5-2.3 1.2-.5.6-.9 1.5-.8 2.4.9.1 1.7-.4 2.3-1.1z" />
  </svg>
);
const ANDROID = (
  <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" aria-hidden>
    <path d="M6 9v7a1 1 0 0 0 1 1h1v3a1 1 0 0 0 2 0v-3h4v3a1 1 0 0 0 2 0v-3h1a1 1 0 0 0 1-1V9H6zm-2 0a1 1 0 0 0-1 1v5a1 1 0 0 0 2 0v-5a1 1 0 0 0-1-1zm16 0a1 1 0 0 0-1 1v5a1 1 0 0 0 2 0v-5a1 1 0 0 0-1-1zM15.5 3l1-1.7a.3.3 0 0 0-.5-.3l-1 1.8A6.5 6.5 0 0 0 12 2c-1 0-2 .2-3 .6l-1-1.8a.3.3 0 0 0-.5.3l1 1.7A5.6 5.6 0 0 0 6 8h12a5.6 5.6 0 0 0-2.5-5zM9.5 6a.7.7 0 1 1 0-1.4.7.7 0 0 1 0 1.4zm5 0a.7.7 0 1 1 0-1.4.7.7 0 0 1 0 1.4z" />
  </svg>
);
const DOWNLOAD = (
  <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d="M12 3v11m0 0 4-4m-4 4-4-4" />
    <path d="M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2" />
  </svg>
);

export const APP_LINKS: AppLink[] = [
  { id: "macos", label: "macOS", href: "https://github.com/FulltimeFeline/Discourse/releases/latest", glyph: APPLE },
  { id: "ios", label: "iOS · TestFlight", href: "https://testflight.apple.com/join/85BHSXps", glyph: APPLE },
  { id: "android", label: "Android", href: "https://github.com/FulltimeFeline/DiscourseAndroid/releases/latest", glyph: ANDROID },
];

/** The three platform links as a plain list (login screen, mobile placeholder). */
export function DownloadLinks({ heading = "Get the app" }: { heading?: string }) {
  return (
    <div className="dl-links">
      {heading && <div className="dl-links__heading">{heading}</div>}
      <div className="dl-links__row">
        {APP_LINKS.map((l) => (
          <a key={l.id} className="dl-links__item" href={l.href} target="_blank" rel="noopener noreferrer">
            {l.glyph}
            <span>{l.label}</span>
          </a>
        ))}
      </div>
    </div>
  );
}

/** Compact rail button (above the settings cog) that pops the platform links. */
export function DownloadButton() {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (ref.current?.contains(t) || menuRef.current?.contains(t)) return;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div className="dl-btn" ref={ref}>
      {open &&
        createPortal(
          <div className="dl-menu" role="menu" ref={menuRef}>
            <div className="dl-menu__heading">Get the app</div>
            {APP_LINKS.map((l) => (
              <a
                key={l.id}
                className="dl-menu__item"
                role="menuitem"
                href={l.href}
                target="_blank"
                rel="noopener noreferrer"
                onClick={() => setOpen(false)}
              >
                {l.glyph} <span>{l.label}</span>
              </a>
            ))}
          </div>,
          document.body,
        )}
      <button
        className="dl-settings-btn"
        aria-label="Get the app"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        {DOWNLOAD}
      </button>
    </div>
  );
}
