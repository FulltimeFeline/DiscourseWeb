// Spaces engine.
//
// Owns the top-level joined spaces (diff stream + initial fill), per-space child
// listings (paginated to completion, video rooms cross-referenced via the REST
// hierarchy), the Home/space child-id sets that drive room-list filtering, and
// the persisted rail order.
//
// SDK shapes for this build (verified against matrix_sdk_ffi.ts):
//   - SpaceService.subscribeToJoinedSpaces(listener) -> Promise<TaskHandle>
//   - SpaceService.spaceRoomList(id) is async -> Promise<SpaceRoomList>
//   - SpaceRoomList.rooms() is sync; .paginate() async; .paginationState() sync
//   - SpaceRoom.state is `Membership | undefined`; roomType is RoomType enum

import {
  SpaceListUpdate_Tags,
  SpaceRoomListPaginationState_Tags,
  Membership as FfiMembership,
  RoomType_Tags,
  StateEventType,
  type SpaceServiceInterface,
  type SpaceRoom,
  type SpaceListUpdate,
  type SpaceRoomListInterface,
} from "@/matrix";
import { ViewModel } from "@/core/reactive";
import { Subscriptions } from "@/core/listeners";
import type { MatrixSession } from "@/core/MatrixSession";
import type { SpaceSummary } from "@/models/types";
import { foldName, isVideoRoomType } from "./roomSummaryMapper";

const CHILDREN_REFRESH_COALESCE_MS = 2000;
const PAGINATION_GUARD = 200;

export interface SpaceItem {
  id: string;
  name: string;
  foldedName: string;
  avatarUrl?: string;
  topic?: string;
}

export interface SpaceChild {
  id: string;
  name: string;
  foldedName: string;
  isSpace: boolean;
  isVideoRoom: boolean;
  avatarUrl?: string;
  topic?: string;
  memberCount: number;
  isJoined: boolean;
  via: string[];
}

export interface SpacesState {
  /** SDK/positional order (index-aligned with the diff stream). */
  spaces: SpaceItem[];
  /** Display order after applying the persisted rail order. */
  orderedSpaces: SpaceItem[];
  /** Union of all rooms filed into any space (hidden from Home). */
  allSpaceChildIds: Set<string>;
  /** Bumped on any change to the children/childIds maps, so memos that read
   *  those maps recompute even when the joined-id union is unchanged (e.g. an
   *  unjoined directory child was removed). */
  childrenRev: number;
  /** Rail unread pips: space ids that contain an unread room. */
  unreadSpaceIds: Set<string>;
  homeHasUnread: boolean;
  /** Rail mention dots. */
  mentionSpaceIds: Set<string>;
  homeHasMention: boolean;
}

export class SpacesViewModel extends ViewModel<SpacesState> {
  private subs = new Subscriptions();
  private service?: SpaceServiceInterface;

  // Positional space list, kept index-aligned with the diff stream.
  private ffiSpaces: SpaceRoom[] = [];
  /** spaceId → its joined non-space child ids (drives filtering). */
  private childIds = new Map<string, Set<string>>();
  /** spaceId → full child listing (joined + unjoined, for the directory). */
  private children = new Map<string, SpaceChild[]>();
  /** spaceId → retained SpaceRoomList handle. */
  private childLists = new Map<string, SpaceRoomListInterface>();
  /** spaceId → child ids removed locally but possibly still present in the
   *  (eventually consistent) SDK list — filtered out of loadChildren until the
   *  SDK drops them. Prevents an optimistic removal from flip-flopping back. */
  private removedChildIds = new Map<string, Set<string>>();
  /** spaceId → child ids added locally but not yet in the SDK list — kept in
   *  the joined filter until the SDK catches up (so a new/added room shows
   *  under its space without a manual refresh). */
  private pendingChildIds = new Map<string, Set<string>>();

  private started = false;
  private childrenRefreshTimer?: ReturnType<typeof setTimeout>;

  constructor(private session: MatrixSession) {
    super({
      spaces: [],
      orderedSpaces: [],
      allSpaceChildIds: new Set(),
      childrenRev: 0,
      unreadSpaceIds: new Set(),
      homeHasUnread: false,
      mentionSpaceIds: new Set(),
      homeHasMention: false,
    });
  }

  // --- lifecycle ------------------------------------------------------------

