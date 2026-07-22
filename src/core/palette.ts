// Deterministic per-identity colors for avatars and sender names: the 8 Apple
// system colors, indexed by a stable hash of the key (user id or room name).
// Avatars fill the base color with a subtly-lighter top-to-base vertical
// gradient; sender names use the flat base color.

const PALETTE = [
  "#0a84ff", // blue
  "#5e5ce6", // indigo
  "#bf5af2", // purple
  "#ff375f", // pink
  "#ff453a", // red
  "#ff9f0a", // orange
  "#40c8e0", // teal
  "#32d74b", // green
] as const;

/** `hash = hash * 31 + charCode` accumulator, kept in 32-bit range. */
function hashKey(key: string): number {
  let h = 0;
  for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) | 0;
  return Math.abs(h);
}

/** Flat base color for `key` (used for sender names). */
export function colorFor(key: string): string {
  return PALETTE[hashKey(key) % PALETTE.length];
}

/** Vertical gradient (lighter top to base) for `key` (used for avatar fills). */
export function gradientFor(key: string): string {
  const base = colorFor(key);
  return `linear-gradient(180deg, color-mix(in srgb, ${base} 82%, white) 0%, ${base} 100%)`;
}
