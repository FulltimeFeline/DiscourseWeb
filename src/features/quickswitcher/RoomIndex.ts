// A lightweight, self-contained reader over `roomListService` that maintains a
// reactive list of the minimal room fields the quick switcher and search need
// (id, name, alias, avatar, isSpace, membership). Maps the FFI diff stream once
// into plain objects and re-filters in memory, so there's no SDK call per
// keystroke.
//
// Deliberately independent of the room-list feature's own store so the app-shell
// features can ship without coupling to it. If that store later exposes a
// `RoomSummary[]`, a `RoomEntry[]` adapter over it can replace this class
// wholesale: consumers only depend on the `RoomEntry` shape and `Store`.

import {
  Membership,
  type RoomInterface,
  type RoomListEntriesUpdate,
  type RoomListServiceInterface,
  RoomListEntriesDynamicFilterKind,
  type TaskHandleInterface,
} from "@/matrix";
import { Store } from "@/core/reactive";
import { disposeHandle } from "@/core/listeners";

/** Anything that can hand us a RoomListService once sync has started. */
export interface RoomListSource {
  roomListService?: RoomListServiceInterface;
}

export interface RoomEntry {
  id: string;
  name: string;
  /** Accent-folded, lower-cased name for fast diacritic-insensitive matching. */
  folded: string;
  canonicalAlias?: string;
  avatarUrl?: string;
  topic?: string;
  isSpace: boolean;
  isDirect: boolean;
  membership: "joined" | "invited" | "left" | "knocked" | "banned";
}

/** Diacritic-insensitive, lower-cased fold. */
export function foldForSearch(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .trim();
}

function membershipOf(room: RoomInterface): RoomEntry["membership"] {
  try {
    switch (room.membership()) {
      case Membership.Invited:
        return "invited";
      case Membership.Joined:
        return "joined";
      case Membership.Left:
        return "left";
      case Membership.Knocked:
        return "knocked";
      case Membership.Banned:
        return "banned";
      default:
        return "joined";
    }
  } catch {
    return "joined";
  }
}

function toEntry(room: RoomInterface): RoomEntry {
  let name = "";
  let alias: string | undefined;
  let avatarUrl: string | undefined;
  let topic: string | undefined;
  let isSpace = false;
  const id = room.id();
  try {
    name = room.displayName() ?? "";
  } catch {
    /* name unavailable */
  }
  try {
    alias = room.canonicalAlias() ?? undefined;
  } catch {
    /* no alias */
  }
  try {
    avatarUrl = room.avatarUrl() ?? undefined;
  } catch {
    /* no avatar */
  }
  try {
    topic = room.topic() ?? undefined;
  } catch {
    /* no topic */
  }
  try {
    isSpace = room.isSpace();
  } catch {
    /* not a space */
  }
  // `Room.isDirect()` is async in this build; the DM flag isn't needed for
  // switching, so a DM-less entry (no `!alias`, has heroes) is treated as a
  // room here. A DM badge can be resolved lazily by the consumer if wanted.
  const isDirect = !isSpace && !alias && !name.startsWith("#");
  const label = name || alias || id;
  return {
    id,
    name: label,
    folded: foldForSearch(label),
    canonicalAlias: alias,
    avatarUrl,
    topic,
    isSpace,
    isDirect,
    membership: membershipOf(room),
  };
}

/**
 * Maintains `rooms` from the room-list diff stream. Retain the instance and call
 * `dispose()` on teardown. The entries-stream TaskHandle must stay alive, else
 * the subscription silently detaches.
 */
export class RoomIndex {
  /** The full ordered room list, remapped from the SDK diff algebra. */
  readonly rooms = new Store<RoomEntry[]>([]);

  private items: RoomEntry[] = [];
  private streamHandle?: TaskHandleInterface;
  private started = false;
  private disposed = false;

  // Accepts either a RoomListService directly or a source that exposes one once
  // sync has started (MainShell mounts before startSync sets it).
  constructor(private readonly source: RoomListSource | RoomListServiceInterface) {}

  private service(): RoomListServiceInterface | undefined {
    const src = this.source as RoomListSource;
    if (typeof (src as { allRooms?: unknown }).allRooms === "function") {
      return this.source as RoomListServiceInterface;
    }
    return src.roomListService;
  }

