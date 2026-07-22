// Route a permalink / room address to an open room. Shared by the deep-link
// handler, notification clicks, and the "join by address" compose flow.
//
// AppState today only carries `selectedRoomId`; event-level navigation
// (scroll-to-event) would need a field on AppState that the timeline consumes.
// Until then we open the room and dispatch a jump-to-event; the eventId is
// passed through so callers can wire it once the field exists.

import type { AppState } from "@/app/AppState";
import type { MatrixSession } from "@/core/MatrixSession";
import { parsePermalink, type PermalinkTarget } from "./permalinks";

export interface NavigateResult {
  ok: boolean;
  roomId?: string;
  eventId?: string;
  /** For user permalinks the caller may open a profile / start a DM. */
  userId?: string;
}

/** Resolve a room address (id or #alias) to a joined roomId, joining if needed. */
export async function resolveRoom(
  session: MatrixSession,
  address: string,
  via: string[] = [],
): Promise<string | undefined> {
  // Already a room id we know about?
  if (address.startsWith("!") && session.getRoom(address)) return address;
  try {
    const room = await session.client.joinRoomByIdOrAlias(address, via);
    return room.id();
  } catch {
    // If it's an id we simply don't have yet, still hand it back so the caller
    // can attempt to open it (the room-list may catch up).
    return address.startsWith("!") ? address : undefined;
  }
}

/** Open a parsed permalink target. Joins the room by alias/id when necessary. */
export async function navigateToTarget(
  app: AppState,
  session: MatrixSession,
  target: PermalinkTarget,
): Promise<NavigateResult> {
  if (target.kind === "user") {
    return { ok: true, userId: target.id };
  }
  const roomId = await resolveRoom(session, target.id, target.via);
  if (!roomId) return { ok: false };
  app.selectRoom(roomId);
  // Ask the (soon-to-mount) timeline to scroll to the event, if the link
  // targeted one. RoomPane retries until the event is loaded.
  if (target.eventId) {
    window.dispatchEvent(
      new CustomEvent("discourse:jump-to-event", {
        detail: { roomId, eventId: target.eventId },
      }),
    );
  }
  return { ok: true, roomId, eventId: target.eventId };
}

/** Parse + open a raw matrix.to / matrix: link (e.g. pasted or clicked). */
export async function navigateToPermalink(
  app: AppState,
  session: MatrixSession,
  rawUrl: string,
): Promise<NavigateResult> {
  const target = parsePermalink(rawUrl);
  if (!target) return { ok: false };
  return navigateToTarget(app, session, target);
}
