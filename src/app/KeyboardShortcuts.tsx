// Global keyboard shortcuts plus the app-shell overlays they drive. Mount ONCE
// in the signed-in shell. Owns a shared RoomIndex (fed to the quick switcher and
// available to search), registers the hotkeys, and renders the quick switcher,
// compose, and search overlays.
//
// Shortcut set (⌘ on macOS, Ctrl elsewhere):
//   ⌘K            Quick switcher (Jump to Room)
//   ⌘N            New Message (DM)
//   ⇧⌘N           New Room
//   ⇧⌘J           Join Room
//   ⌘F            Global search        (in-timeline ⌘F is in-room search, owned by the timeline feature)
//   ⌥⌘↓ / ⌥⌘↑     Next / Previous room
//   Esc           Close the top overlay
// (New Space is reachable from the compose modal's tabs.)

import { useEffect, useMemo, useState } from "react";
import { useViewModel } from "@/core/reactive";
import type { AppState } from "./AppState";
import { useSession } from "./context";
import { RoomIndex, queryRooms, type RoomEntry } from "@/features/quickswitcher/RoomIndex";
import { useRoomListScope, type RoomListScope } from "@/features/roomlist/scope";
import { hasAnyUnread } from "@/features/roomlist/RoomListViewModel";
import type { RoomSummary } from "@/models/types";
import { QuickSwitcher } from "@/features/quickswitcher/QuickSwitcher";
import { NewChat } from "@/features/compose/NewChat";
import { SearchView } from "@/features/search/SearchView";
import { parsePermalink } from "@/core/notifications/permalinks";
import { navigateToPermalink } from "@/core/notifications/navigate";

type ComposeMode = "dm" | "room" | "space" | "join";

const isMac =
  typeof navigator !== "undefined" && /mac/i.test(navigator.platform || navigator.userAgent);

/** The platform "command" modifier: ⌘ on macOS, Ctrl elsewhere. */
function hasCmd(e: KeyboardEvent): boolean {
  return isMac ? e.metaKey : e.ctrlKey;
}

/** True when focus is in a text field (so we don't hijack typing). */
function inTextEntry(): boolean {
  const el = document.activeElement as HTMLElement | null;
  if (!el) return false;
  const tag = el.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || el.isContentEditable;
}

