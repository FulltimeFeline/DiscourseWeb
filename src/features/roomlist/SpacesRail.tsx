// The spaces rail.
//
// Home button (envelope glyph) + a divider + one avatar per top-level joined
// space (drag-arranged order) + a "+" New Space button. Each slot shows a
// leading selection pill (selected) or a shorter unread pip (unselected+unread),
// and a red bottom-trailing mention dot. Selecting a slot calls app.selectSpace.

import { useMemo, useState } from "react";
import type { AppState } from "@/app/AppState";
import { useSession } from "@/app/context";
import { useViewModel } from "@/core/reactive";
import { modals } from "@/features/settings/ModalManager";
import { useRoomListScope } from "./scope";
import type { SpaceItem } from "./SpacesViewModel";
import { RoomAvatar } from "./RoomAvatar";
import { RoomMenu, type MenuAnchor, type MenuItem } from "./RoomMenu";
import { Icon } from "@/ui/Icon";
import "./roomlist.css";

interface SpaceMenuState {
  anchor: MenuAnchor;
  space: SpaceItem;
}

export function SpacesRail({ app }: { app: AppState }) {
  const session = useSession();
  const appState = useViewModel(app);
  const scope = useRoomListScope(app, session);
  const spaces = useViewModel(scope.spaces);

  const selectedSpaceId = appState.selectedSpaceId;
  const [dragging, setDragging] = useState<string | null>(null);

  // Right-click context menu for a space avatar.
  const [spaceMenu, setSpaceMenu] = useState<SpaceMenuState | null>(null);
  const openSpaceMenu = (e: React.MouseEvent, space: SpaceItem) => {
    e.preventDefault();
    setSpaceMenu({ anchor: { x: e.clientX, y: e.clientY }, space });
  };
  const spaceMenuItems = useMemo<MenuItem[]>(() => {
    const space = spaceMenu?.space;
    if (!space) return [];
    return [
      {
        key: "read",
        label: "Mark all as read",
        icon: "check",
        onSelect: () =>
          void scope.roomList.markRead(scope.spaces.childRoomIds(space.id)),
      },
      {
        key: "join",
        label: "Join Room…",
        icon: "plus",
        onSelect: () => window.dispatchEvent(new CustomEvent("discourse:new-join")),
      },
      {
        key: "refresh",
        label: "Refresh Rooms",
        icon: "retry",
        onSelect: () => void scope.spaces.loadChildren(space.id),
      },
      {
        key: "settings",
        label: "Space settings",
        icon: "gear",
        onSelect: () => modals.openRoomSettings(space.id),
      },
      {
        key: "leave",
        label: "Leave space",
        icon: "trash",
        danger: true,
        confirm: `Leave “${space.name}”? Its rooms stay joined; you'll need a new invite to rejoin if it's private.`,
        onSelect: () => void scope.spaces.leaveSpace(space.id),
      },
    ];
  }, [spaceMenu, scope]);

  // Home button context menu (Mark all as read over Home rooms: DMs + rooms
  // not filed under any space).
  const [homeMenu, setHomeMenu] = useState<MenuAnchor | null>(null);
  const homeMenuItems = useMemo<MenuItem[]>(
    () => [
      {
        key: "read",
        label: "Mark all as read",
        icon: "check",
        onSelect: () => {
          const all = scope.spaces.state.allSpaceChildIds;
          const ids = scope.roomList.state.rooms
            .filter((r) => !r.isSpace && (r.isDirect || !all.has(r.id)))
            .map((r) => r.id);
          void scope.roomList.markRead(ids);
        },
      },
    ],
    [scope],
  );

  const reorder = (fromId: string, beforeId: string | null) => {
    const ids = spaces.orderedSpaces.map((s) => s.id).filter((id) => id !== fromId);
    if (beforeId == null) {
      ids.push(fromId);
    } else {
      const idx = ids.indexOf(beforeId);
      ids.splice(idx < 0 ? ids.length : idx, 0, fromId);
    }
    scope.spaces.moveSpace(ids);
  };

  return (
    <div className="rail" role="tablist" aria-label="Spaces">
      <RailButton
        selected={selectedSpaceId == null}
        unread={spaces.homeHasUnread}
        mention={spaces.homeHasMention}
        label="Home"
        onSelect={() => app.selectSpace(null)}
        onContextMenu={(e) => {
          e.preventDefault();
          setHomeMenu({ x: e.clientX, y: e.clientY });
        }}
      >
        <span className="rail__home" aria-hidden>
          <Icon name="envelope" size={22} />
        </span>
      </RailButton>

      <div className="rail__divider" aria-hidden />

      <div className="rail__list">
        {spaces.orderedSpaces.map((s) => (
          <RailButton
            key={s.id}
            selected={selectedSpaceId === s.id}
            unread={spaces.unreadSpaceIds.has(s.id)}
            mention={spaces.mentionSpaceIds.has(s.id)}
            label={s.name}
            draggable
            onDragStart={() => setDragging(s.id)}
            onDragEnd={() => setDragging(null)}
            onDragEnter={() => {
              if (dragging && dragging !== s.id) reorder(dragging, s.id);
            }}
            onSelect={() => app.selectSpace(s.id)}
            onContextMenu={(e) => openSpaceMenu(e, s)}
          >
            <SpaceAvatar space={s} />
          </RailButton>
        ))}
      </div>

      <button
        type="button"
        className="rail__add"
        title="New Space"
        aria-label="New Space"
        onClick={() => {
          // New-space sheet lives in the app-level compose flow; expose the hook.
          window.dispatchEvent(new CustomEvent("discourse:new-space"));
        }}
      >
        <Icon name="plus" size={20} />
      </button>

      {spaceMenu && (
        <RoomMenu
          anchor={spaceMenu.anchor}
          items={spaceMenuItems}
          onClose={() => setSpaceMenu(null)}
        />
      )}
      {homeMenu && (
        <RoomMenu anchor={homeMenu} items={homeMenuItems} onClose={() => setHomeMenu(null)} />
      )}
    </div>
  );
}

function SpaceAvatar({ space }: { space: SpaceItem }) {
  return <RoomAvatar name={space.name} avatarUrl={space.avatarUrl} size={40} />;
}

function RailButton({
  selected,
  unread,
  mention,
  label,
  children,
  onSelect,
  draggable,
  onDragStart,
  onDragEnd,
  onDragEnter,
  onContextMenu,
}: {
  selected: boolean;
  unread: boolean;
  mention: boolean;
  label: string;
  children: React.ReactNode;
  onSelect: () => void;
  draggable?: boolean;
  onDragStart?: () => void;
  onDragEnd?: () => void;
  onDragEnter?: () => void;
  onContextMenu?: (e: React.MouseEvent) => void;
}) {
  return (
    <div className="rail__slot">
      {(selected || unread) && (
        <span
          className={`rail__pill${selected ? " rail__pill--selected" : " rail__pill--unread"}`}
          aria-hidden
        />
      )}
      <button
        type="button"
        className={`rail__btn${selected ? " rail__btn--selected" : ""}`}
        role="tab"
        aria-selected={selected}
        aria-label={label}
        title={label}
        draggable={draggable}
        onClick={onSelect}
        onContextMenu={onContextMenu}
        onDragStart={onDragStart}
        onDragEnd={onDragEnd}
        onDragEnter={onDragEnter}
        onDragOver={(e) => draggable && e.preventDefault()}
      >
        {children}
      </button>
      {mention && <span className="rail__mention" aria-hidden />}
    </div>
  );
}
