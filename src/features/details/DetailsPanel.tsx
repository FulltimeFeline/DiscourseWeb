// The room details panel: a right-side overlay (sibling of the thread panel)
// with an Info / Members / Media tab bar. Each tab is its own component so its
// view model only spins up when the tab is shown.

import { useEffect, useMemo, useState } from "react";
import { useSession } from "@/app/context";
import { useViewModel } from "@/core/reactive";
import { Icon } from "@/ui/Icon";
import { RoomAvatar } from "@/features/roomlist/RoomAvatar";
import { modals } from "@/features/settings/ModalManager";
import {
  usePresence,
  usePresenceMap,
  presenceColor,
  type PresenceState,
} from "@/core/PresenceService";
import type { MatrixSession } from "@/core/MatrixSession";
import { EncryptionState, type RoomInfo } from "@/matrix";
import { Lightbox } from "@/features/media/Lightbox";
import { useMedia } from "@/features/timeline/useMedia";
import {
  MembersViewModel,
  type MemberEntry,
  type MemberRole,
} from "./MembersViewModel";
import { MediaViewModel, type MediaItem } from "./MediaViewModel";
import { startDirectMessage } from "@/features/compose/ComposeViewModel";
import { usePowerTags } from "@/features/emotes/emojiSession";
import { EmoteImage } from "@/features/pickers/EmoteImage";
import type { RoleTag } from "@/features/emotes";
import "./details.css";

/** Power ranking for gating moderation (higher = more privileged). */
const ROLE_RANK: Record<MemberRole, number> = { creator: 3, admin: 2, moderator: 1, user: 0 };

/** The fancy role header (colored name + optional mxc/unicode icon). */
function RoleHeaderLabel({ tag }: { tag: RoleTag }) {
  const isMxc = !!tag.icon && tag.icon.startsWith("mxc://");
  return (
    <span className="details-role" style={tag.color ? { color: tag.color } : undefined}>
      {tag.icon &&
        (isMxc ? <EmoteImage mxc={tag.icon} size={14} alt="" /> : <span aria-hidden>{tag.icon}</span>)}
      <span>{tag.label}</span>
    </span>
  );
}

type Tab = "info" | "members" | "media";

