// A cross-room jump-to-event handoff.
//
// `discourse:jump-to-event` is dispatched synchronously right after
// `app.selectRoom`, but MainShell keys RoomPane on the selected room, so the
// target pane (and its listener) does not exist yet — the dispatch is heard
// only by the outgoing room, which discards it. So the request is also parked
// here and picked up by the pane once it mounts.
//
// One slot only, with a short TTL: a jump to a room that never materialises
// must not surprise-scroll the room an hour later.

interface PendingJump {
  roomId: string;
  eventId: string;
  at: number;
}

const TTL_MS = 30_000;

let pending: PendingJump | undefined;

function fresh(): PendingJump | undefined {
  if (pending && Date.now() - pending.at > TTL_MS) pending = undefined;
  return pending;
}

/** Park a jump request for a room that is about to be opened. */
export function setPendingJump(roomId: string, eventId: string): void {
  pending = { roomId, eventId, at: Date.now() };
}

/** The parked eventId for this room, if any. Does not clear. */
export function peekPendingJump(roomId: string): string | undefined {
  const p = fresh();
  return p && p.roomId === roomId ? p.eventId : undefined;
}

/** Compare-and-clear. True when this exact request was still parked. */
export function consumePendingJump(roomId: string, eventId: string): boolean {
  const p = fresh();
  if (!p || p.roomId !== roomId || p.eventId !== eventId) return false;
  pending = undefined;
  return true;
}
