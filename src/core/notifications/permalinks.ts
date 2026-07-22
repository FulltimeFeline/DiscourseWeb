// Parses matrix.to / matrix: URIs into a room (+ optional event) target we can
// route with app.selectRoom: parse the entity, resolve the room, jump to the
// event if present.
//
// The SDK's `parseMatrixEntityFrom` is not exposed in this WASM build, so this
// is a small hand-rolled parser covering the forms Discourse emits/consumes:
//   https://matrix.to/#/!roomid:server/$eventid?via=a&via=b
//   https://matrix.to/#/#alias:server
//   https://matrix.to/#/@user:server
//   matrix:r/alias:server        matrix:roomid/room:server/e/eventid
//   matrix:u/user:server

export interface PermalinkTarget {
  kind: "room" | "user";
  /** `!id:server`, `#alias:server`, or `@user:server`. */
  id: string;
  /** `$eventid` when the link points at a specific event. */
  eventId?: string;
  /** `via=` server hints (federation routing for joins). */
  via: string[];
}

/** Parse a matrix.to or matrix: permalink. Returns undefined if not one. */
export function parsePermalink(raw: string): PermalinkTarget | undefined {
  const input = raw.trim();
  try {
    if (input.startsWith("matrix:")) return parseMatrixUri(input);
    const url = new URL(input);
    if (url.hostname === "matrix.to") return parseMatrixTo(url);
  } catch {
    /* not a URL */
  }
  // Bare identifiers pasted directly.
  if (/^[!#][^:]+:.+/.test(input)) return { kind: "room", id: input, via: [] };
  if (/^@[^:]+:.+/.test(input)) return { kind: "user", id: input, via: [] };
  return undefined;
}

function parseMatrixTo(url: URL): PermalinkTarget | undefined {
  // Everything after `#/`. The fragment holds the entity + optional /event.
  const frag = url.hash.replace(/^#\/?/, "");
  if (!frag) return undefined;
  const [pathPart, queryPart] = frag.split("?");
  const segments = pathPart.split("/").map((s) => safeDecode(s)).filter(Boolean);
  if (segments.length === 0) return undefined;
  const first = segments[0];
  const via = parseVia(queryPart);
  if (first.startsWith("@")) return { kind: "user", id: first, via };
  if (first.startsWith("!") || first.startsWith("#")) {
    const eventId = segments[1]?.startsWith("$") ? segments[1] : undefined;
    return { kind: "room", id: first, eventId, via };
  }
  return undefined;
}

function parseMatrixUri(uri: string): PermalinkTarget | undefined {
  // matrix:<type>/<id>[/<type2>/<id2>][?via=...] with sigil-less ids per MSC2312.
  const withoutScheme = uri.slice("matrix:".length);
  const [pathPart, queryPart] = withoutScheme.split("?");
  const parts = pathPart.split("/");
  if (parts.length < 2) return undefined;
  const via = parseVia(queryPart);
  const [type, id] = parts;
  const decodedId = safeDecode(id);
  let target: PermalinkTarget | undefined;
  if (type === "u" || type === "user") {
    target = { kind: "user", id: `@${decodedId}`, via };
  } else if (type === "r" || type === "room") {
    target = { kind: "room", id: `#${decodedId}`, via };
  } else if (type === "roomid") {
    target = { kind: "room", id: `!${decodedId}`, via };
  }
  if (target && target.kind === "room" && parts.length >= 4) {
    const [subType, subId] = [parts[2], safeDecode(parts[3])];
    if (subType === "e" || subType === "event") target.eventId = `$${subId}`;
  }
  return target;
}

function parseVia(query: string | undefined): string[] {
  if (!query) return [];
  const params = new URLSearchParams(query);
  return params.getAll("via");
}

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/** Build a matrix.to permalink for a room (+ optional event), for the composer. */
export function roomPermalink(roomId: string, eventId?: string, via: string[] = []): string {
  const base = `https://matrix.to/#/${encodeURIComponent(roomId)}`;
  const evt = eventId ? `/${encodeURIComponent(eventId)}` : "";
  const query = via.length ? `?${via.map((v) => `via=${encodeURIComponent(v)}`).join("&")}` : "";
  return base + evt + query;
}

/** Build a matrix.to permalink for a user (composer mentions). */
export function userPermalink(userId: string): string {
  return `https://matrix.to/#/${encodeURIComponent(userId)}`;
}