export function DetailsPanel({
  roomId,
  onClose,
}: {
  roomId: string;
  onClose: () => void;
}) {
  const session = useSession();
  const [tab, setTab] = useState<Tab>(() => {
    const saved = localStorage.getItem("discourse.details.tab");
    return saved === "members" || saved === "media" ? saved : "info";
  });
  useEffect(() => {
    localStorage.setItem("discourse.details.tab", tab);
  }, [tab]);
  const [info, setInfo] = useState<RoomInfo | undefined>();

  useEffect(() => {
    let alive = true;
    const room = session.getRoom(roomId);
    if (!room) return;
    void room
      .roomInfo()
      .then((i) => {
        if (alive) setInfo(i);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [session, roomId]);

  const name = info?.displayName?.trim() || info?.canonicalAlias || roomId;

  void onClose;
  return (
    <div className="details-panel">
      <div className="details-tabs" role="tablist">
        <TabButton
          label="Info"
          active={tab === "info"}
          onClick={() => setTab("info")}
        />
        <TabButton
          label="Members"
          active={tab === "members"}
          onClick={() => setTab("members")}
        />
        <TabButton
          label="Media"
          active={tab === "media"}
          onClick={() => setTab("media")}
        />
      </div>

      <div className="details-body">
        {tab === "info" && (
          <InfoTab roomId={roomId} name={name} info={info} />
        )}
        {tab === "members" && (
          <MembersTab session={session} roomId={roomId} name={name} />
        )}
        {tab === "media" && <MediaTab session={session} roomId={roomId} />}
      </div>
    </div>
  );
}

function TabButton({
  label,
  active,
  onClick,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      role="tab"
      aria-selected={active}
      className={`details-tab${active ? " details-tab--active" : ""}`}
      onClick={onClick}
    >
      {label}
    </button>
  );
}

// --- Info tab ---------------------------------------------------------------

function InfoTab({
  roomId,
  name,
  info,
}: {
  roomId: string;
  name: string;
  info: RoomInfo | undefined;
}) {
  const [copied, setCopied] = useState(false);
  const encrypted = info?.encryptionState === EncryptionState.Encrypted;
  const memberCount = info ? Number(info.joinedMembersCount) : undefined;

  const copyId = () => {
    void navigator.clipboard?.writeText(roomId).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    });
  };

  return (
    <div className="details-info">
      <div className="details-info__hero">
        <RoomAvatar name={name} avatarUrl={info?.avatarUrl ?? undefined} size={88} />
        <h2 className="details-info__name">{name}</h2>
        {info?.topic?.trim() && (
          <p className="details-info__topic">{info.topic.trim()}</p>
        )}
      </div>

      <div className="details-meta">
        {memberCount !== undefined && (
          <div className="details-meta__row">
            <Icon name="people" />
            <span>
              {memberCount} {memberCount === 1 ? "member" : "members"}
            </span>
          </div>
        )}
        <div className="details-meta__row">
          <Icon name={encrypted ? "lock" : "info"} />
          <span>{encrypted ? "Encrypted" : "Not encrypted"}</span>
        </div>
        <button
          className="details-meta__row details-meta__row--button"
          onClick={copyId}
          title="Copy room ID"
        >
          <Icon name="copy" />
          <span className="details-meta__id">{copied ? "Copied!" : roomId}</span>
        </button>
      </div>

      <button
        className="details-settings-btn"
        onClick={() => modals.openRoomSettings(roomId)}
      >
        <Icon name="gear" />
        <span>Room settings</span>
      </button>
    </div>
  );
}

// --- Members tab ------------------------------------------------------------

function MembersTab({
  session,
  roomId,
  name,
}: {
  session: MatrixSession;
  roomId: string;
  name: string;
}) {
  void name;
  const vm = useMemo(
    () => new MembersViewModel(session, roomId),
    [session, roomId],
  );
  const state = useViewModel(vm);
  const [query, setQuery] = useState("");
  const ownRole = state.members.find((m) => m.userId === session.userId)?.role ?? "user";

  // Fancy roles: named/colored/iconned power-level tags (in.cinny.room.power_level_tags).
  const powerTags = usePowerTags(session);
  const [, setTagTick] = useState(0);
  useEffect(() => {
    void powerTags.ensure(roomId).then(() => setTagTick((t) => t + 1));
  }, [powerTags, roomId]);

  useEffect(() => {
    void vm.load();
    return () => vm.dispose();
  }, [vm]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return state.members;
    return state.members.filter(
      (m) =>
        m.displayName.toLowerCase().includes(q) ||
        m.userId.toLowerCase().includes(q),
    );
  }, [state.members, query]);

  // Split confirmed-offline members into their own section. On homeservers with
  // presence disabled, presence is undefined so nobody moves.
  const presenceMap = usePresenceMap(session, state.members.map((m) => m.userId));
  const onlineMembers = filtered.filter((m) => presenceMap[m.userId]?.state !== "offline");
  const offlineMembers = filtered.filter((m) => presenceMap[m.userId]?.state === "offline");

  // Distinct power levels present among online members, highest first.
  const powerLevelsDesc = useMemo(
    () => [...new Set(onlineMembers.map((m) => m.powerLevel))].sort((a, b) => b - a),
    [onlineMembers],
  );

  return (
    <div className="details-members">
      <div className="details-search">
        <Icon name="search" />
        <input
          className="details-search__input"
          placeholder="Search members"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>

      {state.loading && (
        <div className="details-empty">Loading members…</div>
      )}
      {!state.loading && state.error && (
        <div className="details-empty">Couldn’t load members.</div>
      )}
      {!state.loading && !state.error && (
        <>
          <div className="details-members__count">
            {filtered.length} {filtered.length === 1 ? "member" : "members"}
          </div>
          <div className="details-members__list">
            {powerLevelsDesc.map((level) => {
              const group = onlineMembers.filter((m) => m.powerLevel === level);
              if (group.length === 0) return null;
              const tag = powerTags.roleForSync(roomId, level);
              return (
                <div key={level} className="details-members__group">
                  <div className="details-members__group-title">
                    <RoleHeaderLabel tag={tag} /> — {group.length}
                  </div>
                  {group.map((m) => (
                    <MemberRow key={m.userId} session={session} member={m} vm={vm} ownRole={ownRole} canChangeRoles={state.canChangePowerLevels} ownPowerLevel={state.ownPowerLevel} />
                  ))}
                </div>
              );
            })}
            {offlineMembers.length > 0 && (
              <div className="details-members__group details-members__group--offline">
                <div className="details-members__group-title">Offline — {offlineMembers.length}</div>
                {offlineMembers.map((m) => (
                  <MemberRow key={m.userId} session={session} member={m} vm={vm} ownRole={ownRole} canChangeRoles={state.canChangePowerLevels} ownPowerLevel={state.ownPowerLevel} />
                ))}
              </div>
            )}
            {filtered.length === 0 && (
              <div className="details-empty">No matches.</div>
            )}
          </div>
        </>
      )}
    </div>
  );
}

