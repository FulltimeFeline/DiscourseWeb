// Room-list engine.
//
// Subscribes to `RoomListService.allRooms().entriesWithDynamicAdapters(...)`,
// applies the positional diff cases to keep an index-aligned array of FFI
// `Room`s, maps each to a value-type `RoomSummary`, and republishes an
// activity-sorted list, a debounced folded-name filter, and an unread total.
//
// Retention: every subscribe/adapter/controller/stream handle is tracked in
// `subs`; dropping any silently cancels the subscription. `dispose()` cancels
// them all.

import {
  RoomListEntriesUpdate_Tags,
  RoomListEntriesDynamicFilterKind,
  RoomListLoadingState_Tags,
  ReceiptType,
  RoomNotificationMode,
  type RoomListServiceInterface,
  type RoomListInterface,
  type RoomListEntriesWithDynamicAdaptersResultInterface,
  type RoomListDynamicEntriesControllerInterface,
  type RoomListEntriesUpdate,
  type RoomListLoadingState,
  type RoomInterface,
} from "@/matrix";
import { ViewModel } from "@/core/reactive";
import { Subscriptions } from "@/core/listeners";
import { preferences } from "@/core/Preferences";
import type { MatrixSession } from "@/core/MatrixSession";
import type { RoomSummary } from "@/models/types";
import {
  applyLatestEvent,
  applyRoomInfo,
  badgeCount,
  clearedUnread,
  foldName,
  hasAnyUnread,
  isMentioned,
  placeholderSummary,
} from "./roomSummaryMapper";

const PAGE_SIZE = 200;
const SEARCH_DEBOUNCE_MS = 150;
const FLUSH_INTERVAL_MS = 100;

export interface RoomListState {
  /** Activity-sorted, unfiltered. Filtering by space/search happens in views. */
  rooms: RoomSummary[];
  /** Invited rooms (account-level; shown everywhere). */
  invites: RoomSummary[];
  isLoaded: boolean;
  /** Restored-snapshot rows still on screen, superseded by the first real diff. */
  isCatchingUp: boolean;
  /** Raw query text (immediate). */
  searchQuery: string;
  /** Debounced, folded query used for filtering. */
  debouncedQuery: string;
  /** Sum of badgeCount across all rooms (this account's dock contribution). */
  unreadTotal: number;
  /** Transient error from a join/leave/invite action, cleared after a few seconds. */
  actionError?: string;
}

export class RoomListViewModel extends ViewModel<RoomListState> {
  private subs = new Subscriptions();

  // Index-aligned: ffiRooms[i] backs summaries.get(id at index i).
  private ffiRooms: RoomInterface[] = [];
  /** id → summary. The authoritative store; `rooms` is derived+sorted from it. */
  private summaries = new Map<string, RoomSummary>();
  private roomIndex = new Map<string, number>();
  /** Ids whose details have been loaded via refreshDetails at least once. */
  private populated = new Set<string>();

  // Retained SDK handles (must not be GC'd).
  private roomList?: RoomListInterface;
  private adapters?: RoomListEntriesWithDynamicAdaptersResultInterface;
  private controller?: RoomListDynamicEntriesControllerInterface;

  // Batched detail publication.
  private pending = new Map<string, RoomSummary>();
  private flushTimer?: ReturnType<typeof setTimeout>;
  private searchTimer?: ReturnType<typeof setTimeout>;
  private actionErrorTimer?: ReturnType<typeof setTimeout>;

  /** The room currently open on screen; its unreads are cleared locally. */
  private activeRoomId?: string;
  /**
   * Last-activity timestamp we'd read up to, per room. When a room is opened or
   * marked read we record its newest activity here. The SDK/server sometimes
   * re-reports a read room as unread on an unrelated sync (read-receipt lag,
   * especially with sliding sync), so suppress that stale unread until genuinely
   * newer message activity (a bigger timestamp) arrives. Non-message events
   * (reactions, receipts, state) never bump lastActivityTs, so they can't flip
   * a read room back to unread on their own.
   */
  private readWatermark = new Map<string, number>();
  private started = false;
  /** Called whenever unreadTotal changes (app badge aggregation). */
  onUnreadTotalChange?: (total: number) => void;

  constructor(private session: MatrixSession) {
    super({
      rooms: [],
      invites: [],
      isLoaded: false,
      isCatchingUp: false,
      searchQuery: "",
      debouncedQuery: "",
      unreadTotal: 0,
    });
    this.loadWatermarks();
  }

  // --- read watermark persistence -------------------------------------------
  // Persisted so read state survives a reload: without it, the SDK re-reports
  // rooms read in a previous session as unread until reopened (receipt lag).

