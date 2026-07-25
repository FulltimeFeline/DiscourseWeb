// The room-list column.
//
// Header (space/Home name + New menu), search (Home only), then the sections:
// invites, the activity-sorted rooms/DMs, and (in a space) the unjoined "More
// Rooms" directory. A single RoomListViewModel + SpacesViewModel per account are
// owned by the shell scope (see scope.ts) and shared with the rail.

import { useEffect, useMemo, useRef, useState } from "react";
import { Virtuoso } from "react-virtuoso";
import type { AppState } from "@/app/AppState";
import { useSession } from "@/app/context";
import { useViewModel } from "@/core/reactive";
import type { RoomSummary } from "@/models/types";
import { useRoomListScope } from "./scope";
import { hasAnyUnread } from "./RoomListViewModel";
import { modals } from "@/features/settings/ModalManager";
import { useMediaUrl } from "@/features/settings/useMediaUrl";
import { Icon } from "@/ui/Icon";
import { RoomRow } from "./RoomRow";
import { prefetchTimeline } from "@/features/timeline/timelineCache";
import { RoomMenu, type MenuAnchor, type MenuItem } from "./RoomMenu";
import { InviteRow } from "./InviteRow";
import { SpaceDirectoryRow } from "./SpaceDirectoryRow";
import { SpaceHomeView } from "./SpaceHomeView";
import "./roomlist.css";

interface RoomMenuState {
  anchor: MenuAnchor;
  room: RoomSummary;
}

const VIRTUALIZE_THRESHOLD = 30;

