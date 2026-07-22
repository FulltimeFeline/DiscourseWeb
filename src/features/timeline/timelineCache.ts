// Timelines are created and disposed per room open by RoomPane: a fresh view
// model each time, so nothing is shared across mounts. The only thing warmed
// ahead of time is the sliding-sync subscription, so a hovered room's message
// window is already loading by the time it's clicked.

import type { MatrixSession } from "@/core/MatrixSession";

/** Warm a room's sliding-sync subscription (e.g. on sidebar hover). */
export function prefetchTimeline(session: MatrixSession, roomId: string): void {
  try {
    void session.roomListService?.subscribeToRooms([roomId]);
  } catch {
    /* best effort */
  }
}

/** No-op: per-open timelines are disposed by RoomPane. Kept for the teardown wiring. */
export function disposeTimelineCache(_session: MatrixSession): void {}
