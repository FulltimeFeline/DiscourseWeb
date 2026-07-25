// Everything scoped to one signed-in account.
//
// Lean by design: it owns the FFI `Client`, the sync lifecycle, the shared
// MediaLoader, and the authenticated REST helper. A big slice of functionality
// (extended profiles, presence, ephemerals, room state, mutual rooms, space
// hierarchy) has no FFI and is manual client-server REST over `fetch`. Feature
// view models (room list, timeline, composer, ...) are built from this session
// by their own views, keeping this file free of feature imports so the feature
// layers can be developed independently.

import {
  MediaSource,
  type ClientInterface,
  type RoomInterface,
  type RoomListServiceInterface,
  type SpaceServiceInterface,
  type SyncServiceInterface,
} from "@/matrix";
import { MediaLoader } from "./MediaLoader";
import { Store } from "./reactive";
import { Subscriptions } from "./listeners";

export type SyncState = "idle" | "running" | "error" | "offline" | "terminated";

export interface OwnProfile {
  userId: string;
  displayName?: string;
  avatarUrl?: string;
  pronouns?: string;
  bio?: string;
  status?: string;
  timezone?: string;
  bannerUrl?: string;
  socialLinks: { title: string; link: string; img?: string }[];
}

export class MatrixSession {
  readonly client: ClientInterface;
  readonly userId: string;
  readonly storeId: string;
  readonly passphrase: string;
  readonly mediaLoader: MediaLoader;

  syncService?: SyncServiceInterface;
  roomListService?: RoomListServiceInterface;
  spaceService?: SpaceServiceInterface;

  readonly syncState = new Store<SyncState>("idle");
  readonly ownProfile: Store<OwnProfile>;

  /** Fired with our userId when the SDK reports the token is dead. */
  onAuthError?: (userId: string) => void;

  private subs = new Subscriptions();
  private resolvedApiBase?: string;
  private serverBaseCache = new Map<string, string>();
  private started = false;

  constructor(client: ClientInterface, storeId: string, passphrase: string) {
    this.client = client;
    this.storeId = storeId;
    this.passphrase = passphrase;
    this.userId = client.userId();
    this.mediaLoader = new MediaLoader(client);
    this.ownProfile = new Store<OwnProfile>({ userId: this.userId, socialLinks: [] });
  }

  get ownServerName(): string {
    const i = this.userId.indexOf(":");
    return i === -1 ? "" : this.userId.slice(i + 1);
  }

  // --- Sync lifecycle -------------------------------------------------------

  async startSync(): Promise<void> {
    if (this.started) return;
    this.started = true;

    // Auth-error / soft-logout signal: drop the account into re-auth.
    const delegateHandle = this.client.setDelegate({
      didReceiveAuthError: (_isSoftLogout: boolean) => {
        this.onAuthError?.(this.userId);
      },
    });
    this.subs.track(delegateHandle ?? undefined);

    // No withRoomListTimelineLimit in this SDK build; sidebar previews come
    // from per-room latestEvent() in the room-list view model instead.
    const sync = await this.client.syncService().withOfflineMode().finish();
    this.syncService = sync;
    this.roomListService = sync.roomListService();
    try {
      this.spaceService = this.client.spaceService();
    } catch {
      this.spaceService = undefined;
    }

    this.subs.track(
      sync.state({
        onUpdate: (state: unknown) => {
          this.syncState.set(normalizeSyncState(state));
        },
      }),
    );

    await sync.start();
  }

  async pauseSync(): Promise<void> {
    await this.syncService?.stop();
  }

  async resumeSync(): Promise<void> {
    if (this.syncService) await this.syncService.start();
    else await this.startSync();
  }

  async enableAllSendQueues(): Promise<void> {
    await this.client.enableAllSendQueues(true);
  }

  getRoom(roomId: string): RoomInterface | undefined {
    try {
      return this.client.getRoom(roomId) ?? undefined;
    } catch {
      return undefined;
    }
  }

  // --- Own profile ----------------------------------------------------------

  async loadOwnProfile(): Promise<void> {
    const patch: Partial<OwnProfile> = {};
    try {
      patch.avatarUrl = await this.client.avatarUrl();
    } catch {
      /* no avatar */
    }
    try {
      patch.displayName = await this.client.displayName();
    } catch {
      /* no name */
    }
    const ext = await this.fetchProfile(this.userId);
    if (ext) Object.assign(patch, ext);
    this.ownProfile.update((p) => ({ ...p, ...patch }));
  }

  // --- Authenticated client-server REST ------------------------------------
  //
  // Resolves `.well-known/matrix/client` once so delegated deployments
  // (server name != client host) work.

  async apiBase(): Promise<string | undefined> {
    if (this.resolvedApiBase) return this.resolvedApiBase;
    const hs = this.session()?.homeserverUrl;
    if (!hs) return undefined;
    this.resolvedApiBase = (await resolveClientApiBase(hs)) ?? hs;
    return this.resolvedApiBase;
  }