  private wmKey(): string {
    return `discourse:readwm:${this.session.userId}`;
  }

  private loadWatermarks(): void {
    try {
      const raw = localStorage.getItem(this.wmKey());
      if (!raw) return;
      const obj = JSON.parse(raw) as Record<string, number>;
      for (const [id, ts] of Object.entries(obj)) {
        if (typeof ts === "number") this.readWatermark.set(id, ts);
      }
    } catch {
      /* ignore corrupt/absent storage */
    }
  }

  private wmSaveTimer?: ReturnType<typeof setTimeout>;
  private setWatermark(id: string, ts: number): void {
    this.readWatermark.set(id, ts);
    this.scheduleWatermarkSave();
  }

  private scheduleWatermarkSave(): void {
    if (this.wmSaveTimer) return;
    this.wmSaveTimer = setTimeout(() => {
      this.wmSaveTimer = undefined;
      try {
        localStorage.setItem(
          this.wmKey(),
          JSON.stringify(Object.fromEntries(this.readWatermark)),
        );
      } catch {
        /* storage full or unavailable; read state is still sticky in memory */
      }
    }, 1000);
  }

  // --- lifecycle ------------------------------------------------------------

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    const service = this.session.roomListService;
    if (!service) {
      // Sync hasn't produced a room-list service yet; retry shortly.
      this.started = false;
      setTimeout(() => void this.start(), 500);
      return;
    }
    try {
      await this.startListening(service);
    } catch {
      this.started = false;
      setTimeout(() => void this.start(), 10_000);
    }
  }

  private async startListening(service: RoomListServiceInterface): Promise<void> {
    const roomList = await service.allRooms();
    this.roomList = roomList;

    const adapters = roomList.entriesWithDynamicAdapters(PAGE_SIZE, {
      onUpdate: (updates: RoomListEntriesUpdate[]) => this.applyDiffs(updates),
    });
    this.adapters = adapters;
    const controller = adapters.controller();
    this.controller = controller;

    // Hide left rooms; after a room upgrade hide the tombstone, show replacement.
    controller.setFilter(
      new RoomListEntriesDynamicFilterKind.All({
        filters: [
          new RoomListEntriesDynamicFilterKind.NonLeft(),
          new RoomListEntriesDynamicFilterKind.DeduplicateVersions(),
        ],
      }),
    );

    // Retain the entries stream handle (dropping it detaches the listener).
    this.subs.track(adapters.entriesStream());

    const loading = roomList.loadingState({
      onUpdate: (state: RoomListLoadingState) => {
        this.setState({ isLoaded: state.tag === RoomListLoadingState_Tags.Loaded });
      },
    });
    if (loading.state.tag === RoomListLoadingState_Tags.Loaded) {
      this.setState({ isLoaded: true });
    }
    this.subs.track(loading.stateStream);
  }

  // --- diff application (positional, index-aligned) -------------------------

  private applyDiffs(updates: RoomListEntriesUpdate[]): void {
    const T = RoomListEntriesUpdate_Tags;
    let structureChanged = false;
    const touched = new Set<string>();

    for (const u of updates) {
      switch (u.tag) {
        case T.Append: {
          for (const room of u.inner.values) {
            this.pushRoom(room);
            touched.add(room.id());
          }
          structureChanged = true;
          break;
        }
        case T.Clear: {
          this.ffiRooms = [];
          this.summaries.clear();
          structureChanged = true;
          break;
        }
        case T.PushFront: {
          this.insertRoom(0, u.inner.value);
          touched.add(u.inner.value.id());
          structureChanged = true;
          break;
        }
        case T.PushBack: {
          this.pushRoom(u.inner.value);
          touched.add(u.inner.value.id());
          structureChanged = true;
          break;
        }
        case T.PopFront: {
          this.removeAt(0);
          structureChanged = true;
          break;
        }
        case T.PopBack: {
          this.removeAt(this.ffiRooms.length - 1);
          structureChanged = true;
          break;
        }
        case T.Insert: {
          this.insertRoom(u.inner.index, u.inner.value);
          touched.add(u.inner.value.id());
          structureChanged = true;
          break;
        }
        case T.Set: {
          this.setAt(u.inner.index, u.inner.value);
          touched.add(u.inner.value.id());
          structureChanged = true;
          break;
        }
        case T.Remove: {
          this.removeAt(u.inner.index);
          structureChanged = true;
          break;
        }
        case T.Truncate: {
          const len = u.inner.length;
          this.ffiRooms.length = Math.min(this.ffiRooms.length, len);
          structureChanged = true;
          break;
        }
        case T.Reset: {
          this.ffiRooms = [...u.inner.values];
          for (const room of this.ffiRooms) touched.add(room.id());
          structureChanged = true;
          break;
        }
      }
    }

    if (structureChanged) {
      // A real diff supersedes any restored-snapshot placeholders.
      if (this.state.isCatchingUp) this.setState({ isCatchingUp: false });
      // Seed placeholders for any room reset/appended in bulk so the first
      // paint has rows (details fill in via refreshDetails right after).
      for (const room of this.ffiRooms) this.ensureSummary(room.id(), room);
      this.pruneSummaries();
      this.rebuildIndex();
      this.publish();
      // Load details for rooms this batch touched or never populated; rooms
      // merely moved positionally keep their existing summary.
      for (const room of this.ffiRooms) {
        const id = room.id();
        if (touched.has(id) || !this.populated.has(id)) void this.refreshDetails(room);
      }
    }
  }

  // Structural helpers. Each mutates `ffiRooms` and seeds a placeholder summary.
  private ensureSummary(id: string, room: RoomInterface): void {
    if (!this.summaries.has(id)) {
      let name: string | undefined;
      try {
        name = room.displayName() ?? undefined;
      } catch {
        /* not yet known */
      }
      this.summaries.set(id, placeholderSummary(id, name));
    }
  }

  private pushRoom(room: RoomInterface): void {
    this.ffiRooms.push(room);
    this.ensureSummary(room.id(), room);
  }

  private insertRoom(index: number, room: RoomInterface): void {
    const i = Math.min(Math.max(index, 0), this.ffiRooms.length);
    this.ffiRooms.splice(i, 0, room);
    this.ensureSummary(room.id(), room);
  }

  private setAt(index: number, room: RoomInterface): void {
    if (index < 0 || index >= this.ffiRooms.length) {
      this.insertRoom(index, room);
      return;
    }
    this.ffiRooms[index] = room;
    // Carry over the existing populated summary by id so the row doesn't blank.
    this.ensureSummary(room.id(), room);
  }

  private removeAt(index: number): void {
    if (index < 0 || index >= this.ffiRooms.length) return;
    this.ffiRooms.splice(index, 1);
  }

  private rebuildIndex(): void {
    this.roomIndex.clear();
    this.ffiRooms.forEach((r, i) => this.roomIndex.set(r.id(), i));
  }

  /** Drop summaries whose room is no longer present in the entries array. */
  private pruneSummaries(): void {
    const live = new Set(this.ffiRooms.map((r) => r.id()));
    for (const id of [...this.summaries.keys()]) {
      if (!live.has(id)) this.summaries.delete(id);
    }
    for (const id of [...this.populated]) {
      if (!live.has(id)) this.populated.delete(id);
    }
  }

  // --- detail population (batched) ------------------------------------------

  private async refreshDetails(room: RoomInterface): Promise<void> {
    const id = room.id();
    let next = this.pending.get(id) ?? this.summaries.get(id) ?? placeholderSummary(id);
    try {
      const info = await room.roomInfo();
      next = applyRoomInfo(next, info);
    } catch {
      /* keep prior */
    }
    try {
      const latest = await room.latestEvent();
      next = applyLatestEvent(next, latest);
    } catch {
      /* keep prior */
    }
    const activity = next.lastActivityTs ?? 0;
    if (id === this.activeRoomId) {
      // Active room: clear unreads locally to avoid a flicker, and keep the
      // watermark tracking the latest activity so it stays read after you leave.
      next = clearedUnread(next);
      this.setWatermark(id, activity);
    } else {
      const wm = this.readWatermark.get(id);
      if (wm !== undefined) {
        if (activity > wm) {
          // Genuinely newer message activity: let it show as unread again.
          this.readWatermark.delete(id);
          this.scheduleWatermarkSave();
        } else {
          // Still read; suppress the SDK's stale re-reported unread.
          next = clearedUnread(next);
        }
      }
    }
    this.populated.add(id);
    this.enqueue(id, next);
  }

  private enqueue(id: string, summary: RoomSummary): void {
    const existing = this.summaries.get(id);
    if (existing && shallowSummaryEqual(existing, summary)) return; // no-op
    this.pending.set(id, summary);
    this.scheduleFlush();
  }

  private scheduleFlush(): void {
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = undefined;
      this.flushPending();
    }, FLUSH_INTERVAL_MS);
  }

  private flushPending(): void {
    if (this.pending.size === 0) return;
    for (const [id, summary] of this.pending) {
      // Only apply if the room still exists (rows may have been removed).
      if (this.summaries.has(id)) this.summaries.set(id, summary);
    }
    this.pending.clear();
    this.publish();
  }

  // --- publication ----------------------------------------------------------

  private publish(): void {
    const all = [...this.summaries.values()];
    const invites = all
      .filter((r) => r.membership === "invited")
      .sort(byActivityDesc);
    const rooms = all.sort(byActivityDesc);

    const total = all.reduce((sum, r) => sum + badgeCount(r), 0);
    if (total !== this.state.unreadTotal) this.onUnreadTotalChange?.(total);

    this.setState({ rooms, invites, unreadTotal: total });
  }

  // --- search ---------------------------------------------------------------

  setSearchQuery(query: string): void {
    this.setState({ searchQuery: query });
    if (this.searchTimer) clearTimeout(this.searchTimer);
    if (query.length === 0) {
      // Clearing is immediate (no debounce).
      this.searchTimer = undefined;
      this.setState({ debouncedQuery: "" });
      return;
    }
    const folded = foldName(query);
    this.searchTimer = setTimeout(() => {
      this.searchTimer = undefined;
      this.setState({ debouncedQuery: folded });
    }, SEARCH_DEBOUNCE_MS);
  }

  // --- read state -----------------------------------------------------------

  /** Mark the on-screen room; its unreads clear locally while it's open. */
  setActiveRoom(roomId: string | undefined): void {
    this.activeRoomId = roomId;
    if (!roomId) return;
    const cur = this.summaries.get(roomId);
    if (cur) {
      this.setWatermark(roomId, cur.lastActivityTs ?? 0);
      const cleared = clearedUnread(cur);
      if (cleared !== cur) {
        this.summaries.set(roomId, cleared);
        this.publish();
      }
    }
    // Opening a room marks it read: send the receipt server-side so it persists
    // across reloads. A purely-local clear reappeared as unread after reload and
    // let the count keep climbing.
    void this.sendReadReceipt(roomId);
  }

  private async sendReadReceipt(roomId: string): Promise<void> {
    const room = this.session.getRoom(roomId);
    if (!room) return;
    // Respect the read-receipt privacy preference: a private receipt still
    // clears YOUR unread server-side without advertising it to others.
    const type = preferences.get("sendReadReceipts")
      ? ReceiptType.Read
      : ReceiptType.ReadPrivate;
    try {
      await room.markAsRead(type);
      await room.setUnreadFlag(false);
    } catch (err) {
      console.warn("[roomlist] markAsRead failed", roomId, err);
    }
  }

  /** Mark one/many rooms read: zero local flags, then send receipts. */
  async markRead(roomIds: string[]): Promise<void> {
    let changed = false;
    for (const id of roomIds) {
      const cur = this.summaries.get(id);
      if (!cur) continue;
      this.setWatermark(id, cur.lastActivityTs ?? 0);
      const cleared = clearedUnread(cur);
      if (cleared !== cur) {
        this.summaries.set(id, cleared);
        this.pending.delete(id);
        changed = true;
      }
    }
    if (changed) this.publish();
    await Promise.all(
      roomIds.map(async (id) => {
        const room = this.session.getRoom(id);
        if (!room) return;
        try {
          await room.markAsRead(ReceiptType.Read);
          await room.setUnreadFlag(false);
        } catch {
          /* best effort */
        }
      }),
    );
  }

  // --- invites --------------------------------------------------------------

  /** Surface a transient action error in the sidebar; auto-clears after ~6s. */
  reportActionError(message: string): void {
    this.setState({ actionError: message });
    if (this.actionErrorTimer) clearTimeout(this.actionErrorTimer);
    this.actionErrorTimer = setTimeout(() => this.setState({ actionError: undefined }), 6000);
  }

  async acceptInvite(roomId: string): Promise<void> {
    const room = this.session.getRoom(roomId);
    if (!room) return;
    try {
      await room.join();
    } catch (err) {
      this.reportActionError(`Couldn't accept the invite: ${errText(err)}`);
      return;
    }
    // The diff stream flips the row to joined; refresh eagerly too.
    void this.refreshDetails(room);
  }

  async declineInvite(roomId: string): Promise<void> {
    const room = this.session.getRoom(roomId);
    if (!room) return;
    try {
      await room.leave();
    } catch (err) {
      this.reportActionError(`Couldn't decline the invite: ${errText(err)}`);
    }
  }

  async leaveRoom(roomId: string): Promise<void> {
    const room = this.session.getRoom(roomId);
    if (!room) return;
    try {
      await room.leave();
    } catch (err) {
      this.reportActionError(`Couldn't leave the room: ${errText(err)}`);
    }
  }

  /** Invite a user (by id) to a room; surfaces failures in the sidebar. */
  async inviteUser(roomId: string, userId: string): Promise<void> {
    const room = this.session.getRoom(roomId);
    if (!room) return;
    try {
      await room.inviteUserById(userId);
    } catch (err) {
      this.reportActionError(`Couldn't invite ${userId}: ${errText(err)}`);
    }
  }

  // --- context-menu actions -------------------------------------------------

  /** Toggle the m.favourite tag on a room (optimistic local flip). */
  async favourite(roomId: string, on: boolean): Promise<void> {
    this.patchSummary(roomId, { isFavourite: on });
    const room = this.session.getRoom(roomId);
    if (!room) return;
    try {
      await room.setIsFavourite(on, undefined);
    } catch {
      // Revert on failure.
      this.patchSummary(roomId, { isFavourite: !on });
    }
  }

  /**
   * Mute/unmute a room via the account notification settings. Mute maps to
   * RoomNotificationMode.Mute; unmute restores the default room mode.
   */
  async setMuted(roomId: string, muted: boolean): Promise<void> {
    this.patchSummary(roomId, { isMuted: muted });
    try {
      const settings = await this.session.client.getNotificationSettings();
      if (muted) {
        await settings.setRoomNotificationMode(roomId, RoomNotificationMode.Mute);
      } else {
        await settings.restoreDefaultRoomNotificationMode(roomId);
      }
    } catch {
      this.patchSummary(roomId, { isMuted: !muted });
    }
  }

  /** Set/clear the unread flag (mark unread). Clearing routes through markRead. */
  async markUnread(roomId: string, unread: boolean): Promise<void> {
    if (!unread) {
      await this.markRead([roomId]);
      return;
    }
    // Explicit mark-unread must stick: drop any read watermark so the sticky
    // logic doesn't clear it back on the next refresh.
    this.readWatermark.delete(roomId);
    this.scheduleWatermarkSave();
    this.patchSummary(roomId, { isMarkedUnread: true });
    const room = this.session.getRoom(roomId);
    if (!room) return;
    try {
      await room.setUnreadFlag(true);
    } catch {
      this.patchSummary(roomId, { isMarkedUnread: false });
    }
  }

  /** Shallow-merge a summary in place and republish (menu-action optimism). */
  private patchSummary(roomId: string, patch: Partial<RoomSummary>): void {
    const cur = this.summaries.get(roomId);
    if (!cur) return;
    this.summaries.set(roomId, { ...cur, ...patch });
    this.publish();
  }

  // --- accessors for views --------------------------------------------------

  summaryFor(id: string): RoomSummary | undefined {
    return this.summaries.get(id);
  }

  // --- teardown -------------------------------------------------------------

  override dispose(): void {
    if (this.flushTimer) clearTimeout(this.flushTimer);
    if (this.searchTimer) clearTimeout(this.searchTimer);
    this.subs.dispose();
    super.dispose();
  }
}

