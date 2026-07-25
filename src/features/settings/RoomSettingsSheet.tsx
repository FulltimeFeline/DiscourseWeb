// Per-room and per-space settings: a modal with General, Security, Roles,
// Notifications, Members, and Advanced tabs. Every edit control is read-only
// until the matching `canOwnUserSendState` gate resolves true; a spinner shows
// while loading. Most writes go straight to the FFI Room object
// (room.setName/setTopic/uploadAvatar/updateJoinRules). The Cinny role-label
// state event and space banner have no `sendStateEventRaw` in this SDK build,
// so those use session REST.

import { useEffect, useMemo, useState } from "react";
import { useApp, useSession } from "@/app/context";
import { useRoomListScope } from "@/features/roomlist/scope";
import { usePowerTags, useCustomEmoji } from "@/features/emotes/emojiSession";
import { EmojiPicker } from "@/features/pickers";
import type { PowerLevelTag } from "@/features/emotes/PowerLevelTags";
import {
  StateEventType,
  EncryptionState,
  JoinRule,
  AllowRule,
  MembershipState_Tags,
  RoomHistoryVisibility,
  RoomVisibility,
  RoomNotificationMode,
  type RoomInterface,
  type RoomInfo,
  type RoomMember,
  type RoomPowerLevelChanges,
} from "@/matrix";
import { Modal, Section, Row, TextField, Toggle, Segmented, Button } from "./primitives";
import { EmotePackEditor } from "./EmotePackEditor";
import { PollHistoryViewModel } from "./PollHistoryViewModel";
import { PollView } from "@/features/emotes/PollView";
import { useViewModel } from "@/core/reactive";
import { pickImage } from "./media";
import { useMediaUrl } from "./useMediaUrl";
import { Icon } from "@/ui/Icon";
import "./settings.css";

type Tab = "general" | "security" | "roles" | "notifications" | "members" | "emotes" | "polls" | "advanced";

interface Gates {
  basics: boolean; // name AND topic AND avatar
  encryption: boolean;
  access: boolean; // joinRules AND historyVisibility
  addresses: boolean;
  roles: boolean;
}

interface Loaded {
  info: RoomInfo;
  isSpace: boolean;
  gates: Gates;
  powerValues: Record<string, bigint>;
  userLevels: Map<string, bigint>;
  notifMode: RoomNotificationMode | undefined;
}

