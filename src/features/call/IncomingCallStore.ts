// Incoming-call ring detection by polling room state.
//
// Detection is NOT a signaling event: we watch each room's RoomInfo.hasRoomCall
// (via Room.subscribeToRoomInfoUpdates) and compare against a per-room cache.
//   - Rising edge (false to true) on a DIRECT room we did NOT start locally: ring.
//     Group calls get a banner (RoomInfo.hasRoomCall on the RoomPane), not a ring.
//   - Falling edge (true to false): clear the ring if it was for this room.
// Only one ring at a time.
//
// The set of rooms to watch is fed in by the shell/room-list (setWatchedRooms),
// keeping this module free of a room-list dependency.

import { Store } from "@/core/reactive";
import { disposeHandle } from "@/core/listeners";
import type { MatrixSession } from "@/core/MatrixSession";
import type { RoomInfo, RoomInterface, TaskHandleInterface } from "@/matrix";
import { isLocallyActiveCall } from "./CallViewModel";

export interface RingingCall {
  roomId: string;
  roomName: string;
  avatarUrl?: string;
  isDirect: boolean;
}

interface WatchedRoom {
  room: RoomInterface;
  handle?: TaskHandleInterface;
  lastCallActive: boolean;
  isDirect: boolean;
}

export class IncomingCallStore {
  /** The single active ring, if any. */
  readonly ringing = new Store<RingingCall | undefined>(undefined);
  /** Rooms with an active group call, shown as a banner (roomId -> true). */
  readonly activeCalls = new Store<Record<string, boolean>>({});

  private watched = new Map<string, WatchedRoom>();

  constructor(private readonly session: MatrixSession) {}

  /** Reconcile the watched-room set (add new, drop removed). */
  setWatchedRooms(roomIds: string[]): void {
    const next = new Set(roomIds);
    // Drop rooms no longer present.
    for (const [id, w] of this.watched) {
      if (!next.has(id)) {
        disposeHandle(w.handle);
        this.watched.delete(id);
      }
    }
    // Add newly-present rooms.
    for (const id of next) {
      if (this.watched.has(id)) continue;
      const room = this.session.getRoom(id);
      if (!room) continue;
      void this.watch(room);
    }
  }

  private async watch(room: RoomInterface): Promise<void> {
    const id = room.id();
    let isDirect = false;
    try {
      isDirect = await room.isDirect();
    } catch {
      /* default false */
    }
    const entry: WatchedRoom = { room, lastCallActive: false, isDirect };
    this.watched.set(id, entry);
    try {
      entry.handle = room.subscribeToRoomInfoUpdates({
        call: (info: RoomInfo) => this.onRoomInfo(id, info),
      });
    } catch {
      /* subscription unavailable */
    }
  }

  private onRoomInfo(roomId: string, info: RoomInfo): void {
    const entry = this.watched.get(roomId);
    if (!entry) return;
    const active = info.hasRoomCall;
    const prev = entry.lastCallActive;
    entry.lastCallActive = active;

    // Maintain the group-call banner set.
    this.activeCalls.update((m) => {
      if (active === !!m[roomId]) return m;
      const nextMap = { ...m };
      if (active) nextMap[roomId] = true;
      else delete nextMap[roomId];
      return nextMap;
    });

    if (active && !prev) {
      // Rising edge: ring only for a direct room we didn't start ourselves.
      if (entry.isDirect && !isLocallyActiveCall(roomId) && !this.ringing.value) {
        this.ring(roomId, info);
      }
    } else if (!active && prev) {
      // Falling edge: clear the ring if it was for this room.
      if (this.ringing.value?.roomId === roomId) this.ringing.set(undefined);
    }
  }

  private ring(roomId: string, info: RoomInfo): void {
    this.ringing.set({
      roomId,
      roomName: info.displayName ?? info.rawName ?? "Incoming call",
      avatarUrl: info.avatarUrl ?? undefined,
      isDirect: info.isDirect,
    });
  }

  /** Called by the ring UI on accept/decline/timeout. */
  clearRing(roomId?: string): void {
    if (!roomId || this.ringing.value?.roomId === roomId) this.ringing.set(undefined);
  }

  dispose(): void {
    for (const w of this.watched.values()) disposeHandle(w.handle);
    this.watched.clear();
  }
}

// --- module-level cache -------------------------------------------------------

const stores = new Map<string, IncomingCallStore>();

export function incomingCallStoreFor(session: MatrixSession): IncomingCallStore {
  let s = stores.get(session.userId);
  if (!s) {
    s = new IncomingCallStore(session);
    stores.set(session.userId, s);
  }
  return s;
}

export function disposeIncomingCallStore(session: MatrixSession): void {
  const s = stores.get(session.userId);
  if (s) {
    s.dispose();
    stores.delete(session.userId);
  }
}
