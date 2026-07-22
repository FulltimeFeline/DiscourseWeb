// A lightweight per-(session, room) cache of member display names and avatar
// URLs, so callers that only have a user id (e.g. read-receipt discs) can
// resolve a real profile picture without threading member data through props.
//
// Members are loaded once per session+room by draining the same
// `Room.members()` iterator used by MembersViewModel. In sliding-sync the roster
// can be empty until the room's timeline fetches members, so we fall back to
// `Timeline.fetchMembers()` and drain again. Concurrent callers share one load.

import { useEffect, useState } from "react";
import {
  MembershipState_Tags,
  type RoomInterface,
} from "@/matrix";
import type { MatrixSession } from "@/core/MatrixSession";

export interface MemberProfile {
  displayName?: string;
  avatarUrl?: string;
}

const CHUNK = 100;

interface CacheEntry {
  // Resolves once the roster has been loaded (or failed).
  promise: Promise<void>;
  profiles: Map<string, MemberProfile>;
  // Bumped when the map is (re)populated, so hooks can re-read.
  version: number;
  listeners: Set<() => void>;
}

// Module-level cache keyed by session identity + room id.
const cache = new WeakMap<MatrixSession, Map<string, CacheEntry>>();

function entryFor(session: MatrixSession, roomId: string): CacheEntry {
  let byRoom = cache.get(session);
  if (!byRoom) {
    byRoom = new Map();
    cache.set(session, byRoom);
  }
  let entry = byRoom.get(roomId);
  if (!entry) {
    entry = {
      profiles: new Map(),
      version: 0,
      listeners: new Set(),
      promise: Promise.resolve(),
    };
    entry.promise = loadInto(session, roomId, entry);
    byRoom.set(roomId, entry);
  }
  return entry;
}

async function drainInto(room: RoomInterface, out: Map<string, MemberProfile>): Promise<number> {
  const iterator = await room.members();
  let count = 0;
  for (;;) {
    const chunk = iterator.nextChunk(CHUNK);
    if (!chunk || chunk.length === 0) break;
    for (const m of chunk) {
      if (m.membership.tag !== MembershipState_Tags.Join) continue;
      out.set(m.userId, {
        displayName: m.displayName?.trim() || undefined,
        avatarUrl: m.avatarUrl ?? undefined,
      });
      count++;
    }
  }
  return count;
}

async function loadInto(
  session: MatrixSession,
  roomId: string,
  entry: CacheEntry,
): Promise<void> {
  const room = session.getRoom(roomId) as RoomInterface | undefined;
  if (!room) {
    console.warn(`[memberProfiles] no room for ${roomId}`);
    return;
  }
  try {
    let count = await drainInto(room, entry.profiles);
    // Sliding-sync may return an empty roster until members are fetched.
    if (count === 0) {
      try {
        const timeline = await room.timeline();
        await timeline.fetchMembers();
        count = await drainInto(room, entry.profiles);
      } catch (err) {
        console.warn(`[memberProfiles] fetchMembers failed for ${roomId}`, err);
      }
    }
    entry.version++;
    for (const l of entry.listeners) l();
  } catch (err) {
    console.warn(`[memberProfiles] load failed for ${roomId}`, err);
  }
}

/**
 * React hook: resolve a member's cached profile for a room. Returns `undefined`
 * until the roster has loaded, then the member's `{ displayName?, avatarUrl? }`
 * (or `undefined` if the user isn't a joined member). Loads the roster once and
 * shares it across all callers for the same session+room.
 */
export function useMemberProfile(
  session: MatrixSession,
  roomId: string,
  userId: string,
): MemberProfile | undefined {
  const [, setVersion] = useState(0);

  useEffect(() => {
    const entry = entryFor(session, roomId);
    let alive = true;
    const notify = () => {
      if (alive) setVersion((v) => v + 1);
    };
    entry.listeners.add(notify);
    // If the load already finished before we subscribed, re-read now.
    if (entry.version > 0) notify();
    return () => {
      alive = false;
      entry.listeners.delete(notify);
    };
  }, [session, roomId]);

  const entry = entryFor(session, roomId);
  return entry.profiles.get(userId);
}