export function RoomSettingsSheet({ roomId, onClose }: { roomId: string; onClose: () => void }) {
  const app = useApp();
  const session = useSession();
  const scope = useRoomListScope(app, session);
  const room = useMemo(() => session.getRoom(roomId), [session, roomId]);
  const parentSpaceIds = useMemo(() => scope.spaces.parentSpaceIds(roomId), [scope, roomId]);
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [tab, setTab] = useState<Tab>("general");

  useEffect(() => {
    if (!room) return;
    let alive = true;
    void (async () => {
      const info = await room.roomInfo();
      const levels = await room.getPowerLevels();
      const values = levels.values();
      const userLevels = levels.userPowerLevels();
      const can = (e: StateEventType) => {
        try {
          return levels.canOwnUserSendState(e);
        } catch {
          return false;
        }
      };
      const gates: Gates = {
        basics: can(StateEventType.RoomName) && can(StateEventType.RoomTopic) && can(StateEventType.RoomAvatar),
        encryption: can(StateEventType.RoomEncryption),
        access: can(StateEventType.RoomJoinRules) && can(StateEventType.RoomHistoryVisibility),
        addresses: can(StateEventType.RoomCanonicalAlias),
        roles: can(StateEventType.RoomPowerLevels),
      };
      let notifMode: RoomNotificationMode | undefined;
      try {
        const ns = await session.client.getNotificationSettings();
        notifMode = await ns.getUserDefinedRoomNotificationMode(roomId);
      } catch {
        /* default */
      }
      const powerValues: Record<string, bigint> = {
        ban: values.ban,
        invite: values.invite,
        kick: values.kick,
        redact: values.redact,
        eventsDefault: values.eventsDefault,
        stateDefault: values.stateDefault,
        usersDefault: values.usersDefault,
        roomName: values.roomName,
        roomAvatar: values.roomAvatar,
        roomTopic: values.roomTopic,
      };
      if (alive) setLoaded({ info, isSpace: info.isSpace, gates, powerValues, userLevels, notifMode });
    })();
    return () => {
      alive = false;
    };
  }, [room, roomId, session]);

  if (!room) {
    return (
      <Modal title="Room Settings" onClose={onClose}>
        <p className="dm-empty">This room isn't available.</p>
      </Modal>
    );
  }

  const kind = loaded?.isSpace ? "Space" : "Room";
  const tabs: { id: Tab; label: string }[] = loaded?.isSpace
    ? [
        { id: "general", label: "General" },
        { id: "security", label: "Visibility" },
        { id: "roles", label: "Roles" },
        { id: "members", label: "Members" },
        { id: "emotes", label: "Emotes" },
        { id: "advanced", label: "Advanced" },
      ]
    : [
        { id: "general", label: "General" },
        { id: "security", label: "Security" },
        { id: "roles", label: "Roles" },
        { id: "notifications", label: "Notifications" },
        { id: "members", label: "Members" },
        { id: "emotes", label: "Emotes" },
        { id: "polls", label: "Polls" },
        { id: "advanced", label: "Advanced" },
      ];

  return (
    <Modal title={`${kind} Settings`} onClose={onClose} wide>
      {!loaded ? (
        <div className="dm-loading">
          <span className="dm-spinner dm-spinner--lg" />
        </div>
      ) : (
        <div className="dm-roomsettings">
          <nav className="dm-roomsettings__tabs">
            {tabs.map((t) => (
              <button key={t.id} className={`dm-tab dm-tab--h${t.id === tab ? " dm-tab--on" : ""}`} onClick={() => setTab(t.id)}>
                {t.label}
              </button>
            ))}
          </nav>
          <div className="dm-roomsettings__body">
            {tab === "general" && <GeneralTab room={room} loaded={loaded} onClose={onClose} />}
            {tab === "security" && <SecurityTab room={room} loaded={loaded} parentSpaceIds={parentSpaceIds} />}
            {tab === "roles" && <RolesTab room={room} loaded={loaded} />}
            {tab === "notifications" && <NotificationsTab room={room} roomId={roomId} loaded={loaded} />}
            {tab === "members" && <MembersTab room={room} />}
            {tab === "emotes" && <EmotePackEditor roomId={roomId} canEdit={loaded.gates.basics} />}
            {tab === "polls" && <PollsTab roomId={roomId} />}
            {tab === "advanced" && <AdvancedTab loaded={loaded} />}
          </div>
        </div>
      )}
    </Modal>
  );
}

// --- General ----------------------------------------------------------------

