// One RoomListViewModel + SpacesViewModel per account, shared by the sidebar and
// the rail so both columns read the same list. Keyed by userId and cached for
// the process lifetime of that warm session; disposal is left to the session
// owner (these are cheap and idempotent to re-`start()`).

import { useMemo } from "react";
import type { AppState } from "@/app/AppState";
import type { MatrixSession } from "@/core/MatrixSession";
import { RoomListViewModel } from "./RoomListViewModel";
import { SpacesViewModel } from "./SpacesViewModel";

export interface RoomListScope {
  roomList: RoomListViewModel;
  spaces: SpacesViewModel;
}

const scopes = new Map<string, RoomListScope>();

export function getRoomListScope(app: AppState, session: MatrixSession): RoomListScope {
  const existing = scopes.get(session.userId);
  if (existing) return existing;

  const roomList = new RoomListViewModel(session);
  const spaces = new SpacesViewModel(session);

  // Feed this account's unread total to the app badge aggregation.
  roomList.onUnreadTotalChange = (total) => {
    try {
      if ("setAppBadge" in navigator) {
        if (total > 0) void (navigator as Navigator & { setAppBadge(n: number): Promise<void> }).setAppBadge(total);
        else void (navigator as Navigator & { clearAppBadge(): Promise<void> }).clearAppBadge();
      }
    } catch {
      /* not installed / unsupported */
    }
  };

  const scope: RoomListScope = { roomList, spaces };
  scopes.set(session.userId, scope);
  void roomList.start();
  void spaces.start();
  return scope;
}

/** Dispose + forget the scope for an account (call on logout). */
export function disposeRoomListScope(userId: string): void {
  const scope = scopes.get(userId);
  if (!scope) return;
  scope.roomList.dispose();
  scope.spaces.dispose();
  scopes.delete(userId);
}

export function useRoomListScope(app: AppState, session: MatrixSession): RoomListScope {
  return useMemo(() => getRoomListScope(app, session), [app, session]);
}