  /** Client-API base for another user's homeserver (cross-server profiles). */
  async serverApiBase(userId: string): Promise<string | undefined> {
    const i = userId.indexOf(":");
    if (i === -1) return this.apiBase();
    const server = userId.slice(i + 1);
    const cached = this.serverBaseCache.get(server);
    if (cached) return cached;
    const resolved = (await resolveClientApiBase(`https://${server}`)) ?? `https://${server}`;
    this.serverBaseCache.set(server, resolved);
    return resolved;
  }

  session(): { accessToken: string; homeserverUrl: string; deviceId?: string } | undefined {
    try {
      return this.client.session() as never;
    } catch {
      return undefined;
    }
  }

  private authHeaders(): Record<string, string> {
    const token = this.session()?.accessToken;
    return token ? { Authorization: `Bearer ${token}` } : {};
  }

  /** GET a client-server endpoint as JSON against our own homeserver. */
  async restGet(path: string): Promise<any | undefined> {
    const base = await this.apiBase();
    if (!base) return undefined;
    try {
      const res = await fetch(joinUrl(base, path), { headers: this.authHeaders() });
      if (!res.ok) return undefined;
      return await res.json();
    } catch {
      return undefined;
    }
  }

  /** PUT JSON to a client-server endpoint; returns true on 2xx. */
  async restPut(path: string, body: unknown): Promise<boolean> {
    const base = await this.apiBase();
    if (!base) return false;
    try {
      const res = await fetch(joinUrl(base, path), {
        method: "PUT",
        headers: { ...this.authHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      return res.ok;
    } catch {
      return false;
    }
  }

  /**
   * Files a room/space under a parent space by writing the `m.space.child`
   * state event directly. We go through REST rather than
   * `SpaceService.addChildToSpace` because the WASM binding's write path is
   * unreliable in this build. `via` MUST be non-empty for the child to count as
   * a member, so seed it from the child's own server (and ours). Returns true
   * on success.
   */
  async addSpaceChild(spaceId: string, childId: string): Promise<boolean> {
    const childServer = childId.split(":").slice(1).join(":");
    const via = [...new Set([childServer, this.ownServerName].filter(Boolean))];
    if (via.length === 0) return false;
    return this.restPut(
      `_matrix/client/v3/rooms/${encodeURIComponent(spaceId)}/state/m.space.child/${encodeURIComponent(childId)}`,
      { via },
    );
  }

  /**
   * The room's `m.room.power_levels` users map read straight from the server
   * (userId → level), so a member list reflects the true current levels rather
   * than the SDK's possibly-stale per-member state. No trailing slash.
   */
  async roomUserPowerLevels(
    roomId: string,
  ): Promise<{ users: Record<string, number>; usersDefault: number } | undefined> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const content: any = await this.restGet(
      `_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/state/m.room.power_levels`,
    );
    if (!content || typeof content !== "object") return undefined;
    const users: Record<string, number> = {};
    for (const [k, v] of Object.entries(content.users ?? {})) users[k] = Number(v);
    return { users, usersDefault: Number(content.users_default ?? 0) };
  }

  /** Removes a child from a space — empty `m.space.child` content = not a child. */
  async removeSpaceChild(spaceId: string, childId: string): Promise<boolean> {
    return this.restPut(
      `_matrix/client/v3/rooms/${encodeURIComponent(spaceId)}/state/m.space.child/${encodeURIComponent(childId)}`,
      {},
    );
  }

  /**
   * Sets a user's power level by editing the `m.room.power_levels` state event
   * directly (read-modify-write over REST). We go through REST rather than the
   * `Room.updatePowerLevelsForUsers` FFI because the WASM write path is
   * unreliable in this build — the change appeared to apply locally but never
   * reached the server, so promotions silently didn't stick. Returns true on
   * success.
   */
  async setUserPowerLevel(roomId: string, userId: string, level: number): Promise<boolean> {
    // GET must have NO trailing slash (Tuwunel returns nothing otherwise); PUT
    // keeps the trailing slash, matching the proven space-banner state write.
    const getPath = `_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/state/m.room.power_levels`;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const content: any = await this.restGet(getPath);
    if (!content || typeof content !== "object") return false;
    const users = { ...(content.users ?? {}) };
    users[userId] = level;
    return this.restPut(`${getPath}/`, { ...content, users });
  }

  /**
   * Sets one power-level threshold (the minimum level required for an action)
   * via the same REST read-modify-write. `field` is a RoomPowerLevelChanges key.
   */
  async setPowerLevelField(roomId: string, field: string, level: number): Promise<boolean> {
    const getPath = `_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/state/m.room.power_levels`;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const content: any = await this.restGet(getPath);
    if (!content || typeof content !== "object") return false;
    // Name/avatar/topic are per-event-type keys; the rest are top-level.
    const eventTypes: Record<string, string> = {
      roomName: "m.room.name",
      roomAvatar: "m.room.avatar",
      roomTopic: "m.room.topic",
    };
    const topLevel: Record<string, string> = {
      ban: "ban", invite: "invite", kick: "kick", redact: "redact",
      eventsDefault: "events_default", stateDefault: "state_default",
      usersDefault: "users_default",
    };
    if (field in eventTypes) {
      const events = { ...(content.events ?? {}) };
      events[eventTypes[field]] = level;
      return this.restPut(`${getPath}/`, { ...content, events });
    }
    const key = topLevel[field];
    if (!key) return false;
    return this.restPut(`${getPath}/`, { ...content, [key]: level });
  }

  /**
   * A user's federated profile: display name, avatar, and the Commet extended
   * fields (bio/status/banner/timezone/pronouns/social links). Reads the origin
   * homeserver directly since federation doesn't relay custom profile fields.
   */
  async fetchProfile(userId: string): Promise<Partial<OwnProfile> | undefined> {
    const base = await this.serverApiBase(userId);
    if (!base) return undefined;
    // Profiles are world-readable; only attach our token to our own server.
    const headers =
      userId.endsWith(`:${this.ownServerName}`) ? this.authHeaders() : {};
    let json: any;
    try {
      const res = await fetch(joinUrl(base, `_matrix/client/v3/profile/${encodeURIComponent(userId)}`), { headers });
      if (!res.ok) return undefined;
      json = await res.json();
    } catch {
      return undefined;
    }
    const pronounKeys = ["foxchat.pronouns", "pronouns", "io.fsky.nyx.pronouns", "m.pronouns"];
    let pronouns: string | undefined;
    for (const k of pronounKeys) {
      const raw = typeof json[k] === "string" ? json[k] : json[k]?.body;
      const v = raw?.trim();
      if (v) {
        pronouns = v;
        break;
      }
    }
    const links = Array.isArray(json["foxchat.social_links"]) ? json["foxchat.social_links"] : [];
    return {
      displayName: json.displayname,
      avatarUrl: json.avatar_url,
      pronouns,
      bio: (json["chat.commet.profile_bio"]?.body ?? json["chat.commet.profile_bio"])?.trim() || undefined,
      status: (json["chat.commet.profile_status"] ?? json.status_msg)?.trim() || undefined,
      bannerUrl: json["chat.commet.profile_banner"] || undefined,
      timezone: (json["m.tz"] ?? json["chat.commet.profile_timezone"])?.trim() || undefined,
      socialLinks: links
        .map((e: any) => ({ title: (e.title ?? e.link)?.trim(), link: e.link?.trim(), img: e.img?.trim() || undefined }))
        .filter((e: any) => e.link),
    };
  }

  /** Wrap a plain mxc URL as a MediaSource (unencrypted media). */
  mediaSourceFor(mxc: string): unknown {
    return MediaSource.fromUrl(mxc);
  }

  // --- Teardown -------------------------------------------------------------

  tearDown(): void {
    this.subs.dispose();
    this.mediaLoader.dispose();
  }

  async logOut(): Promise<void> {
    this.subs.dispose();
    try {
      await this.syncService?.stop();
    } catch {
      /* ignore */
    }
    // Flush recently-sent room keys to key backup before the store is destroyed,
    // so those messages stay recoverable on other devices. Time-bounded (8s),
    // best-effort; never block sign-out on it.
    try {
      await Promise.race([
        this.client.encryption().waitForBackupUploadSteadyState(undefined),
        new Promise<void>((resolve) => setTimeout(resolve, 8000)),
      ]);
    } catch {
      /* no backup configured / not encrypted */
    }
    try {
      await this.client.logout();
    } catch {
      /* token may already be dead */
    }
    this.mediaLoader.dispose();
  }
}

function normalizeSyncState(state: unknown): SyncState {
  const s = String((state as { tag?: string })?.tag ?? state).toLowerCase();
  if (s.includes("running")) return "running";
  if (s.includes("offline")) return "offline";
  if (s.includes("terminated")) return "terminated";
  if (s.includes("error")) return "error";
  return "idle";
}

function joinUrl(base: string, path: string): string {
  return `${base.replace(/\/$/, "")}/${path.replace(/^\//, "")}`;
}

async function resolveClientApiBase(serverUrl: string): Promise<string | undefined> {
  try {
    const res = await fetch(joinUrl(serverUrl, ".well-known/matrix/client"));
    if (!res.ok) return undefined;
    const json = await res.json();
    const hs = json["m.homeserver"]?.base_url;
    if (typeof hs !== "string") return undefined;
    return hs.replace(/\/$/, "");
  } catch {
    return undefined;
  }
}