  async start(): Promise<void> {
    if (this.started) return;
    const service = this.session.spaceService;
    if (!service) {
      setTimeout(() => void this.start(), 500);
      return;
    }
    this.started = true;
    this.service = service;
    try {
      // Diff subscription first so we don't miss updates between fill + subscribe.
      const handle = await service.subscribeToJoinedSpaces({
        onUpdate: (updates: SpaceListUpdate[]) => this.applySpaceDiffs(updates),
      });
      this.subs.track(handle);
      const initial = await service.joinedSpaces();
      this.ffiSpaces = [...initial];
      this.publishSpaces();
      void this.refreshAllChildren();
    } catch {
      this.started = false;
      setTimeout(() => void this.start(), 10_000);
    }
  }

  // --- space diff application (same positional diff cases) ------------------

  private applySpaceDiffs(updates: SpaceListUpdate[]): void {
    const T = SpaceListUpdate_Tags;
    for (const u of updates) {
      switch (u.tag) {
        case T.Append:
          this.ffiSpaces.push(...u.inner.values);
          break;
        case T.Clear:
          this.ffiSpaces = [];
          break;
        case T.PushFront:
          this.ffiSpaces.unshift(u.inner.value);
          break;
        case T.PushBack:
          this.ffiSpaces.push(u.inner.value);
          break;
        case T.PopFront:
          this.ffiSpaces.shift();
          break;
        case T.PopBack:
          this.ffiSpaces.pop();
          break;
        case T.Insert:
          this.ffiSpaces.splice(u.inner.index, 0, u.inner.value);
          break;
        case T.Set:
          this.ffiSpaces[u.inner.index] = u.inner.value;
          break;
        case T.Remove:
          this.ffiSpaces.splice(u.inner.index, 1);
          break;
        case T.Truncate:
          this.ffiSpaces.length = Math.min(this.ffiSpaces.length, u.inner.length);
          break;
        case T.Reset:
          this.ffiSpaces = [...u.inner.values];
          break;
      }
    }
    this.publishSpaces();
    this.scheduleChildrenRefresh();
  }

  private publishSpaces(): void {
    const spaces: SpaceItem[] = this.ffiSpaces.map((s) => ({
      id: s.roomId,
      name: s.displayName,
      foldedName: foldName(s.displayName),
      avatarUrl: s.avatarUrl ?? undefined,
      topic: s.topic ?? undefined,
    }));
    this.setState({ spaces, orderedSpaces: this.applyOrder(spaces) });
  }

  // --- rail order persistence ----------------------------------------------

  private orderKey(): string {
    return `spaceOrder:${this.session.userId}`;
  }

  private loadOrder(): string[] {
    try {
      const raw = localStorage.getItem(this.orderKey());
      return raw ? (JSON.parse(raw) as string[]) : [];
    } catch {
      return [];
    }
  }

  private applyOrder(spaces: SpaceItem[]): SpaceItem[] {
    const order = this.loadOrder();
    if (order.length === 0) return spaces;
    const rank = new Map(order.map((id, i) => [id, i]));
    // Unknown/new spaces sort to the end (stable within the group).
    return [...spaces].sort((a, b) => {
      const ra = rank.has(a.id) ? (rank.get(a.id) as number) : Number.MAX_SAFE_INTEGER;
      const rb = rank.has(b.id) ? (rank.get(b.id) as number) : Number.MAX_SAFE_INTEGER;
      return ra - rb;
    });
  }

  /** Persist a new rail order (called by drag-reorder in the rail). */
  moveSpace(orderedIds: string[]): void {
    try {
      localStorage.setItem(this.orderKey(), JSON.stringify(orderedIds));
    } catch {
      /* storage full / disabled */
    }
    this.setState({ orderedSpaces: this.applyOrder(this.state.spaces) });
  }

  // --- child listings -------------------------------------------------------

  async refreshAllChildren(): Promise<void> {
    await Promise.all(this.ffiSpaces.map((s) => this.loadChildren(s.roomId)));
    this.rebuildAllChildIds();
  }

  private scheduleChildrenRefresh(): void {
    if (this.childrenRefreshTimer) clearTimeout(this.childrenRefreshTimer);
    this.childrenRefreshTimer = setTimeout(() => {
      this.childrenRefreshTimer = undefined;
      void this.refreshAllChildren();
    }, CHILDREN_REFRESH_COALESCE_MS);
  }