export function SidebarView({ app }: { app: AppState }) {
  const session = useSession();
  const appState = useViewModel(app);
  const scope = useRoomListScope(app, session);
  const roomList = useViewModel(scope.roomList);
  const spaces = useViewModel(scope.spaces);

  const selectedSpaceId = appState.selectedSpaceId;
  const selectedRoomId = appState.selectedRoomId;
  const [spaceHomeOpen, setSpaceHomeOpen] = useState(false);

  // ⇧⌘F focuses the room filter (dispatched by the shell).
  const searchRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const focus = () => searchRef.current?.focus();
    window.addEventListener("discourse:focus-search", focus);
    return () => window.removeEventListener("discourse:focus-search", focus);
  }, []);

  // Space banner (Commet state event), shown at the top of the list.
  const [bannerMxc, setBannerMxc] = useState<string | undefined>();
  useEffect(() => {
    if (selectedSpaceId == null) {
      setBannerMxc(undefined);
      return;
    }
    let alive = true;
    setBannerMxc(undefined);
    void scope.spaces.spaceBannerURL(selectedSpaceId).then((mxc) => {
      if (alive) setBannerMxc(mxc);
    });
    return () => {
      alive = false;
    };
  }, [scope, selectedSpaceId]);
  const bannerUrl = useMediaUrl(bannerMxc);

  // Keep the room-list model told which room is on screen (local unread clear).
  useEffect(() => {
    scope.roomList.setActiveRoom(selectedRoomId ?? undefined);
  }, [scope, selectedRoomId]);

  // Recompute rail flags whenever rooms or child sets change.
  useEffect(() => {
    scope.spaces.recomputeUnreadFlags(
      roomList.rooms.map((r) => ({
        id: r.id,
        hasAnyUnread: derivedHasAnyUnread(r),
        isMentioned: r.unreadMentions > 0,
        isDirect: r.isDirect,
        isSpace: r.isSpace,
      })),
    );
  }, [scope, roomList.rooms, spaces.allSpaceChildIds]);

  const query = roomList.debouncedQuery;
  const visibleRoomIds = useMemo(
    () => scope.spaces.visibleRoomIds(selectedSpaceId),
    [scope, selectedSpaceId, spaces.allSpaceChildIds],
  );

  // Rooms visible in the current column (space filter + search).
  const visibleRooms = useMemo(() => {
    return roomList.rooms.filter((r) => {
      if (r.isSpace || r.membership === "invited") return false;
      if (query && !r.foldedName.includes(query)) return false;
      if (visibleRoomIds != null) return visibleRoomIds.has(r.id);
      // Home: DMs always, plus rooms not filed in any space.
      return r.isDirect || !spaces.allSpaceChildIds.has(r.id);
    });
  }, [roomList.rooms, query, visibleRoomIds, spaces.allSpaceChildIds]);

  // Spaces matching the search (jump target).
  const matchingSpaces = useMemo(() => {
    if (!query) return [];
    return spaces.orderedSpaces.filter((s) => s.foldedName.includes(query));
  }, [query, spaces.orderedSpaces]);

  // Unjoined space-directory rooms ("More Rooms"), space-only.
  const moreRooms = useMemo(() => {
    if (selectedSpaceId == null) return [];
    return scope.spaces
      .childrenOf(selectedSpaceId)
      .filter((c) => !c.isSpace && !c.isJoined)
      .filter((c) => !query || c.foldedName.includes(query));
  }, [scope, selectedSpaceId, spaces.allSpaceChildIds, query]);

  const currentSpace =
    selectedSpaceId != null
      ? spaces.orderedSpaces.find((s) => s.id === selectedSpaceId)
      : undefined;
  const title = currentSpace?.name ?? "Home";

  const invites = roomList.invites;

  const selectRoom = (id: string) => app.selectRoom(id);

  // Header (space / Home) options menu. "Mark all as read" reads the visible
  // rooms through a ref at click time, so the memoized items array (and an open
  // menu) stays stable across the 100 ms room-list flushes.
  const [headerMenu, setHeaderMenu] = useState<MenuAnchor | null>(null);
  const visibleRoomsRef = useRef(visibleRooms);
  visibleRoomsRef.current = visibleRooms;
  const headerMenuItems = useMemo<MenuItem[]>(() => {
    const rl = scope.roomList;
    const items: MenuItem[] = [
      {
        key: "read-all",
        label: "Mark all as read",
        icon: "check",
        onSelect: () => void rl.markRead(visibleRoomsRef.current.map((r) => r.id)),
      },
    ];
    if (selectedSpaceId != null) {
      items.push(
        {
          key: "space-settings",
          label: "Space settings",
          icon: "gear",
          onSelect: () => modals.openRoomSettings(selectedSpaceId),
        },
        {
          key: "leave-space",
          label: "Leave space",
          icon: "trash",
          danger: true,
          confirm: "Leave this space?",
          onSelect: async () => {
            await scope.spaces.leaveSpace(selectedSpaceId);
            app.selectSpace(null);
          },
        },
      );
    }
    return items;
  }, [scope, selectedSpaceId, app]);

  // "+" new-conversation menu (space-aware).
  const [newMenu, setNewMenu] = useState<MenuAnchor | null>(null);
  const newMenuItems = useMemo<MenuItem[]>(() => {
    const items: MenuItem[] = [];
    if (selectedSpaceId == null) {
      items.push({
        key: "dm",
        label: "New Message",
        icon: "envelope",
        onSelect: () => window.dispatchEvent(new CustomEvent("discourse:new-chat")),
      });
    }
    items.push({
      key: "room",
      label: selectedSpaceId == null ? "New Room" : `New Room in ${currentSpace?.name ?? "Space"}`,
      icon: "hash",
      onSelect: () => window.dispatchEvent(new CustomEvent("discourse:new-room")),
    });
    return items;
  }, [selectedSpaceId, currentSpace]);

  // Right-click context menu for a room row.
  const [roomMenu, setRoomMenu] = useState<RoomMenuState | null>(null);
  // Fail-closed permission cache for the open room menu, primed on menu-open:
  // hide Invite / space-toggle items the user can't actually perform, rather
  // than offering silently-failing actions.
  const [roomPerms, setRoomPerms] = useState<{ invite: boolean; spaces: Set<string> }>({
    invite: false,
    spaces: new Set(),
  });
  // Keyed on the space ID SET (not the orderedSpaces array identity, which is
  // replaced on every space diff batch) so an open menu doesn't re-run the
  // async power-level sweep — and flicker — on unrelated diffs.
  const spaceIdsKey = spaces.orderedSpaces.map((s) => s.id).join(",");
  useEffect(() => {
    const room = roomMenu?.room;
    setRoomPerms({ invite: false, spaces: new Set() });
    if (!room) return;
    let alive = true;
    void (async () => {
      const invite = await scope.spaces.checkCanInvite(room.id).catch(() => false);
      const manageable = new Set<string>();
      // Filing/unfiling a room only writes `m.space.child` in the SPACE, so the
      // permission that matters is power in the space — NOT power in the room.
      // Gating on room-level power (checkCanMoveRoom) meant a space admin
      // couldn't remove a room they hadn't joined, since getRoom() is null for
      // an unjoined room and the check failed closed.
      if (!room.isSpace) {
        await Promise.all(
          scope.spaces.state.orderedSpaces.map(async (s) => {
            if (s.id === room.id) return;
            if (await scope.spaces.checkCanManageSpace(s.id).catch(() => false)) manageable.add(s.id);
          }),
        );
      }
      if (alive) setRoomPerms({ invite, spaces: manageable });
    })();
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roomMenu, scope, spaceIdsKey]);
  const openRoomMenu = (e: React.MouseEvent, room: RoomSummary) => {
    e.preventDefault();
    setRoomMenu({ anchor: { x: e.clientX, y: e.clientY }, room });
  };
  const roomMenuItems = useMemo<MenuItem[]>(() => {
    const room = roomMenu?.room;
    if (!room) return [];
    const rl = scope.roomList;
    const unread = hasAnyUnread(room);
    return [
      unread
        ? {
            key: "read",
            label: "Mark as read",
            icon: "check",
            onSelect: () => void rl.markRead([room.id]),
          }
        : {
            key: "unread",
            label: "Mark as unread",
            icon: "check",
            onSelect: () => void rl.markUnread(room.id, true),
          },
      room.isMuted
        ? {
            key: "unmute",
            label: "Unmute",
            icon: "bell",
            onSelect: () => void rl.setMuted(room.id, false),
          }
        : {
            key: "mute",
            label: "Mute",
            icon: "bell",
            onSelect: () => void rl.setMuted(room.id, true),
          },
      {
        key: "fav",
        label: room.isFavourite ? "Unfavourite" : "Favourite",
        icon: "star",
        onSelect: () => void rl.favourite(room.id, !room.isFavourite),
      },
      ...(roomPerms.invite
        ? [
            {
              key: "invite",
              label: "Invite People…",
              icon: "plus" as const,
              onSelect: () => modals.openInvite(room.id, room.name),
            },
          ]
        : []),
      // Add to / remove from each space the user can manage (organize rooms).
      ...spaces.orderedSpaces
        .filter((s) => !room.isSpace && s.id !== room.id && roomPerms.spaces.has(s.id))
        .map((s): MenuItem => {
          const inSpace = scope.spaces.childRoomIds(s.id).includes(room.id);
          return {
            key: `space-${s.id}`,
            label: inSpace ? `Remove from ${s.name}` : `Add to ${s.name}`,
            icon: inSpace ? "x" : "hash",
            danger: inSpace,
            confirm: inSpace ? `Remove “${room.name}” from ${s.name}?` : undefined,
            onSelect: () => void scope.spaces.toggleRoomInSpace(room.id, s.id),
          };
        }),
      {
        key: "settings",
        label: "Room settings",
        icon: "gear",
        onSelect: () => modals.openRoomSettings(room.id),
      },
      {
        key: "leave",
        label: room.isDirect ? "Leave conversation" : "Leave room",
        icon: "trash",
        danger: true,
        confirm: room.isDirect
          ? `Leave your conversation with ${room.name}? It'll be removed from your list.`
          : `Leave “${room.name}”? You'll need a new invite to rejoin if it's private.`,
        onSelect: () => void rl.leaveRoom(room.id),
      },
    ];
  }, [roomMenu, scope, spaces.orderedSpaces, roomPerms]);

  return (
    <div className="rl">
      <header className="rl__header">
        <button
          className="rl__title rl__title--menu"
          type="button"
          onClick={(e) => {
            const r = e.currentTarget.getBoundingClientRect();
            setHeaderMenu({ x: r.left, y: r.bottom + 4 });
          }}
          title="Options"
        >
          {title}
          <Icon name="chevron-down" size={14} />
        </button>
        <button
          className="rl__new"
          type="button"
          title="New conversation"
          aria-label="New conversation"
          onClick={(e) => {
            const r = e.currentTarget.getBoundingClientRect();
            setNewMenu({ x: r.right - 200, y: r.bottom + 4 });
          }}
        >
          <Icon name="plus" size={18} />
        </button>
      </header>

      {selectedSpaceId == null && (
        <div className="rl__search">
          <input
            ref={searchRef}
            type="text"
            placeholder="Search rooms"
            value={roomList.searchQuery}
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            onChange={(e) => scope.roomList.setSearchQuery(e.target.value)}
          />
        </div>
      )}

      {!roomList.isLoaded && roomList.rooms.length === 0 ? (
        // Skeleton rows sized like real rows, so the first sync doesn't jump.
        <div className="rl__scroll" aria-label="Loading rooms">
          {Array.from({ length: 8 }, (_, i) => (
            <div key={i} className="rl-row rl-row--skeleton" aria-hidden>
              <div className="rl-skel-avatar" />
              <div className="rl-skel-lines">
                <div />
                <div />
              </div>
            </div>
          ))}
        </div>
      ) : (
        <div className="rl__scroll">
          {selectedSpaceId != null && bannerUrl && (
            <button
              className="rl__space-banner"
              type="button"
              onClick={() => setSpaceHomeOpen(true)}
              title="Space details"
              style={{ backgroundImage: `url(${bannerUrl})` }}
            />
          )}
          {roomList.actionError && (
            <div className="rl__action-error" role="alert">
              <Icon name="warning" size={14} /> {roomList.actionError}
            </div>
          )}
          {matchingSpaces.length > 0 && (
            <section className="rl__section">
              <div className="rl__section-title">Spaces</div>
              {matchingSpaces.map((s) => (
                <button
                  key={s.id}
                  className="rl-jump"
                  type="button"
                  onClick={() => {
                    app.selectSpace(s.id);
                    scope.roomList.setSearchQuery("");
                  }}
                >
                  {s.name}
                </button>
              ))}
            </section>
          )}

          {invites.length > 0 && (
            <section className="rl__section">
              <div className="rl__section-title">Invites</div>
              {invites.map((r) => (
                <InviteRow
                  key={r.id}
                  room={r}
                  onAccept={async () => {
                    await scope.roomList.acceptInvite(r.id);
                    if (!r.isSpace) app.selectRoom(r.id);
                  }}
                  onDecline={() => void scope.roomList.declineInvite(r.id)}
                />
              ))}
            </section>
          )}

          <RoomsSection
            rooms={visibleRooms}
            selectedRoomId={selectedRoomId}
            onSelect={selectRoom}
            onContextMenu={openRoomMenu}
            onHover={(id) => prefetchTimeline(session, id)}
            isLoaded={roomList.isLoaded}
            inSpace={selectedSpaceId != null}
          />

          {moreRooms.length > 0 && (
            <section className="rl__section">
              <div className="rl__section-title">More Rooms</div>
              {moreRooms.map((c) => (
                <SpaceDirectoryRow
                  key={c.id}
                  child={c}
                  onJoin={async () => {
                    const id = await scope.spaces.joinChild(c);
                    if (id) app.selectRoom(id);
                  }}
                />
              ))}
            </section>
          )}
        </div>
      )}

      {spaceHomeOpen && currentSpace && (
        <SpaceHomeView
          space={currentSpace}
          spaces={scope.spaces}
          bannerUrl={bannerUrl}
          onBannerChanged={setBannerMxc}
          onClose={() => setSpaceHomeOpen(false)}
        />
      )}

      {headerMenu && (
        <RoomMenu
          anchor={headerMenu}
          items={headerMenuItems}
          onClose={() => setHeaderMenu(null)}
        />
      )}

      {newMenu && (
        <RoomMenu anchor={newMenu} items={newMenuItems} onClose={() => setNewMenu(null)} />
      )}

      {roomMenu && (
        <RoomMenu
          anchor={roomMenu.anchor}
          items={roomMenuItems}
          onClose={() => setRoomMenu(null)}
        />
      )}
    </div>
  );
}