export function KeyboardShortcuts({ app }: { app: AppState }) {
  const session = useSession();
  const s = useViewModel(app);
  const scope = useRoomListScope(app, session);

  // The shared, self-contained room index (feeds the quick switcher). The
  // session doubles as a RoomListSource: sync sets `roomListService` shortly
  // after the shell mounts, and RoomIndex polls for it.
  const index = useMemo(() => new RoomIndex(session), [session]);
  useEffect(() => {
    void index.start();
    return () => index.dispose();
  }, [index]);

  const [compose, setCompose] = useState<ComposeMode | null>(null);
  const [searchOpen, setSearchOpen] = useState(false);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      // Esc closes the topmost overlay (overlays also handle their own Esc; this
      // covers the quick switcher which is app-state driven).
      if (e.key === "Escape") {
        if (app.state.isQuickSwitcherOpen) {
          app.setQuickSwitcherOpen(false);
          e.preventDefault();
        }
        return;
      }

      if (!hasCmd(e)) return;
      const key = e.key.toLowerCase();

      // ⌘K: quick switcher
      if (key === "k" && !e.shiftKey && !e.altKey) {
        e.preventDefault();
        app.setQuickSwitcherOpen(!app.state.isQuickSwitcherOpen);
        return;
      }
      // ⌘N / ⇧⌘N: new message / new room
      if (key === "n" && !e.altKey) {
        e.preventDefault();
        setCompose(e.shiftKey ? "room" : "dm");
        return;
      }
      // ⇧⌘J: join room
      if (key === "j" && e.shiftKey && !e.altKey) {
        e.preventDefault();
        setCompose("join");
        return;
      }
      // ⌘F: global search (only when not typing; ⌘F inside the timeline is the
      // timeline feature's in-room search).
      if (key === "f" && !e.shiftKey && !e.altKey && !inTextEntry()) {
        e.preventDefault();
        setSearchOpen(true);
        return;
      }
      // ⌥⌘↓ / ⌥⌘↑: next / previous room
      if (e.altKey && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
        e.preventDefault();
        stepRoom(app, scope, index.rooms.value, e.key === "ArrowDown" ? 1 : -1);
        return;
      }
      // ⌥⌘I: toggle the room details panel (RoomPane listens).
      if (e.altKey && key === "i") {
        e.preventDefault();
        window.dispatchEvent(new CustomEvent("discourse:toggle-details"));
        return;
      }
      // ⇧⌘] / ⇧⌘[: next / previous UNREAD room
      if (e.shiftKey && (e.key === "]" || e.key === "[")) {
        e.preventDefault();
        stepUnread(app, scope, scope.roomList.state.rooms, e.key === "]" ? 1 : -1);
        return;
      }
      // ⇧⌘F: filter rooms (focus the sidebar search field)
      if (e.shiftKey && key === "f") {
        e.preventDefault();
        window.dispatchEvent(new CustomEvent("discourse:focus-search"));
        return;
      }
      // ⌥⌘0 is Home, ⌥⌘1…⌥⌘9 is the nth space. (Plain ⌘1-9 is reserved by Safari
      // for tab-switching and can't be overridden, so we require Alt too.)
      if (e.altKey && !e.shiftKey && /^[0-9]$/.test(e.key)) {
        e.preventDefault();
        if (e.key === "0") {
          app.selectSpace(null);
        } else {
          const spaces = scope.spaces.state.orderedSpaces;
          const target = spaces[Number(e.key) - 1];
          if (target) app.selectSpace(target.id);
        }
        return;
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [app, index, scope]);

  // Handle a deep link present in the URL at load (e.g. /?to=<matrix.to link>)
  // or a hash permalink. Best-effort; safe to no-op when absent.
  useEffect(() => {
    const url = new URL(window.location.href);
    const link = url.searchParams.get("to") ?? decodeHashPermalink(url.hash);
    if (link && parsePermalink(link)) {
      void navigateToPermalink(app, session, link);
    }
  }, [app, session]);

  // Intercept clicks on matrix.to / matrix: permalinks anywhere in the app
  // (message bodies, topics, bios) and navigate in-app (open the room and jump
  // to the event) instead of opening a browser tab. Modifier-clicks
  // (open-in-new-tab) and non-permalink links pass through untouched.
  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      const anchor = (e.target as HTMLElement | null)?.closest?.("a");
      const href = anchor?.getAttribute("href");
      if (!href || !parsePermalink(href)) return;
      e.preventDefault();
      void navigateToPermalink(app, session, href);
    };
    document.addEventListener("click", onClick);
    return () => document.removeEventListener("click", onClick);
  }, [app, session]);

  return (
    <>
      {s.isQuickSwitcherOpen && <QuickSwitcher index={index} />}
      {compose && <NewChat initialMode={compose} onClose={() => setCompose(null)} />}
      {searchOpen && <SearchView onClose={() => setSearchOpen(false)} />}
    </>
  );
}

/** Whether a room is shown in the currently-selected space's column (so keyboard
 *  nav stays within the visible list). */
function belongsToView(
  app: AppState,
  scope: RoomListScope,
  r: { id: string; isDirect: boolean },
): boolean {
  const vis = scope.spaces.visibleRoomIds(app.state.selectedSpaceId);
  if (vis != null) return vis.has(r.id);
  // Home: DMs + rooms not filed under any space.
  return r.isDirect || !scope.spaces.state.allSpaceChildIds.has(r.id);
}

/** Move selection to the next/previous UNREAD room in the current space (wraps). */
function stepUnread(app: AppState, scope: RoomListScope, rooms: RoomSummary[], delta: number): void {
  const unread = rooms.filter((r) => !r.isSpace && hasAnyUnread(r) && belongsToView(app, scope, r));
  if (unread.length === 0) return;
  const cur = app.state.selectedRoomId;
  const idx = unread.findIndex((r) => r.id === cur);
  const next =
    idx === -1 ? (delta > 0 ? 0 : unread.length - 1) : (idx + delta + unread.length) % unread.length;
  app.selectRoom(unread[next].id);
}

/** Move selection to the next/previous room in the current space's list. */
function stepRoom(app: AppState, scope: RoomListScope, rooms: RoomEntry[], delta: number): void {
  const list = queryRooms(rooms, "").filter((r) => belongsToView(app, scope, r));
  if (list.length === 0) return;
  const current = app.state.selectedRoomId;
  const idx = list.findIndex((r) => r.id === current);
  const next = idx === -1 ? (delta > 0 ? 0 : list.length - 1) : (idx + delta + list.length) % list.length;
  app.selectRoom(list[next].id);
}

function decodeHashPermalink(hash: string): string | undefined {
  // A full-page matrix.to style hash: #/!room:server/$event
  if (hash.startsWith("#/")) return `https://matrix.to/${hash}`;
  return undefined;
}