  /** Load (and paginate to completion) a space's children. */
  async loadChildren(spaceId: string): Promise<SpaceChild[]> {
    const service = this.service;
    if (!service) return [];
    let list = this.childLists.get(spaceId);
    if (!list) {
      try {
        list = await service.spaceRoomList(spaceId);
      } catch {
        return this.children.get(spaceId) ?? [];
      }
      this.childLists.set(spaceId, list);
    }

    // Drive pagination to completion (guard-capped).
    for (let i = 0; i < PAGINATION_GUARD; i++) {
      const state = list.paginationState();
      if (state.tag === SpaceRoomListPaginationState_Tags.Idle) {
        if (state.inner.endReached) break;
        try {
          await list.paginate();
        } catch {
          break;
        }
      } else {
        await sleep(50);
      }
    }

    const videoIds = await this.videoRoomIds(spaceId);
    const rooms = list.rooms();
    const rawMapped: SpaceChild[] = rooms.map((r) => mapChild(r, videoIds));
    const rawIds = new Set(rawMapped.map((c) => c.id));

    // Reconcile optimistic local edits against the (eventually consistent) SDK
    // list: drop tombstones/pending markers the server has now caught up on.
    const tomb = this.removedChildIds.get(spaceId);
    if (tomb) {
      for (const id of [...tomb]) if (!rawIds.has(id)) tomb.delete(id);
      if (tomb.size === 0) this.removedChildIds.delete(spaceId);
    }
    const pend = this.pendingChildIds.get(spaceId);
    if (pend) {
      for (const id of [...pend]) if (rawIds.has(id)) pend.delete(id);
      if (pend.size === 0) this.pendingChildIds.delete(spaceId);
    }

    // Hide still-cached removed children.
    const tombNow = this.removedChildIds.get(spaceId);
    const mapped = tombNow ? rawMapped.filter((c) => !tombNow.has(c.id)) : rawMapped;
    this.children.set(spaceId, mapped);

    // Joined, non-space children drive the room-list filter for this space;
    // keep just-added rooms visible until the SDK list includes them.
    const joined = new Set(mapped.filter((c) => c.isJoined && !c.isSpace).map((c) => c.id));
    const pendNow = this.pendingChildIds.get(spaceId);
    if (pendNow) for (const id of pendNow) joined.add(id);
    this.childIds.set(spaceId, joined);
    this.bumpChildren();
    return mapped;
  }

  /** REST hierarchy call: video rooms aren't in the SDK space listing. */
  private async videoRoomIds(spaceId: string): Promise<Set<string>> {
    const ids = new Set<string>();
    try {
      const json = await this.session.restGet(
        `_matrix/client/v1/rooms/${encodeURIComponent(spaceId)}/hierarchy?limit=200`,
      );
      const rooms: any[] = json?.rooms ?? [];
      for (const r of rooms) {
        const t = r?.room_type ?? r?.["type"];
        if (isVideoRoomType(t) && r?.room_id) ids.add(r.room_id);
      }
    } catch {
      /* hierarchy unavailable */
    }
    return ids;
  }

  private rebuildAllChildIds(): void {
    const union = new Set<string>();
    for (const set of this.childIds.values()) {
      for (const id of set) union.add(id);
    }
    this.setState({ allSpaceChildIds: union });
  }

  /** Bump the reactive counter so memos reading the children/childIds maps
   *  recompute even when the joined-id union is unchanged. */
  private bumpChildren(): void {
    this.setState({ childrenRev: this.state.childrenRev + 1 });
  }

  // --- rail unread flags (stored, equality-guarded) -------------------------

  /**
   * Recompute rail unread/mention flags from the room list. Called by the shell
   * whenever the room list or child sets change. `roomFlags` supplies per-room
   * (hasAnyUnread, isMentioned, isDirect, isSpace) so this file needn't import
   * the room-list model, keeping the two engines decoupled.
   */
  recomputeUnreadFlags(
    roomFlags: {
      id: string;
      hasAnyUnread: boolean;
      isMentioned: boolean;
      isDirect: boolean;
      isSpace: boolean;
    }[],
  ): void {
    const all = this.state.allSpaceChildIds;
    const unreadSpaceIds = new Set<string>();
    const mentionSpaceIds = new Set<string>();
    let homeHasUnread = false;
    let homeHasMention = false;

    // Map room → owning spaces for the space flags.
    const roomToSpaces = new Map<string, string[]>();
    for (const [spaceId, ids] of this.childIds) {
      for (const id of ids) {
        const arr = roomToSpaces.get(id) ?? [];
        arr.push(spaceId);
        roomToSpaces.set(id, arr);
      }
    }

    for (const r of roomFlags) {
      if (r.isSpace) continue;
      const owningSpaces = roomToSpaces.get(r.id) ?? [];
      if (r.hasAnyUnread) {
        for (const s of owningSpaces) unreadSpaceIds.add(s);
      }
      if (r.isMentioned) {
        for (const s of owningSpaces) mentionSpaceIds.add(s);
      }
      // Home rooms: DMs, or rooms not filed in any space.
      const isHomeRoom = r.isDirect || !all.has(r.id);
      if (isHomeRoom) {
        if (r.hasAnyUnread) homeHasUnread = true;
        if (r.isMentioned) homeHasMention = true;
      }
    }

    // Equality-guard so the rail only re-renders when a flag flips.
    if (
      !setEqual(unreadSpaceIds, this.state.unreadSpaceIds) ||
      !setEqual(mentionSpaceIds, this.state.mentionSpaceIds) ||
      homeHasUnread !== this.state.homeHasUnread ||
      homeHasMention !== this.state.homeHasMention
    ) {
      this.setState({ unreadSpaceIds, mentionSpaceIds, homeHasUnread, homeHasMention });
    }
  }

