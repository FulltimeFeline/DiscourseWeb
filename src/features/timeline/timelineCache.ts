// A small per-session LRU of live-room TimelineViewModels, so re-opening a
// recently-visited room is instant: its FFI timeline and already-mapped entries
// are retained instead of rebuilt from cold (which meant a fresh
// `timelineWithConfiguration`, back-pagination, and re-mapping ~50 items across
// the wasm boundary every time — the "chat takes forever to load" feeling).
//
// Lifecycle:
//  - acquire(): return the cached VM (unparked) or create+start a new one; mark
//    it the active room and evict the oldest beyond MAX_CACHED.
//  - release(): park the VM (detach its diff listener, stop the ephemeral /sync
//    loop, shed all but a tail of entries) but keep it in the cache for reuse.
//  - eviction / session teardown: dispose fully.
//
// The active room is never parked or evicted while it's on screen.

import { TimelineViewModel } from "./TimelineViewModel";
import type { RoomInterface } from "@/matrix";
import type { MatrixSession } from "@/core/MatrixSession";

// How many rooms' timelines to keep warm. Each parked VM holds a tail of entries
// and its FFI timeline; a handful covers realistic room-hopping without letting
// memory grow unbounded.
const MAX_CACHED = 6;

interface SessionCache {
  // Insertion order is the LRU order (front = least-recently used). A room is
  // re-inserted on acquire so it becomes most-recently used.
  lru: Map<string, TimelineViewModel>;
  activeRoomId?: string;
}

// Keyed by session identity (userId), matching the other per-session stores.
const caches = new Map<string, SessionCache>();

function cacheFor(session: MatrixSession): SessionCache {
  let c = caches.get(session.userId);
  if (!c) {
    c = { lru: new Map() };
    caches.set(session.userId, c);
  }
  return c;
}

/**
 * Get the timeline view model for a room, creating and starting it on first
 * open or reviving a cached (parked) one. The returned VM is the caller's to
 * render; call `releaseTimeline` when the room view unmounts. Never dispose the
 * returned VM directly — the cache owns its lifetime.
 */
export function acquireTimeline(
  session: MatrixSession,
  room: RoomInterface,
  roomId: string,
): TimelineViewModel {
  const c = cacheFor(session);
  let vm = c.lru.get(roomId);
  if (vm && vm.isDisposed) {
    // Was evicted+disposed since; drop the stale entry and rebuild.
    c.lru.delete(roomId);
    vm = undefined;
  }
  if (vm) {
    // Reuse: move to most-recently-used and revive. unpark re-attaches the diff
    // listener, whose replayed reset refreshes the (instantly-shown) cached
    // entries; a no-op if it was never parked.
    c.lru.delete(roomId);
    c.lru.set(roomId, vm);
    void vm.unpark();
  } else {
    vm = new TimelineViewModel(session, room, roomId, { type: "live" });
    c.lru.set(roomId, vm);
    void vm.start();
  }
  c.activeRoomId = roomId;
  evict(c, roomId);
  return vm;
}

/**
 * Signal that a room view has unmounted. The VM is parked (background work
 * stops, memory sheds) but kept cached so returning to the room is instant.
 */
export function releaseTimeline(session: MatrixSession, roomId: string): void {
  const c = caches.get(session.userId);
  if (!c) return;
  c.lru.get(roomId)?.park();
  if (c.activeRoomId === roomId) c.activeRoomId = undefined;
}

/** Evict least-recently-used VMs beyond the cap, never the active/kept room. */
function evict(c: SessionCache, keepRoomId: string): void {
  if (c.lru.size <= MAX_CACHED) return;
  for (const [id, vm] of c.lru) {
    if (c.lru.size <= MAX_CACHED) break;
    if (id === keepRoomId || id === c.activeRoomId) continue;
    c.lru.delete(id);
    vm.dispose();
  }
}

/** Warm a room's sliding-sync subscription (e.g. on sidebar hover). */
export function prefetchTimeline(session: MatrixSession, roomId: string): void {
  try {
    void session.roomListService?.subscribeToRooms([roomId]);
  } catch {
    /* best effort */
  }
}

/** Dispose every cached timeline for a session (on logout / account removal). */
export function disposeTimelineCache(session: MatrixSession): void {
  const c = caches.get(session.userId);
  if (!c) return;
  for (const vm of c.lru.values()) {
    try {
      vm.dispose();
    } catch {
      /* best effort */
    }
  }
  c.lru.clear();
  caches.delete(session.userId);
}