// ---------------------------------------------------------------------------

function byActivityDesc(a: RoomSummary, b: RoomSummary): number {
  return (b.lastActivityTs ?? 0) - (a.lastActivityTs ?? 0);
}

/** Cheap equality to swallow no-op detail refreshes (menu-click churn guard). */
function shallowSummaryEqual(a: RoomSummary, b: RoomSummary): boolean {
  return (
    a.name === b.name &&
    a.avatarUrl === b.avatarUrl &&
    a.isDirect === b.isDirect &&
    a.isSpace === b.isSpace &&
    a.isEncrypted === b.isEncrypted &&
    a.isMuted === b.isMuted &&
    a.isFavourite === b.isFavourite &&
    a.membership === b.membership &&
    a.unreadMessages === b.unreadMessages &&
    a.unreadNotifications === b.unreadNotifications &&
    a.unreadMentions === b.unreadMentions &&
    a.isMarkedUnread === b.isMarkedUnread &&
    a.hasActiveCall === b.hasActiveCall &&
    a.lastActivityTs === b.lastActivityTs &&
    a.preview?.body === b.preview?.body &&
    a.inviter?.displayName === b.inviter?.displayName &&
    sameArray(a.activeCallParticipants, b.activeCallParticipants)
  );
}

function sameArray(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

// Re-export the derived unread helpers so views import from one place.
export { hasAnyUnread, isMentioned, badgeCount };

/** A short, human-readable message from an unknown thrown value. */
function errText(err: unknown): string {
  if (err instanceof Error) return err.message;
  const s = String(err);
  return s.length > 120 ? s.slice(0, 117) + "…" : s;
}