function RoomsSection({
  rooms,
  selectedRoomId,
  onSelect,
  onContextMenu,
  onHover,
  isLoaded,
  inSpace,
}: {
  rooms: RoomSummary[];
  selectedRoomId: string | null;
  onSelect: (id: string) => void;
  onContextMenu: (e: React.MouseEvent, room: RoomSummary) => void;
  onHover: (id: string) => void;
  isLoaded: boolean;
  inSpace: boolean;
}) {
  const scrollParent = useRef<HTMLDivElement>(null);

  if (rooms.length === 0) {
    if (!isLoaded) return null;
    return (
      <div className="rl__empty">
        <div className="rl__empty-title">No Rooms</div>
        <div className="rl__empty-sub">
          {inSpace
            ? "This space has no rooms you've joined."
            : "Join a room to get started."}
        </div>
      </div>
    );
  }

  const renderRow = (room: RoomSummary) => (
    <RoomRow
      room={room}
      selected={room.id === selectedRoomId}
      onSelect={() => onSelect(room.id)}
      onContextMenu={(e) => onContextMenu(e, room)}
      onHover={() => onHover(room.id)}
    />
  );

  if (rooms.length > VIRTUALIZE_THRESHOLD) {
    return (
      <div className="rl__list" aria-label="Rooms" ref={scrollParent}>
        <Virtuoso
          style={{ height: "100%" }}
          data={rooms}
          computeItemKey={(_, room) => room.id}
          itemContent={(_, room) => renderRow(room)}
        />
      </div>
    );
  }

  return (
    <div className="rl__list rl__list--short" aria-label="Rooms">
      {rooms.map((room) => (
        <div key={room.id}>{renderRow(room)}</div>
      ))}
    </div>
  );
}

// Local re-derivation so the effect doesn't need the mapper import in the view.
function derivedHasAnyUnread(r: RoomSummary): boolean {
  const hasUnread = r.isMuted
    ? r.unreadMentions > 0
    : r.unreadNotifications > 0 || r.unreadMentions > 0 || r.isMarkedUnread;
  return hasUnread || (!r.isMuted && r.unreadMessages > 0);
}