  // --- filtering ------------------------------------------------------------

  /** Joined non-space child ids for a space, or null for Home. */
  visibleRoomIds(spaceId: string | null): Set<string> | null {
    if (spaceId == null) return null;
    return this.childIds.get(spaceId) ?? new Set();
  }

  childrenOf(spaceId: string): SpaceChild[] {
    return this.children.get(spaceId) ?? [];
  }

  childRoomIds(spaceId: string): string[] {
    return [...(this.childIds.get(spaceId) ?? [])];
  }

  /** Joined spaces that list `roomId` as a child (reverse of childIds). Used to
   *  build a "space members" restricted join rule for a room. */
  parentSpaceIds(roomId: string): string[] {
    const parents: string[] = [];
    for (const [spaceId, ids] of this.childIds) {
      if (ids.has(roomId)) parents.push(spaceId);
    }
    return parents;
  }

  // --- filing / permissions -------------------------------------------------

  async toggleRoomInSpace(roomId: string, spaceId: string): Promise<void> {
    const isMember = this.childIds.get(spaceId)?.has(roomId) ?? false;
    if (isMember) await this.removeChildFromSpace(spaceId, roomId);
    else await this.addChild(spaceId, roomId);
  }

  /** Optimistically record that `roomId` is now a child of `spaceId` (id only)
   *  and reconcile from the server. Used both by the add path and by the room
   *  creation flow (which writes `m.space.child` itself), so a new/added room
   *  shows under its space without a manual refresh. Go through the REST
   *  `m.space.child` helpers rather than SpaceService.add/removeChildToSpace —
   *  the WASM binding's write path is unreliable here. */
  noteChildAdded(spaceId: string, roomId: string): void {
    this.removedChildIds.get(spaceId)?.delete(roomId);
    const pend = this.pendingChildIds.get(spaceId) ?? new Set<string>();
    pend.add(roomId);
    this.pendingChildIds.set(spaceId, pend);
    const set = this.childIds.get(spaceId) ?? new Set<string>();
    set.add(roomId);
    this.childIds.set(spaceId, set);
    this.rebuildAllChildIds();
    this.bumpChildren();
    void this.loadChildren(spaceId);
  }

  /** File a room into a space, retried (a just-created room takes a sync to
   *  exist). Optimistic — the row appears immediately, rolls back on failure. */
  async addChild(spaceId: string, roomId: string): Promise<boolean> {
    this.noteChildAdded(spaceId, roomId);
    let ok = false;
    for (let attempt = 0; attempt < 10; attempt++) {
      if (await this.session.addSpaceChild(spaceId, roomId)) {
        ok = true;
        break;
      }
      await sleep(500);
    }
    if (!ok) {
      this.pendingChildIds.get(spaceId)?.delete(roomId);
      this.childIds.get(spaceId)?.delete(roomId);
      this.rebuildAllChildIds();
      this.bumpChildren();
    }
    return ok;
  }

  /** Remove a room from a space's listing (admin). Works for unjoined directory
   *  children too — it only writes `m.space.child` in the SPACE, so the power
   *  that governs it is over the space, not the room. Optimistic + tombstoned. */
  async removeChildFromSpace(spaceId: string, roomId: string): Promise<boolean> {
    this.pendingChildIds.get(spaceId)?.delete(roomId);
    const tomb = this.removedChildIds.get(spaceId) ?? new Set<string>();
    tomb.add(roomId);
    this.removedChildIds.set(spaceId, tomb);
    this.childIds.get(spaceId)?.delete(roomId);
    const list = this.children.get(spaceId);
    if (list) this.children.set(spaceId, list.filter((c) => c.id !== roomId));
    this.rebuildAllChildIds();
    this.bumpChildren();

    const ok = await this.session.removeSpaceChild(spaceId, roomId);
    if (!ok) tomb.delete(roomId); // failed → it's still a child; let reload restore it
    void this.loadChildren(spaceId);
    return ok;
  }

