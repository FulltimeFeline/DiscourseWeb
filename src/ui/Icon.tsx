// Monochrome line icons. Use these instead of emoji for any UI affordance;
// emoji render as colourful platform glyphs and break the look. Icons inherit
// `currentColor` and scale with font-size (1em) by default.

import type { ReactElement, SVGProps } from "react";

export type IconName =
  | "lock"
  | "envelope"
  | "mic"
  | "phone"
  | "video"
  | "info"
  | "search"
  | "plus"
  | "chevron-down"
  | "chevron-left"
  | "chevron-right"
  | "check"
  | "check-double"
  | "x"
  | "play"
  | "pause"
  | "link"
  | "image"
  | "file"
  | "music"
  | "gear"
  | "reply"
  | "send"
  | "people"
  | "smile"
  | "ellipsis"
  | "trash"
  | "edit"
  | "star"
  | "bell"
  | "clock"
  | "shield"
  | "warning"
  | "alert-circle"
  | "thread"
  | "pin"
  | "flag"
  | "copy"
  | "hash"
  | "retry"
  | "poll";

const P: Record<IconName, ReactElement> = {
  lock: (
    <>
      <rect x="5" y="11" width="14" height="10" rx="2" />
      <path d="M8 11V7a4 4 0 0 1 8 0v4" />
    </>
  ),
  envelope: (
    <>
      <rect x="3" y="5" width="18" height="14" rx="2.5" />
      <path d="m4 7 8 6 8-6" />
    </>
  ),
  mic: (
    <>
      <rect x="9" y="3" width="6" height="11" rx="3" />
      <path d="M6 11a6 6 0 0 0 12 0M12 17v4M9 21h6" />
    </>
  ),
  phone: (
    <path d="M6.6 3.5 4.3 5.8c-.7.7-.9 1.7-.5 2.6a20 20 0 0 0 11.8 11.8c.9.4 1.9.2 2.6-.5l2.3-2.3c.5-.5.4-1.3-.2-1.7l-3-2a1.3 1.3 0 0 0-1.5.1l-1 .8a15 15 0 0 1-5.6-5.6l.8-1c.4-.5.4-1.1.1-1.6l-2-3c-.4-.6-1.2-.7-1.7-.2Z" />
  ),
  video: (
    <>
      <rect x="3" y="6" width="13" height="12" rx="2.5" />
      <path d="m16 10 5-3v10l-5-3" />
    </>
  ),
  info: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 11v5M12 8h.01" />
    </>
  ),
  search: (
    <>
      <circle cx="11" cy="11" r="7" />
      <path d="m21 21-4.3-4.3" />
    </>
  ),
  plus: <path d="M12 5v14M5 12h14" />,
  "chevron-down": <path d="m6 9 6 6 6-6" />,
  "chevron-left": <path d="m15 6-6 6 6 6" />,
  "chevron-right": <path d="m9 6 6 6-6 6" />,
  check: <path d="m5 12 5 5L20 7" />,
  "check-double": <path d="m2 12 5 5L16 8M13 15l1 1L23 7" />,
  x: <path d="M6 6l12 12M18 6 6 18" />,
  play: <path d="M7 5v14l12-7z" fill="currentColor" stroke="none" />,
  pause: (
    <>
      <rect x="6" y="5" width="4" height="14" rx="1" fill="currentColor" stroke="none" />
      <rect x="14" y="5" width="4" height="14" rx="1" fill="currentColor" stroke="none" />
    </>
  ),
  link: <path d="M9 15 15 9M10.5 6.5 12 5a4 4 0 1 1 6 6l-1.5 1.5M13.5 17.5 12 19a4 4 0 1 1-6-6l1.5-1.5" />,
  image: (
    <>
      <rect x="3" y="4" width="18" height="16" rx="2.5" />
      <circle cx="8.5" cy="9.5" r="1.5" />
      <path d="m4 17 5-5 4 4 3-3 4 4" />
    </>
  ),
  file: (
    <>
      <path d="M6 3h8l4 4v14H6z" />
      <path d="M14 3v4h4" />
    </>
  ),
  music: <path d="M9 18V6l10-2v12M9 18a3 3 0 1 1-6 0 3 3 0 0 1 6 0Zm10-2a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z" />,
  gear: (
    <>
      <path d="M9.594 3.94c.09-.542.56-.94 1.11-.94h2.593c.55 0 1.02.398 1.11.94l.213 1.281c.063.374.313.686.645.87.074.04.147.083.22.127.324.196.72.257 1.075.124l1.217-.456a1.125 1.125 0 0 1 1.37.49l1.296 2.247a1.125 1.125 0 0 1-.26 1.431l-1.003.827c-.293.24-.438.613-.43.992a7.723 7.723 0 0 1 0 .255c-.008.378.137.75.43.991l1.004.827c.424.35.534.955.26 1.43l-1.298 2.247a1.125 1.125 0 0 1-1.369.491l-1.217-.456c-.355-.133-.75-.072-1.076.124a6.47 6.47 0 0 1-.22.128c-.331.183-.581.495-.644.869l-.213 1.281c-.09.543-.56.94-1.11.94h-2.594c-.55 0-1.019-.398-1.11-.94l-.213-1.281c-.062-.374-.312-.686-.644-.87a6.52 6.52 0 0 1-.22-.127c-.325-.196-.72-.257-1.076-.124l-1.217.456a1.125 1.125 0 0 1-1.369-.49l-1.297-2.247a1.125 1.125 0 0 1 .26-1.431l1.004-.827c.292-.24.437-.613.43-.991a6.932 6.932 0 0 1 0-.256c.007-.378-.138-.75-.43-.99l-1.004-.828a1.125 1.125 0 0 1-.26-1.43l1.297-2.247a1.125 1.125 0 0 1 1.37-.491l1.216.456c.356.133.751.072 1.076-.124.072-.044.146-.086.22-.128.332-.183.582-.495.644-.869l.214-1.281Z" />
      <path d="M15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z" />
    </>
  ),
  reply: <path d="M9 7 4 12l5 5M4 12h9a6 6 0 0 1 6 6v1" />,
  send: <path d="M12 20V5M6 11l6-6 6 6" />,
  people: (
    <>
      <circle cx="9" cy="8" r="3.2" />
      <path d="M3.5 20a5.5 5.5 0 0 1 11 0" />
      <path d="M16 5.2a3.2 3.2 0 0 1 0 5.6M17.5 20a5.5 5.5 0 0 0-2.2-4.4" />
    </>
  ),
  smile: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M8.5 14a4 4 0 0 0 7 0M9 9.5h.01M15 9.5h.01" />
    </>
  ),
  ellipsis: <path d="M6 12h.01M12 12h.01M18 12h.01" />,
  trash: <path d="M4 7h16M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2M6 7l1 13h10l1-13" />,
  edit: <path d="M4 20h4L19 9l-4-4L4 16zM14 6l4 4" />,
  star: <path d="m12 3 2.6 5.3 5.9.9-4.2 4.1 1 5.8-5.3-2.8-5.3 2.8 1-5.8L3.5 9.2l5.9-.9z" />,
  bell: <path d="M6 9a6 6 0 0 1 12 0c0 5 2 6 2 6H4s2-1 2-6M10 20a2 2 0 0 0 4 0" />,
  clock: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3.5 2" />
    </>
  ),
  shield: <path d="M12 3 5 6v5c0 4.5 3 8 7 10 4-2 7-5.5 7-10V6z" />,
  warning: <path d="M12 4 2.5 20h19zM12 10v4M12 17.5h.01" />,
  "alert-circle": (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 8v5M12 16h.01" />
    </>
  ),
  thread: (
    <>
      <path d="M4 6h16M4 11h11M4 16h7" />
      <path d="M15 16l3 3 4-6" />
    </>
  ),
  pin: (
    <>
      <path d="M12 21c4-4.5 6-7.6 6-11a6 6 0 1 0-12 0c0 3.4 2 6.5 6 11Z" />
      <circle cx="12" cy="10" r="2.2" />
    </>
  ),
  flag: <path d="M5 21V4M5 4h11l-2 3 2 3H5" />,
  copy: (
    <>
      <rect x="9" y="9" width="11" height="11" rx="2" />
      <path d="M5 15H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v1" />
    </>
  ),
  hash: <path d="M9 3 7 21M17 3l-2 18M4 8h16M3 16h16" />,
  retry: <path d="M20 11a8 8 0 1 0-.9 4M20 4v5h-5" />,
  poll: (
    <>
      <path d="M4 20h16" />
      <rect x="5.5" y="10" width="3.4" height="8" rx="0.8" />
      <rect x="10.6" y="5" width="3.4" height="13" rx="0.8" />
      <rect x="15.7" y="13" width="3.4" height="5" rx="0.8" />
    </>
  ),
};

interface Props extends Omit<SVGProps<SVGSVGElement>, "name"> {
  name: IconName;
  size?: number | string;
  strokeWidth?: number;
}

export function Icon({ name, size = "1em", strokeWidth = 1.9, ...rest }: Props) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      focusable={false}
      {...rest}
    >
      {P[name]}
    </svg>
  );
}