function MemberRow({
  session,
  member,
  vm,
  ownRole,
  canChangeRoles,
  ownPowerLevel,
}: {
  session: MatrixSession;
  member: MemberEntry;
  vm: MembersViewModel;
  ownRole: MemberRole;
  canChangeRoles: boolean;
  ownPowerLevel: number;
}) {
  const presence = usePresence(session, member.userId);
  const state: PresenceState | undefined = presence?.state;
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);

  const isSelf = member.userId === session.userId;
  // Can moderate a target strictly below our own power (and not ourselves).
  const canModerate = !isSelf && ROLE_RANK[ownRole] >= 1 && ROLE_RANK[ownRole] > ROLE_RANK[member.role];
  // Can re-level a target strictly below our own power level.
  const canSetRole = canChangeRoles && !isSelf && member.powerLevel < ownPowerLevel;

  const setLevel = (level: number) => {
    void vm.setPowerLevel(member.userId, Math.max(0, Math.min(level, ownPowerLevel)));
  };
  const promptLevel = () => {
    const raw = window.prompt(
      `Power level for ${member.displayName} (0–${ownPowerLevel}):`,
      String(member.powerLevel),
    );
    if (raw == null) return;
    const n = Number(raw.trim());
    if (Number.isFinite(n)) setLevel(Math.round(n));
  };
  const roleItems = canSetRole
    ? [
        ...(ownPowerLevel >= 100 && member.powerLevel !== 100
          ? [{ key: "admin", label: "Make Administrator (100)", onSelect: () => setLevel(100) }]
          : []),
        ...(ownPowerLevel > 50 && member.powerLevel !== 50
          ? [{ key: "mod", label: "Make Moderator (50)", onSelect: () => setLevel(50) }]
          : []),
        ...(member.powerLevel !== 0
          ? [{ key: "member", label: "Make Member (0)", onSelect: () => setLevel(0) }]
          : []),
        { key: "custom", label: "Set level…", onSelect: promptLevel },
      ]
    : [];

  const openMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    setMenu({ x: e.clientX, y: e.clientY });
  };

  return (
    <>
      <button
        className="details-member"
        onClick={() => modals.openProfile(member.userId)}
        onContextMenu={openMenu}
      >
        <div className="details-member__avatar">
          <RoomAvatar name={member.displayName} avatarUrl={member.avatarUrl} size={36} />
          {state && (
            <span
              className="details-member__presence"
              style={{ background: presenceColor(state) }}
            />
          )}
        </div>
        <div className="details-member__body">
          <span className="details-member__name">{member.displayName}</span>
          {presence?.statusMessage && (
            <span className="details-member__status">{presence.statusMessage}</span>
          )}
        </div>
      </button>
      {menu && (
        <MemberMenu
          x={menu.x}
          y={menu.y}
          onClose={() => setMenu(null)}
          items={[
            { key: "profile", label: "View profile", onSelect: () => modals.openProfile(member.userId) },
            ...(isSelf
              ? []
              : [
                  {
                    key: "dm",
                    label: "Message",
                    onSelect: async () => {
                      // The menu unmounts on select, so there is nowhere to
                      // surface a failure; at least don't leave it unhandled.
                      try {
                        const rid = await startDirectMessage(session, member.userId);
                        if (rid) window.dispatchEvent(new CustomEvent("discourse:select-room", { detail: { roomId: rid } }));
                      } catch (err) {
                        console.error("[details] could not start DM", err);
                      }
                    },
                  },
                ]),
            {
              key: "copy",
              label: "Copy user ID",
              onSelect: () => void navigator.clipboard?.writeText(member.userId),
            },
            ...roleItems,
            ...(canModerate
              ? [
                  {
                    key: "kick",
                    label: "Remove from room",
                    danger: true,
                    onSelect: () => {
                      if (window.confirm(`Remove ${member.displayName} from this room?`)) void vm.kick(member.userId);
                    },
                  },
                  {
                    key: "ban",
                    label: "Ban from room",
                    danger: true,
                    onSelect: () => {
                      if (window.confirm(`Ban ${member.displayName} from this room?`)) void vm.ban(member.userId);
                    },
                  },
                ]
              : []),
          ]}
        />
      )}
    </>
  );
}