  // Async permission checks (fail-closed). Callers prime a cache the menus read;
  // there is no synchronous power-level API, so menu items stay hidden until a
  // check resolves true.
  /** The space banner mxc (Commet `page.codeberg.everypizza.room.banner` state). */
  async spaceBannerURL(spaceId: string): Promise<string | undefined> {
    try {
      const content = await this.session.restGet(
        `_matrix/client/v3/rooms/${encodeURIComponent(spaceId)}/state/page.codeberg.everypizza.room.banner`,
      );
      const url = content?.url;
      return typeof url === "string" && url.startsWith("mxc://") ? url : undefined;
    } catch {
      return undefined;
    }
  }

  /** Whether the current user may edit the space banner (proxied by the avatar
   *  state-event permission, since the banner is a custom state event). */
  async canEditSpaceBanner(spaceId: string): Promise<boolean> {
    const room = this.session.getRoom(spaceId);
    if (!room) return false;
    try {
      return (await room.getPowerLevels()).canOwnUserSendState(StateEventType.RoomAvatar);
    } catch {
      return false;
    }
  }

  /** Upload + set the space banner. Returns the new mxc, or undefined on failure. */
  async setSpaceBanner(spaceId: string, data: ArrayBuffer, mimeType: string): Promise<string | undefined> {
    try {
      const mxc = await this.session.client.uploadMedia(mimeType, data, undefined);
      const ok = await this.session.restPut(
        `_matrix/client/v3/rooms/${encodeURIComponent(spaceId)}/state/page.codeberg.everypizza.room.banner/`,
        { url: mxc, mimetype: mimeType },
      );
      return ok ? mxc : undefined;
    } catch {
      return undefined;
    }
  }

  /** Clear the space banner (empty state content). */
  async removeSpaceBanner(spaceId: string): Promise<boolean> {
    return this.session.restPut(
      `_matrix/client/v3/rooms/${encodeURIComponent(spaceId)}/state/page.codeberg.everypizza.room.banner/`,
      {},
    );
  }

  async checkCanInvite(roomId: string): Promise<boolean> {
    const room = this.session.getRoom(roomId);
    if (!room) return false;
    try {
      const pl = await room.getPowerLevels();
      return pl.canOwnUserInvite();
    } catch {
      return false;
    }
  }

  async checkCanManageSpace(spaceId: string): Promise<boolean> {
    const room = this.session.getRoom(spaceId);
    if (!room) return false;
    try {
      const pl = await room.getPowerLevels();
      return pl.canOwnUserSendState(StateEventType.SpaceChild);
    } catch {
      return false;
    }
  }

  async checkCanMoveRoom(roomId: string): Promise<boolean> {
    const room = this.session.getRoom(roomId);
    if (!room) return false;
    try {
      const pl = await room.getPowerLevels();
      return pl.canOwnUserSendState(StateEventType.SpaceParent);
    } catch {
      return false;
    }
  }

  // --- joining unjoined space children --------------------------------------

  async joinChild(child: SpaceChild): Promise<string | undefined> {
    try {
      const room = await this.session.client.joinRoomByIdOrAlias(child.id, child.via);
      // Reload the space listings so the row flips to joined.
      void this.refreshAllChildren();
      return room.id();
    } catch {
      return undefined;
    }
  }

  // --- leaving --------------------------------------------------------------

  async leaveSpace(spaceId: string): Promise<void> {
    const room = this.session.getRoom(spaceId);
    if (!room) return;
    await room.leave();
  }

  // --- teardown -------------------------------------------------------------

  override dispose(): void {
    if (this.childrenRefreshTimer) clearTimeout(this.childrenRefreshTimer);
    this.subs.dispose();
    super.dispose();
  }
}

// ---------------------------------------------------------------------------

function mapChild(r: SpaceRoom, videoIds: Set<string>): SpaceChild {
  const isSpace = r.roomType.tag === RoomType_Tags.Space;
  const customType =
    r.roomType.tag === RoomType_Tags.Custom
      ? (r.roomType as { inner: { value: string } }).inner.value
      : undefined;
  const isVideoRoom = isVideoRoomType(customType) || videoIds.has(r.roomId);
  return {
    id: r.roomId,
    name: r.displayName,
    foldedName: foldName(r.displayName),
    isSpace,
    isVideoRoom,
    avatarUrl: r.avatarUrl ?? undefined,
    topic: r.topic ?? undefined,
    memberCount: Number(r.numJoinedMembers),
    isJoined: r.state === FfiMembership.Joined,
    via: r.via,
  };
}

function setEqual(a: Set<string>, b: Set<string>): boolean {
  if (a.size !== b.size) return false;
  for (const v of a) if (!b.has(v)) return false;
  return true;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
