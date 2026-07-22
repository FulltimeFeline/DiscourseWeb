// View another user's profile card. Reads the federated extended profile via
// session.fetchProfile (origin-server aware), plus MSC2666 mutual rooms and a
// Message action that opens/creates a DM. No Ignore/Block yet.

import { useEffect, useMemo, useState } from "react";
import { useApp, useSession } from "@/app/context";
import { type RoomInterface } from "@/matrix";
import type { OwnProfile } from "@/core/MatrixSession";
import { startDirectMessage } from "@/features/compose/ComposeViewModel";
import { usePresence, presenceColor, presenceDetail } from "@/core/PresenceService";
import { Modal, Button } from "@/features/settings/primitives";
import { useMediaUrl } from "@/features/settings/useMediaUrl";
import { Icon } from "@/ui/Icon";
import "./profile.css";

type Profile = Partial<OwnProfile>;

interface MutualBuckets {
  spaces: string[];
  rooms: string[];
}

export function ProfileSheet({ userId, onClose }: { userId: string; onClose: () => void }) {
  const session = useSession();
  const app = useApp();
  const isSelf = userId === session.userId;

  const [profile, setProfile] = useState<Profile | null>(null);
  const [mutual, setMutual] = useState<string[]>([]);
  const [buckets, setBuckets] = useState<MutualBuckets>({ spaces: [], rooms: [] });
  const [starting, setStarting] = useState(false);
  const [spacesOpen, setSpacesOpen] = useState(false);
  const [roomsOpen, setRoomsOpen] = useState(false);
  const presence = usePresence(session, userId);

  useEffect(() => {
    let alive = true;
    void session.fetchProfile(userId).then((p) => alive && setProfile(p ?? {}));
    void session.restGet(`_matrix/client/unstable/uk.half-shot.msc2666/user/mutual_rooms?user_id=${encodeURIComponent(userId)}`).then((r) => {
      if (alive && r && Array.isArray(r.joined)) setMutual(r.joined);
    });
    return () => {
      alive = false;
    };
  }, [session, userId]);

  // Classify mutual rooms into spaces vs non-DM rooms (DMs are excluded), for
  // the "Mutual Spaces / Mutual Rooms" split.
  useEffect(() => {
    let alive = true;
    if (mutual.length === 0) {
      setBuckets({ spaces: [], rooms: [] });
      return;
    }
    void (async () => {
      const spaces: string[] = [];
      const rooms: string[] = [];
      for (const id of mutual) {
        const room = session.getRoom(id);
        if (!room) {
          rooms.push(id);
          continue;
        }
        try {
          const info = await room.roomInfo();
          if (info.isSpace) spaces.push(id);
          else if (!info.isDirect) rooms.push(id);
        } catch {
          rooms.push(id);
        }
      }
      if (alive) setBuckets({ spaces, rooms });
    })();
    return () => {
      alive = false;
    };
  }, [mutual, session]);

  const avatarUrl = useMediaUrl(profile?.avatarUrl, { thumb: 184 });
  const bannerUrl = useMediaUrl(profile?.bannerUrl);

  const localTime = useMemo(() => formatLocalTime(profile?.timezone), [profile?.timezone]);

  async function startDm() {
    setStarting(true);
    try {
      const roomId = await startDirectMessage(session, userId);
      if (roomId) {
        app.selectRoom(roomId);
        onClose();
      }
    } finally {
      setStarting(false);
    }
  }

  const name = profile?.displayName ?? userId;

  return (
    <Modal title="Profile" onClose={onClose}>
      <div className="dm-profile">
        <div className="dm-profile__banner" style={bannerUrl ? { backgroundImage: `url(${bannerUrl})` } : undefined} />
        <div className="dm-profile__avatar" style={avatarUrl ? { backgroundImage: `url(${avatarUrl})` } : undefined}>
          {!avatarUrl && name.replace(/^@/, "").slice(0, 1).toUpperCase()}
          {presence?.state && (
            <span
              className="dm-profile__presence-dot"
              style={{ background: presenceColor(presence.state) }}
              aria-hidden
            />
          )}
        </div>

        <div className="dm-profile__head">
          <h3 className="dm-profile__name">
            {name}
            {profile?.pronouns && <span className="dm-profile__pronouns">{profile.pronouns}</span>}
          </h3>
          <code className="dm-profile__id" onClick={(e) => selectAll(e.currentTarget)}>{userId}</code>
        </div>

        {presence?.state && (
          <p className="dm-profile__presence" style={{ color: presenceColor(presence.state) }}>
            {presence.state === "online" ? "Online" : presenceDetail(presence)}
          </p>
        )}
        {(profile?.status || presence?.statusMessage) && (
          <p className="dm-profile__status">{profile?.status || presence?.statusMessage}</p>
        )}
        {localTime && (
          <p className="dm-profile__time">
            <Icon name="clock" /> {localTime}
          </p>
        )}
        {profile?.bio && <p className="dm-profile__bio">{profile.bio}</p>}

        {!!profile?.socialLinks?.length && (
          <div className="dm-profile__links">
            {profile.socialLinks.map((l, i) => (
              <SocialLinkRow key={i} link={l.link} title={l.title} img={l.img} />
            ))}
          </div>
        )}

        {buckets.spaces.length > 0 && (
          <MutualSection
            title="Mutual Spaces"
            ids={buckets.spaces}
            open={spacesOpen}
            onToggle={() => setSpacesOpen((o) => !o)}
            getRoom={session.getRoom.bind(session)}
            onOpen={(rid) => {
              app.selectSpace(rid);
              onClose();
            }}
          />
        )}
        {buckets.rooms.length > 0 && (
          <MutualSection
            title="Mutual Rooms"
            ids={buckets.rooms}
            open={roomsOpen}
            onToggle={() => setRoomsOpen((o) => !o)}
            getRoom={session.getRoom.bind(session)}
            onOpen={(rid) => {
              app.selectRoom(rid);
              onClose();
            }}
          />
        )}

        <div className="dm-profile__actions">
          {!isSelf && (
            <Button variant="primary" busy={starting} onClick={startDm}>Message</Button>
          )}
          <Button onClick={() => void navigator.clipboard?.writeText(userId)}>Copy User ID</Button>
        </div>
      </div>
    </Modal>
  );
}