function MemberMenu({
  x,
  y,
  items,
  onClose,
}: {
  x: number;
  y: number;
  items: { key: string; label: string; danger?: boolean; onSelect: () => void }[];
  onClose: () => void;
}) {
  useEffect(() => {
    const close = () => onClose();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("click", close);
    window.addEventListener("resize", close);
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("click", close);
      window.removeEventListener("resize", close);
      window.removeEventListener("keydown", onKey, true);
    };
  }, [onClose]);
  return (
    <div
      className="member-menu"
      role="menu"
      style={{ left: Math.min(x, window.innerWidth - 200), top: Math.min(y, window.innerHeight - 40 - items.length * 34) }}
      onClick={(e) => e.stopPropagation()}
    >
      {items.map((it) => (
        <button
          key={it.key}
          role="menuitem"
          className={`member-menu__item${it.danger ? " member-menu__item--danger" : ""}`}
          onClick={() => {
            it.onSelect();
            onClose();
          }}
        >
          {it.label}
        </button>
      ))}
    </div>
  );
}

// --- Media tab --------------------------------------------------------------

function MediaTab({
  session,
  roomId,
}: {
  session: MatrixSession;
  roomId: string;
}) {
  const vm = useMemo(
    () => new MediaViewModel(session, roomId),
    [session, roomId],
  );
  const state = useViewModel(vm);
  const [lightbox, setLightbox] = useState<MediaItem | undefined>();

  useEffect(() => {
    void vm.start();
    return () => vm.dispose();
  }, [vm]);

  const gallery = state.items.filter((i) => i.kind === "image" || i.kind === "video");
  const files = state.items.filter((i) => i.kind === "file" || i.kind === "audio");

  return (
    <div className="details-media">
      {state.loading && <div className="details-empty">Loading media…</div>}
      {!state.loading && state.items.length === 0 && (
        <div className="details-empty">
          <Icon name="image" />
          <span>No media yet</span>
        </div>
      )}
      {gallery.length > 0 && (
        <div className="details-media__grid">
          {gallery.map((item) => (
            <MediaThumb
              key={item.id}
              item={item}
              onClick={() => setLightbox(item)}
            />
          ))}
        </div>
      )}

      {files.length > 0 && (
        <div className="details-files">
          <div className="details-files__title">Files</div>
          {files.map((item) => (
            <FileRow key={item.id} session={session} item={item} />
          ))}
        </div>
      )}

      {lightbox && (
        <Lightbox
          loader={session.mediaLoader}
          source={lightbox.source}
          mimetype={lightbox.mimetype}
          kind={lightbox.kind === "video" ? "video" : "image"}
          onClose={() => setLightbox(undefined)}
        />
      )}
    </div>
  );
}

function MediaThumb({
  item,
  onClick,
}: {
  item: MediaItem;
  onClick: () => void;
}) {
  const url = useMedia(item.thumbnail, { width: 240, height: 240 });

  return (
    <button className="details-media__cell" onClick={onClick} title={item.body}>
      {url ? (
        <img src={url} alt="" className="details-media__img" />
      ) : (
        <div className="details-media__placeholder" />
      )}
      {item.kind === "video" && (
        <span className="details-media__play">
          <Icon name="play" />
        </span>
      )}
    </button>
  );
}

function formatSize(bytes?: number): string {
  if (!bytes) return "";
  const units = ["B", "KB", "MB", "GB"];
  let n = bytes;
  let u = 0;
  while (n >= 1024 && u < units.length - 1) {
    n /= 1024;
    u++;
  }
  return `${n < 10 && u > 0 ? n.toFixed(1) : Math.round(n)} ${units[u]}`;
}

function FileRow({ session, item }: { session: MatrixSession; item: MediaItem }) {
  const [busy, setBusy] = useState(false);
  const download = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const url = await session.mediaLoader.load({
        // The boxed FFI MediaSource, not the MediaRef wrapper — the wrapper
        // fails `isFfiSource`, falls back to MediaSource.fromUrl(mxc) and
        // downloads raw ciphertext for encrypted rooms.
        source: item.source.source,
        mxc: item.source.mxc,
        mimetype: item.mimetype,
      });
      if (url) {
        const a = document.createElement("a");
        a.href = url;
        a.download = item.body || "file";
        a.click();
      }
    } finally {
      setBusy(false);
    }
  };
  return (
    <button className="details-file" onClick={() => void download()} title={item.body} disabled={busy}>
      <Icon name={item.kind === "audio" ? "music" : "file"} size={18} />
      <span className="details-file__body">
        <span className="details-file__name">{item.body || "File"}</span>
        <span className="details-file__meta">
          {new Date(item.timestamp).toLocaleDateString(undefined, { month: "short", day: "numeric" })}
          {item.size ? ` · ${formatSize(item.size)}` : ""}
        </span>
      </span>
      <Icon name="copy" size={14} />
    </button>
  );
}