function GeneralTab({ room, loaded, onClose }: { room: RoomInterface; loaded: Loaded; onClose: () => void }) {
  const { info, gates, isSpace } = loaded;
  const [name, setName] = useState(info.rawName ?? info.displayName ?? "");
  const [topic, setTopic] = useState(info.topic ?? "");
  const [saving, setSaving] = useState(false);
  const avatarUrl = useMediaUrl(info.avatarUrl, { thumb: 144 });

  const changed = name.trim() !== (info.rawName ?? info.displayName ?? "").trim() || topic.trim() !== (info.topic ?? "").trim();

  async function save() {
    setSaving(true);
    try {
      if (name.trim() !== (info.rawName ?? info.displayName ?? "").trim()) await room.setName(name.trim());
      if (topic.trim() !== (info.topic ?? "").trim()) await room.setTopic(topic.trim());
    } finally {
      setSaving(false);
    }
  }

  async function changeAvatar() {
    const img = await pickImage();
    if (!img) return;
    try {
      await room.uploadAvatar(img.mimeType, img.data, undefined);
    } finally {
      URL.revokeObjectURL(img.previewUrl);
    }
  }

  return (
    <>
      <Section title="General">
        <div className="dm-avatar-edit">
          <div className="dm-avatar-edit__img dm-avatar-edit__img--square" style={avatarUrl ? { backgroundImage: `url(${avatarUrl})` } : undefined}>
            {!avatarUrl && (name || "#").slice(0, 1).toUpperCase()}
          </div>
          {gates.basics && (
            <div className="dm-avatar-edit__actions">
              <Button onClick={changeAvatar}>Change</Button>
              {info.avatarUrl && <Button variant="destructive" onClick={() => void room.removeAvatar()}>Remove</Button>}
            </div>
          )}
        </div>
        <Row label="Name" control={<TextField value={name} onChange={setName} disabled={!gates.basics} />} />
        <Row label={isSpace ? "Description" : "Topic"} control={<TextField multiline value={topic} onChange={setTopic} disabled={!gates.basics} />} />
        {gates.basics && (
          <Button variant="primary" disabled={!changed} busy={saving} onClick={save}>Save</Button>
        )}
      </Section>

      {!isSpace && gates.addresses && <AddressesSection room={room} loaded={loaded} />}

      <Section footnote="You can rejoin later if the room is public or you're re-invited.">
        <Button
          variant="destructive"
          onClick={async () => {
            if (confirm(`Leave this ${isSpace ? "space" : "room"}?`)) {
              await room.leave();
              onClose();
            }
          }}
        >
          Leave {isSpace ? "Space" : "Room"}
        </Button>
      </Section>
    </>
  );
}

