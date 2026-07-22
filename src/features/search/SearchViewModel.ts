// Backing logic for the global search view. Covers:
//   - User/directory search: client.searchUsers (typed FFI)
//   - Public room directory: REST POST /publicRooms (server-side directory)
//   - Cross-room message search: REST POST /search (server-side full-text)
// This SDK build has no typed `searchMessages`, so we call the client-server
// /search endpoint directly (same escape hatch used for /publicRooms).
// Server-side search only covers unencrypted rooms, since the homeserver can't
// index E2EE content.

import type { MatrixSession } from "@/core/MatrixSession";
import type { UserProfile } from "@/matrix";

export interface DirectoryRoom {
  roomId: string;
  name?: string;
  alias?: string;
  topic?: string;
  avatarUrl?: string;
  numMembers: number;
  worldReadable: boolean;
}

export interface DirectoryPage {
  rooms: DirectoryRoom[];
  nextBatch?: string;
}

/** Debounced-caller-owned user search (same call the compose flow uses). */
export async function searchUsers(
  session: MatrixSession,
  term: string,
  limit = 20,
): Promise<UserProfile[]> {
  const q = term.trim();
  if (!q) return [];
  let hits: UserProfile[] = [];
  try {
    hits = (await session.client.searchUsers(q, BigInt(limit))).results;
  } catch {
    hits = [];
  }
  if (/^@[^:]+:.+/.test(q) && !hits.some((h) => h.userId === q)) {
    hits = [{ userId: q, displayName: undefined, avatarUrl: undefined }, ...hits];
  }
  return hits;
}

/**
 * Public room directory search via REST `POST /_matrix/client/v3/publicRooms`.
 * The FFI has no typed public-directory API in this build, so we call the
 * client-server endpoint directly (same escape hatch MatrixSession uses for
 * profiles). `server` lets the user browse another homeserver's directory.
 */
export async function searchPublicRooms(
  session: MatrixSession,
  term: string,
  opts: { server?: string; since?: string; limit?: number } = {},
): Promise<DirectoryPage> {
  const base = await session.apiBase();
  if (!base) return { rooms: [] };
  const token = session.session()?.accessToken;
  const url = new URL(`${base.replace(/\/$/, "")}/_matrix/client/v3/publicRooms`);
  if (opts.server) url.searchParams.set("server", opts.server);
  const body: Record<string, unknown> = { limit: opts.limit ?? 30 };
  if (term.trim()) body.filter = { generic_search_term: term.trim() };
  if (opts.since) body.since = opts.since;
  try {
    const res = await fetch(url.toString(), {
      method: "POST",
      headers: {
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) return { rooms: [] };
    const json = await res.json();
    const chunk: any[] = Array.isArray(json.chunk) ? json.chunk : [];
    return {
      nextBatch: json.next_batch,
      rooms: chunk.map((r) => ({
        roomId: r.room_id,
        name: r.name,
        alias: r.canonical_alias,
        topic: r.topic,
        avatarUrl: r.avatar_url,
        numMembers: r.num_joined_members ?? 0,
        worldReadable: !!r.world_readable,
      })),
    };
  } catch {
    return { rooms: [] };
  }
}

export interface MessageHit {
  eventId: string;
  roomId: string;
  sender: string;
  body: string;
  ts: number;
  msgtype?: string;
}

export interface MessageSearchPage {
  hits: MessageHit[];
  nextBatch?: string;
  count: number;
}

/**
 * Cross-room server-side full-text message search via REST
 * `POST /_matrix/client/v3/search`. Pages via the returned `next_batch`.
 * Covers unencrypted rooms only (the server can't index E2EE content).
 */
export async function searchMessages(
  session: MatrixSession,
  term: string,
  opts: { nextBatch?: string } = {},
): Promise<MessageSearchPage> {
  const base = await session.apiBase();
  const q = term.trim();
  if (!base || !q) return { hits: [], count: 0 };
  const token = session.session()?.accessToken;
  const url = new URL(`${base.replace(/\/$/, "")}/_matrix/client/v3/search`);
  if (opts.nextBatch) url.searchParams.set("next_batch", opts.nextBatch);
  const body = {
    search_categories: {
      room_events: {
        search_term: q,
        order_by: "recent",
        event_context: { before_limit: 0, after_limit: 0, include_profile: true },
        filter: { limit: 40 },
      },
    },
  };
  try {
    const res = await fetch(url.toString(), {
      method: "POST",
      headers: {
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) return { hits: [], count: 0 };
    const json = await res.json();
    const cat = json?.search_categories?.room_events ?? {};
    const results: any[] = Array.isArray(cat.results) ? cat.results : [];
    const hits: MessageHit[] = results
      .map((r) => {
        const e = r?.result ?? {};
        const c = e.content ?? {};
        return {
          eventId: e.event_id as string,
          roomId: e.room_id as string,
          sender: e.sender as string,
          body: typeof c.body === "string" ? c.body : "",
          ts: typeof e.origin_server_ts === "number" ? e.origin_server_ts : 0,
          msgtype: typeof c.msgtype === "string" ? c.msgtype : undefined,
        };
      })
      .filter((h) => h.eventId && h.roomId);
    return { hits, nextBatch: cat.next_batch, count: typeof cat.count === "number" ? cat.count : hits.length };
  } catch {
    return { hits: [], count: 0 };
  }
}
