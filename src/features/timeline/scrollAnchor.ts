// Per-room scroll-position persistence for the timeline.
//
// For each room we remember the eventId of the top-most visible real event (or
// a "was at bottom" flag). On reopening a room, scroll is restored to that event
// so the user lands where they left off. Writes are throttled to avoid hammering
// localStorage on every scroll frame; the newest position wins.

const KEY_PREFIX = "timeline.anchor.";

/** "bottom" means the user was tailing the newest message. */
export type TimelineAnchor = { kind: "bottom" } | { kind: "event"; eventId: string };

function keyFor(roomId: string): string {
  return KEY_PREFIX + roomId;
}

export function loadAnchor(roomId: string): TimelineAnchor | undefined {
  try {
    const raw = localStorage.getItem(keyFor(roomId));
    if (!raw) return undefined;
    const parsed = JSON.parse(raw) as TimelineAnchor;
    if (parsed && (parsed.kind === "bottom" || (parsed.kind === "event" && parsed.eventId))) {
      return parsed;
    }
  } catch {
    // Corrupt or blocked storage: behave as if there were no anchor.
  }
  return undefined;
}

function writeAnchor(roomId: string, anchor: TimelineAnchor): void {
  try {
    localStorage.setItem(keyFor(roomId), JSON.stringify(anchor));
  } catch {
    // Storage full or disabled: ignore, restore just won't happen next time.
  }
}

/**
 * A throttled writer scoped to one room instance. Call `set()` freely on scroll;
 * it coalesces to at most one write per `intervalMs`, always flushing the last
 * value. Call `flush()` to persist immediately (e.g. on unmount or room change).
 */
export function createAnchorWriter(roomId: string, intervalMs = 500) {
  let pending: TimelineAnchor | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const flush = () => {
    if (timer) {
      clearTimeout(timer);
      timer = undefined;
    }
    if (pending) {
      writeAnchor(roomId, pending);
      pending = undefined;
    }
  };

  const set = (anchor: TimelineAnchor) => {
    pending = anchor;
    if (timer) return;
    timer = setTimeout(() => {
      timer = undefined;
      flush();
    }, intervalMs);
  };

  return { set, flush };
}