function AddressesSection({ room, loaded }: { room: RoomInterface; loaded: Loaded }) {
  const [alias, setAlias] = useState((loaded.info.canonicalAlias ?? "").replace(/^#/, "").replace(/:.*/, ""));
  const [busy, setBusy] = useState(false);
  const [isPublic, setIsPublic] = useState(loaded.info.isPublic ?? false);
  const serverName = useMemo(() => {
    const s = loaded.info.canonicalAlias?.split(":")[1];
    return s ?? "";
  }, [loaded.info.canonicalAlias]);

  async function saveAlias() {
    setBusy(true);
    try {
      const local = alias.trim().replace(/^#/, "");
      if (!local) return;
      const full = `#${local}:${serverName || ""}`.replace(/:$/, "");
      const published = await room.publishRoomAliasInRoomDirectory(full);
      if (published) await room.updateCanonicalAlias(full, []);
    } finally {
      setBusy(false);
    }
  }

  async function toggleDirectory(next: boolean) {
    setIsPublic(next);
    await room.updateRoomVisibility(next ? new RoomVisibility.Public() : new RoomVisibility.Private());
  }

  return (
    <Section title="Room Addresses">
      <Row
        label="Main address"
        control={
          <div className="dm-inline">
            <span className="dm-prefix">#</span>
            <TextField value={alias} onChange={setAlias} placeholder="room-name" />
            <Button busy={busy} onClick={saveAlias}>Set</Button>
          </div>
        }
      />
      <Row label="Publish to room directory" control={<Toggle checked={isPublic} onChange={toggleDirectory} />} />
    </Section>
  );
}

// --- Security / Visibility --------------------------------------------------

function SecurityTab({
  room,
  loaded,
  parentSpaceIds,
}: {
  room: RoomInterface;
  loaded: Loaded;
  parentSpaceIds: string[];
}) {
  const { info, gates, isSpace } = loaded;
  const isEncrypted = info.encryptionState === EncryptionState.Encrypted;

  const joinRuleValue = joinRuleTag(info.joinRule);
  const [join, setJoin] = useState<"invite" | "restricted" | "public">(joinRuleValue);
  const [history, setHistory] = useState<"invited" | "joined" | "shared" | "worldReadable">(historyTag(info.historyVisibility));
  // "Space members" is only meaningful when the room belongs to a space and
  // isn't itself a space.
  const canRestrict = !isSpace && parentSpaceIds.length > 0;

  async function applyJoin(v: "invite" | "restricted" | "public") {
    setJoin(v);
    if (v === "public") await room.updateJoinRules(new JoinRule.Public());
    else if (v === "restricted" && parentSpaceIds.length > 0) {
      // Members of the parent space(s) may join without an invite.
      await room.updateJoinRules(
        new JoinRule.Restricted({
          rules: parentSpaceIds.map((id) => new AllowRule.RoomMembership({ roomId: id })),
        }),
      );
    } else {
      // Invite-only (also the fallback when there's no parent space to allow).
      if (v === "restricted") setJoin("invite");
      await room.updateJoinRules(new JoinRule.Invite());
    }
  }

  async function applyHistory(v: typeof history) {
    setHistory(v);
    const map = {
      invited: () => new RoomHistoryVisibility.Invited(),
      joined: () => new RoomHistoryVisibility.Joined(),
      shared: () => new RoomHistoryVisibility.Shared(),
      worldReadable: () => new RoomHistoryVisibility.WorldReadable(),
    };
    await room.updateHistoryVisibility(map[v]());
  }

  return (
    <>
      {/* Spaces get their addresses and directory publish here; rooms have it
          in the General tab. */}
      {isSpace && gates.addresses && <AddressesSection room={room} loaded={loaded} />}
      {!isSpace && (
        <Section title="Encryption" footnote="Encryption can't be turned off once enabled.">
          {isEncrypted ? (
            <div className="dm-locked"><Icon name="lock" /> End-to-end encrypted</div>
          ) : gates.encryption ? (
            <Button
              variant="destructive"
              onClick={async () => {
                if (confirm("Enable end-to-end encryption? This can't be undone.")) await room.enableEncryption();
              }}
            >
              Enable Encryption…
            </Button>
          ) : (
            <div className="dm-muted">Not encrypted</div>
          )}
        </Section>
      )}

      <Section title="Access">
        <Row
          label="Who can join"
          control={
            <Segmented
              value={join}
              disabled={!gates.access}
              onChange={applyJoin}
              options={[
                { value: "invite" as const, label: "Invite only" },
                ...(canRestrict || join === "restricted"
                  ? [{ value: "restricted" as const, label: "Space members" }]
                  : []),
                { value: "public" as const, label: "Anyone" },
              ]}
            />
          }
        />
      </Section>

      <Section title={isSpace ? "Preview" : "History"}>
        {isSpace ? (
          <Row
            label="Allow previewing"
            control={
              <Toggle
                disabled={!gates.access}
                checked={history === "worldReadable"}
                onChange={(v) => void applyHistory(v ? "worldReadable" : "shared")}
              />
            }
          />
        ) : (
          <Row
            label="Who can read history"
            control={
              <Segmented
                value={history}
                disabled={!gates.access}
                onChange={(v) => void applyHistory(v)}
                options={[
                  { value: "invited", label: "Since invite" },
                  { value: "joined", label: "Since join" },
                  { value: "shared", label: "Members" },
                  { value: "worldReadable", label: "Anyone" },
                ]}
              />
            }
          />
        )}
      </Section>
    </>
  );
}

function joinRuleTag(r: unknown): "invite" | "restricted" | "public" {
  const tag = String((r as { tag?: string })?.tag ?? "").toLowerCase();
  if (tag.includes("public")) return "public";
  if (tag.includes("restricted")) return "restricted";
  return "invite";
}
function historyTag(h: unknown): "invited" | "joined" | "shared" | "worldReadable" {
  const tag = String((h as { tag?: string })?.tag ?? "").toLowerCase();
  if (tag.includes("worldreadable")) return "worldReadable";
  if (tag.includes("joined")) return "joined";
  if (tag.includes("invited")) return "invited";
  return "shared";
}

// --- Roles & Permissions ----------------------------------------------------

const ROLE_OPTIONS = [
  { value: "0", label: "Default" },
  { value: "50", label: "Moderator" },
  { value: "100", label: "Admin" },
];

const PERMISSION_ROWS: { key: keyof RoomPowerLevelChanges; label: string }[] = [
  { key: "usersDefault", label: "Default role" },
  { key: "eventsDefault", label: "Send messages" },
  { key: "invite", label: "Invite users" },
  { key: "stateDefault", label: "Change settings" },
  { key: "kick", label: "Remove users" },
  { key: "ban", label: "Ban users" },
  { key: "redact", label: "Remove others' messages" },
  { key: "roomName", label: "Change name" },
  { key: "roomAvatar", label: "Change avatar" },
  { key: "roomTopic", label: "Change topic" },
];

function RolesTab({ room, loaded }: { room: RoomInterface; loaded: Loaded }) {
  const { gates, powerValues, userLevels } = loaded;
  const session = useSession();
  const [users, setUsers] = useState<[string, bigint][]>(() => Array.from(userLevels.entries()));
  const [newUser, setNewUser] = useState("");

  // Rooms these settings apply to: this room plus, if it's a space, every room
  // inside it — so a space's roles auto-apply to all its rooms. (Empty for a
  // regular room, so targetRooms is just itself.)
  const [childRooms, setChildRooms] = useState<string[]>([]);
  useEffect(() => {
    let alive = true;
    void session.spaceChildRoomIds(room.id()).then((ids) => {
      if (alive) setChildRooms(ids);
    });
    return () => {
      alive = false;
    };
  }, [session, room]);
  const targetRooms = useMemo(() => [room.id(), ...childRooms], [room, childRooms]);

  async function setUserLevel(userId: string, level: number) {
    // REST read-modify-write of m.room.power_levels (the FFI write is unreliable
    // in the WASM build). Fan out to every room in the space.
    let anyOk = false;
    for (const rid of targetRooms) {
      if (await session.setUserPowerLevel(rid, userId, level)) anyOk = true;
    }
    if (!anyOk) return;
    setUsers((prev) => {
      const next = prev.filter(([u]) => u !== userId);
      if (level !== 0) next.push([userId, BigInt(level)]);
      return next;
    });
  }

  async function applyPermission(key: keyof RoomPowerLevelChanges, level: number) {
    for (const rid of targetRooms) {
      await session.setPowerLevelField(rid, key as string, level);
    }
  }

  if (!gates.roles) return <Section title="Roles"><p className="dm-muted">You don't have permission to change roles here.</p></Section>;

  return (
    <>
      <Section title="Privileged Users">
        {users.map(([userId, level]) => (
          <Row
            key={userId}
            label={userId}
            control={
              <Segmented
                value={roleValueOf(level)}
                onChange={(v) => void setUserLevel(userId, Number(v))}
                options={[...roleOptionsFor(level), { value: "remove", label: "Remove" }]}
              />
            }
          />
        ))}
        <Row
          label="Add user"
          control={
            <div className="dm-inline">
              <TextField value={newUser} onChange={setNewUser} placeholder="@user:server" />
              <Button
                disabled={!newUser.startsWith("@")}
                onClick={() => {
                  void setUserLevel(newUser.trim(), 50);
                  setNewUser("");
                }}
              >
                + Moderator
              </Button>
              <Button
                disabled={!newUser.startsWith("@")}
                onClick={() => {
                  void setUserLevel(newUser.trim(), 100);
                  setNewUser("");
                }}
              >
                + Admin
              </Button>
            </div>
          }
        />
      </Section>

      <Section title="Permissions" footnote="The minimum role required for each action.">
        {PERMISSION_ROWS.map((r) => (
          <Row
            key={r.key}
            label={r.label}
            control={
              <Segmented
                value={roleValueOf(powerValues[r.key] ?? 0n)}
                onChange={(v) => void applyPermission(r.key, Number(v))}
                options={roleOptionsFor(powerValues[r.key] ?? 0n)}
              />
            }
          />
        ))}
      </Section>

      <RoleLabelsSection room={room} userLevels={loaded.userLevels} />
    </>
  );
}

// Editable custom names (and optional emoji) for each power-level role, stored
// in the Cinny-compatible `in.cinny.room.power_level_tags` state event.
const ROLE_LABEL_COLORS = [
  "#f43f5e", "#f59e0b", "#eab308", "#22c55e",
  "#14b8a6", "#3b82f6", "#8b5cf6", "#ec4899",
];

function defaultRoleName(level: number): string {
  if (level >= 100) return "Admin";
  if (level >= 50) return "Moderator";
  if (level < 0) return "Muted";
  return level === 0 ? "Member" : `Level ${level}`;
}

type RoleLabel = { name: string; icon: string; color: string };

function RoleLabelsSection({
  room,
  userLevels,
}: {
  room: RoomInterface;
  userLevels: Map<string, bigint>;
}) {
  const session = useSession();
  const customEmoji = useCustomEmoji(session);
  const powerTags = usePowerTags(session);
  const roomId = room.id();
  const [labels, setLabels] = useState<Record<number, RoleLabel>>({});
  const [levels, setLevels] = useState<number[]>([0, 50, 100]);
  const [pickerFor, setPickerFor] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<"idle" | "saved" | "forbidden" | "error">("idle");

  useEffect(() => {
    let alive = true;
    void powerTags.ensure(roomId).then((tags) => {
      if (!alive) return;
      // Union of the built-in tiers, every privileged user's actual level, and
      // any level already present in the tags event.
      const set = new Set<number>([0, 50, 100]);
      for (const lvl of userLevels.values()) set.add(Number(lvl));
      for (const t of tags) set.add(t.level);
      const lvls = [...set].sort((a, b) => a - b);
      setLevels(lvls);
      const map: Record<number, RoleLabel> = {};
      for (const lvl of lvls) {
        const t = tags.find((x) => x.level === lvl);
        map[lvl] = { name: t?.name ?? defaultRoleName(lvl), icon: t?.icon ?? "", color: t?.color ?? "" };
      }
      setLabels(map);
    });
    return () => {
      alive = false;
    };
  }, [powerTags, roomId, userLevels]);

  async function save() {
    setBusy(true);
    setStatus("idle");
    const tags: PowerLevelTag[] = levels.map((lvl) => {
      const v = labels[lvl] ?? { name: defaultRoleName(lvl), icon: "", color: "" };
      const icon = v.icon.trim();
      return {
        level: lvl,
        name: v.name.trim() || defaultRoleName(lvl),
        icon: icon || undefined,
        color: v.color || undefined,
        iconIsMxc: icon.startsWith("mxc://"),
      };
    });
    const res = await powerTags.save(roomId, tags);
    // If this is a space, write the same labels to every room inside it so the
    // roles show up wherever people are chatting.
    const childRooms = await session.spaceChildRoomIds(roomId);
    for (const rid of childRooms) await powerTags.save(rid, tags);
    setBusy(false);
    setStatus(res.ok ? "saved" : res.forbidden ? "forbidden" : "error");
  }

  const patch = (level: number, patch: Partial<RoleLabel>) =>
    setLabels((p) => ({ ...p, [level]: { ...p[level], ...patch } }));

  const iconPreview = (icon: string) => {
    if (!icon) return "＋";
    return icon.startsWith("mxc://") ? <MxcIcon mxc={icon} /> : icon;
  };

  return (
    <Section title="Role labels" footnote="Custom name, colour and icon shown next to members at each power level.">
      {levels.map((lvl) => {
        const l = labels[lvl] ?? { name: "", icon: "", color: "" };
        return (
          <div className="dm-rolelabel" key={lvl}>
            <div className="dm-rolelabel__head">
              <span className="dm-rolelabel__lvl">Level {lvl}</span>
              <button
                type="button"
                className="dm-rolelabel__icon"
                onClick={() => setPickerFor((p) => (p === lvl ? null : lvl))}
                aria-label="Choose icon"
              >
                {iconPreview(l.icon)}
              </button>
              <TextField value={l.name} onChange={(v) => patch(lvl, { name: v })} placeholder={defaultRoleName(lvl)} />
            </div>
            <div className="dm-rolelabel__swatches">
              <button
                type="button"
                className={`dm-swatch dm-swatch--none${!l.color ? " dm-swatch--on" : ""}`}
                onClick={() => patch(lvl, { color: "" })}
                aria-label="No colour"
              />
              {ROLE_LABEL_COLORS.map((c) => (
                <button
                  type="button"
                  key={c}
                  className={`dm-swatch${l.color === c ? " dm-swatch--on" : ""}`}
                  style={{ background: c }}
                  onClick={() => patch(lvl, { color: c })}
                  aria-label={`Colour ${c}`}
                />
              ))}
            </div>
            {pickerFor === lvl && (
              <div className="dm-rolelabel__picker">
                <EmojiPicker
                  customEmoji={customEmoji}
                  allowCustom
                  onPick={(pick) => {
                    patch(lvl, { icon: pick.kind === "unicode" ? pick.glyph : pick.mxc });
                    setPickerFor(null);
                  }}
                />
              </div>
            )}
          </div>
        );
      })}
      <div className="dm-inline">
        <Button busy={busy} onClick={() => void save()}>Save labels</Button>
        {status === "saved" && <span className="dm-muted">Saved.</span>}
        {status === "forbidden" && <span className="dm-muted">You don't have permission.</span>}
        {status === "error" && <span className="dm-muted">Couldn't save.</span>}
      </div>
    </Section>
  );
}

/** Small mxc:// icon thumbnail for a role label. */
function MxcIcon({ mxc }: { mxc: string }) {
  const url = useMediaUrl(mxc, { thumb: 32 });
  return url ? <img className="dm-rolelabel__mxc" src={url} alt="" /> : <span>🖼️</span>;
}

/** Exact level as the segmented value (so a custom level isn't rounded away). */
function roleValueOf(level: bigint): string {
  return String(Number(level));
}

/** Base role options, plus a preserved "Custom (N)" segment when the current
 *  level isn't one of the presets, so editing never silently rounds it. */
function roleOptionsFor(level: bigint): { value: string; label: string }[] {
  const n = Number(level);
  if (n === 0 || n === 50 || n === 100) return ROLE_OPTIONS;
  return [...ROLE_OPTIONS, { value: String(n), label: `Custom (${n})` }];
}

// --- Polls (history) --------------------------------------------------------

function PollsTab({ roomId }: { roomId: string }) {
  const session = useSession();
  const vm = useMemo(() => new PollHistoryViewModel(session, roomId), [session, roomId]);
  const state = useViewModel(vm);

  useEffect(() => {
    void vm.start();
    return () => vm.dispose();
  }, [vm]);

  if (state.loading) return <Section title="Polls"><p className="dm-muted">Loading polls…</p></Section>;
  if (state.items.length === 0)
    return <Section title="Polls"><p className="dm-muted">No polls in this room yet.</p></Section>;

  return (
    <Section title={`Polls (${state.items.length})`}>
      <div className="dm-polls">
        {state.items.map((item) => (
          <div className="dm-polls__item" key={item.id}>
            <PollView
              poll={item.poll}
              ownUserId={session.userId}
              isOwn={item.isOwn}
              onVote={(answerId) => void vm.votePoll(item.poll.startEventId, answerId)}
              onEnd={() => void vm.endPoll(item.poll.startEventId)}
            />
          </div>
        ))}
      </div>
    </Section>
  );
}

// --- Notifications ----------------------------------------------------------

function NotificationsTab({ room, roomId, loaded }: { room: RoomInterface; roomId: string; loaded: Loaded }) {
  void room;
  const session = useSession();
  const [mode, setMode] = useState<"default" | "all" | "mentions" | "off">(modeValue(loaded.notifMode));

  async function apply(v: typeof mode) {
    setMode(v);
    const ns = await session.client.getNotificationSettings();
    if (v === "default") await ns.restoreDefaultRoomNotificationMode(roomId);
    else {
      const m =
        v === "all"
          ? RoomNotificationMode.AllMessages
          : v === "mentions"
            ? RoomNotificationMode.MentionsAndKeywordsOnly
            : RoomNotificationMode.Mute;
      await ns.setRoomNotificationMode(roomId, m);
    }
  }

  return (
    <Section title="Notifications" footnote="A personal push rule for this room. Not tied to your permissions.">
      <Row
        label="Notify me for"
        control={
          <Segmented
            value={mode}
            onChange={(v) => void apply(v)}
            options={[
              { value: "default", label: "Default" },
              { value: "all", label: "All messages" },
              { value: "mentions", label: "Mentions & keywords" },
              { value: "off", label: "Off" },
            ]}
          />
        }
      />
    </Section>
  );
}

function modeValue(m: RoomNotificationMode | undefined): "default" | "all" | "mentions" | "off" {
  if (m === undefined) return "default";
  if (m === RoomNotificationMode.Mute) return "off";
  if (m === RoomNotificationMode.MentionsAndKeywordsOnly) return "mentions";
  return "all";
}

// --- Members ----------------------------------------------------------------

function MembersTab({ room }: { room: RoomInterface }) {
  const [members, setMembers] = useState<RoomMember[]>([]);
  const [invite, setInvite] = useState("");

  async function drain(): Promise<RoomMember[]> {
    const it = await room.members();
    const out: RoomMember[] = [];
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const chunk = it.nextChunk(50);
      if (!chunk || chunk.length === 0) break;
      out.push(...chunk);
      if (chunk.length < 50) break;
    }
    return out;
  }

  async function reload() {
    let out = await drain();
    // Sliding sync: the roster is empty/partial until the room's timeline has
    // fetched members from the server — otherwise "Members (0)". Fetch once and
    // re-drain (same fallback the details panel uses).
    if (out.length === 0) {
      try {
        const timeline = await room.timeline();
        await timeline.fetchMembers();
        out = await drain();
      } catch {
        /* leave empty */
      }
    }
    // `membership` is a tagged union — String(...) is "[object Object]", so the
    // old substring check dropped everyone. Match the tag (as the details panel does).
    setMembers(out.filter((m) => m.membership.tag === MembershipState_Tags.Join));
  }

  useEffect(() => {
    void reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [room]);

  return (
    <Section title={`Members (${members.length})`}>
      <Row
        label="Invite"
        control={
          <div className="dm-inline">
            <TextField value={invite} onChange={setInvite} placeholder="@user:server" />
            <Button
              disabled={!invite.startsWith("@")}
              onClick={async () => {
                await room.inviteUserById(invite.trim());
                setInvite("");
                await reload();
              }}
            >
              Invite
            </Button>
          </div>
        }
      />
      <div className="dm-members">
        {members.map((m) => (
          <div key={m.userId} className="dm-member">
            <span className="dm-member__name">{m.displayName ?? m.userId}</span>
            <span className="dm-member__id">{m.userId}</span>
            <div className="dm-member__actions">
              <Button onClick={async () => { await room.kickUser(m.userId, undefined); await reload(); }}>Kick</Button>
              <Button variant="destructive" onClick={async () => { await room.banUser(m.userId, undefined); await reload(); }}>Ban</Button>
            </div>
          </div>
        ))}
      </div>
    </Section>
  );
}

// --- Advanced ---------------------------------------------------------------

function AdvancedTab({ loaded }: { loaded: Loaded }) {
  const { info } = loaded;
  return (
    <Section title="Advanced">
      <InfoRow label={loaded.isSpace ? "Space ID" : "Room ID"} value={info.id} />
      <InfoRow label="Version" value={info.roomVersion ?? "—"} />
      <InfoRow label="Members" value={String(info.joinedMembersCount)} />
    </Section>
  );
}

function InfoRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="dm-info">
      <span className="dm-info__label">{label}</span>
      <span className="dm-info__value" onClick={(e) => { const r = document.createRange(); r.selectNodeContents(e.currentTarget); const s = window.getSelection(); s?.removeAllRanges(); s?.addRange(r); }}>{value}</span>
    </div>
  );
}