  async start(pageSize = 500): Promise<void> {
    if (this.started || this.disposed) return;
    // The service may not be ready yet (sync starts after the shell mounts);
    // poll briefly until it appears.
    let svc = this.service();
    for (let i = 0; i < 50 && !svc && !this.disposed; i++) {
      await new Promise((r) => setTimeout(r, 100));
      svc = this.service();
    }
    if (!svc || this.disposed) return;
    this.started = true;
    let roomList;
    try {
      roomList = await svc.allRooms();
    } catch {
      this.started = false;
      return;
    }
    if (this.disposed) return;
    const result = roomList.entriesWithDynamicAdapters(pageSize, {
      onUpdate: (updates: RoomListEntriesUpdate[]) => this.apply(updates),
    });
    // Include every non-left room (spaces are filtered out at query time so
    // deep-links to a space still resolve). Deduplicate tombstoned versions.
    try {
      result
        .controller()
        .setFilter(
          new RoomListEntriesDynamicFilterKind.All({
            filters: [
              new RoomListEntriesDynamicFilterKind.NonLeft(),
              new RoomListEntriesDynamicFilterKind.DeduplicateVersions(),
            ],
          }),
        );
    } catch {
      /* filtering is best-effort; unfiltered is still usable */
    }
    // Retain the handle; dropping it cancels the stream.
    this.streamHandle = result.entriesStream();
  }

  private commit(): void {
    this.rooms.set([...this.items]);
  }

  private apply(updates: RoomListEntriesUpdate[]): void {
    for (const u of updates) {
      const tag = (u as { tag: string }).tag;
      const inner = (u as { inner?: any }).inner;
      switch (tag) {
        case "Append":
          for (const r of inner.values as RoomInterface[]) this.items.push(toEntry(r));
          break;
        case "Clear":
          this.items = [];
          break;
        case "PushFront":
          this.items.unshift(toEntry(inner.value));
          break;
        case "PushBack":
          this.items.push(toEntry(inner.value));
          break;
        case "PopFront":
          this.items.shift();
          break;
        case "PopBack":
          this.items.pop();
          break;
        case "Insert":
          this.items.splice(Number(inner.index), 0, toEntry(inner.value));
          break;
        case "Set":
          this.items[Number(inner.index)] = toEntry(inner.value);
          break;
        case "Remove":
          this.items.splice(Number(inner.index), 1);
          break;
        case "Truncate":
          this.items.length = Number(inner.length);
          break;
        case "Reset":
          this.items = (inner.values as RoomInterface[]).map(toEntry);
          break;
        default:
          break;
      }
    }
    this.commit();
  }

  dispose(): void {
    this.disposed = true;
    disposeHandle(this.streamHandle);
    this.streamHandle = undefined;
    this.started = false;
  }
}

/**
 * A fuzzy query over room entries, ranked prefix > word-boundary > contains
 * (prefix matches outrank contains). Excludes spaces and, by default, invites,
 * same as the quick switcher. Returns a new array sorted best-first.
 */
export function queryRooms(
  rooms: RoomEntry[],
  query: string,
  opts: { includeSpaces?: boolean; includeInvites?: boolean } = {},
): RoomEntry[] {
  const includeSpaces = opts.includeSpaces ?? false;
  const includeInvites = opts.includeInvites ?? false;
  const base = rooms.filter(
    (r) =>
      (includeSpaces || !r.isSpace) &&
      (includeInvites || r.membership !== "invited") &&
      r.membership !== "left" &&
      r.membership !== "banned",
  );
  const q = foldForSearch(query);
  if (!q) return base;
  const scored: { r: RoomEntry; score: number }[] = [];
  for (const r of base) {
    const score = scoreMatch(r.folded, q);
    if (score > 0) scored.push({ r, score });
  }
  scored.sort((a, b) => b.score - a.score || a.r.name.localeCompare(b.r.name));
  return scored.map((s) => s.r);
}

/** 0 = no match; higher = better. Prefix > word-start > subsequence > contains. */
function scoreMatch(haystack: string, needle: string): number {
  if (haystack === needle) return 1000;
  if (haystack.startsWith(needle)) return 800;
  // Word-boundary prefix ("nr" → "new room").
  const words = haystack.split(/[\s\-_./]+/);
  if (words.some((w) => w.startsWith(needle))) return 600;
  // Acronym: first letters of words spell the needle.
  const acronym = words.map((w) => w[0] ?? "").join("");
  if (acronym.startsWith(needle)) return 500;
  const idx = haystack.indexOf(needle);
  if (idx >= 0) return 400 - idx;
  // In-order subsequence fallback.
  if (isSubsequence(needle, haystack)) return 100;
  return 0;
}

function isSubsequence(needle: string, haystack: string): boolean {
  let i = 0;
  for (let j = 0; j < haystack.length && i < needle.length; j++) {
    if (haystack[j] === needle[i]) i++;
  }
  return i === needle.length;
}