function SocialLinkRow({ link, title, img }: { link: string; title: string; img?: string }) {
  // Only mxc icons are fetched; http(s) icons are intentionally not loaded (CSP).
  const mxcUrl = useMediaUrl(img?.startsWith("mxc://") ? img : undefined, { thumb: 40 });
  const unicode = img && !img.startsWith("mxc://") ? img : undefined;
  return (
    <a className="dm-profile__link" href={link} target="_blank" rel="noreferrer">
      <span className="dm-profile__link-icon" style={mxcUrl ? { backgroundImage: `url(${mxcUrl})` } : undefined}>
        {!mxcUrl && (unicode ?? <Icon name="link" />)}
      </span>
      <span>{title}</span>
    </a>
  );
}

function MutualSection({
  title,
  ids,
  open,
  onToggle,
  getRoom,
  onOpen,
}: {
  title: string;
  ids: string[];
  open: boolean;
  onToggle: () => void;
  getRoom: (id: string) => RoomInterface | undefined;
  onOpen: (id: string) => void;
}) {
  return (
    <div className="dm-profile__mutual">
      <button className="dm-profile__mutual-head" onClick={onToggle} aria-expanded={open}>
        <Icon name={open ? "chevron-down" : "chevron-right"} size={16} />
        <span>
          {title} ({ids.length})
        </span>
      </button>
      {open &&
        ids.map((rid) => (
          <MutualRoomRow key={rid} roomId={rid} getRoom={getRoom} onOpen={() => onOpen(rid)} />
        ))}
    </div>
  );
}

function MutualRoomRow({ roomId, getRoom, onOpen }: { roomId: string; getRoom: (id: string) => RoomInterface | undefined; onOpen: () => void }) {
  const [name, setName] = useState(roomId);
  useEffect(() => {
    const room = getRoom(roomId);
    if (!room) return;
    void room.roomInfo().then((i) => setName(i.displayName ?? roomId));
  }, [roomId, getRoom]);
  return (
    <button className="dm-profile__mutual-row" onClick={onOpen}>{name}</button>
  );
}


function formatLocalTime(tz?: string): string | undefined {
  if (!tz) return undefined;
  try {
    const fmt = new Intl.DateTimeFormat(undefined, { timeZone: tz, hour: "numeric", minute: "2-digit", timeZoneName: "short" });
    return `${fmt.format(new Date())} local time`;
  } catch {
    return undefined;
  }
}

function selectAll(el: HTMLElement) {
  const r = document.createRange();
  r.selectNodeContents(el);
  const s = window.getSelection();
  s?.removeAllRanges();
  s?.addRange(r);
}
