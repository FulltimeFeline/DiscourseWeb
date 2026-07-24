// The timeline's lifecycle and state engine. Owns the FFI `Timeline`, applies
// the 11-case TimelineDiff algebra to an ordered `TimelineEntry[]`, and drives
// pagination, receipts, typing, and lazy per-row shield/reply-detail work.
//
// Critical invariants:
//  - The diff-listener TaskHandle must be retained or the subscription is
//    silently cancelled. It's kept in `subs` for the lifetime of the timeline.
//  - The entry array stays index-aligned 1:1 with the SDK's items (hidden items
//    included), so positional diffs remain valid.
//  - Shields are fetched lazily per visible row, never during mapping.
//  - Read-receipt placement uses explicit `/sync`-polled positions, not the
//    timeline item's own (mis-placed) receipts.

import {
  AssetType,
  DateDividerMode,
  EncryptionState,
  EventOrTransactionId,
  PollKind,
  ReceiptType,
  TimelineConfiguration,
  TimelineFilter,
  TimelineFocus,
  type RoomInterface,
  type RoomInfo,
  type TaskHandleInterface,
  type TimelineDiff,
  type TimelineInterface,
  type TimelineItemInterface,
} from "@/matrix";
import { TimelineDiff_Tags } from "@/matrix";
import { ViewModel } from "@/core/reactive";
import { Subscriptions, disposeHandle } from "@/core/listeners";
import { preferences } from "@/core/Preferences";
import type { MatrixSession } from "@/core/MatrixSession";
import type { EventEntry, TimelineEntry, VirtualEntry } from "@/models/types";
import {
  isHiddenEntry,
  mapTimelineItem,
  shieldForEvent,
  type MapContext,
} from "./timelineEntryMapper";

export type TimelineMode =
  | { type: "live" }
  | { type: "thread"; rootEventId: string }
  | { type: "media" };

interface TimelineState {
  entries: TimelineEntry[];
  /** The filtered render list (no hidden/placeholder rows). What the view maps. */
  visibleItems: TimelineEntry[];
  /** Virtuoso firstItemIndex, tracked alongside the items. */
  firstItemIndex: number;
  reachedStart: boolean;
  isPaginating: boolean;
  typingUsers: string[];
  roomName: string;
  topic?: string;
  isEncrypted: boolean;
  hasActiveCall: boolean;
  callParticipantCount: number;
  memberCount: number;
  /** Redact permissions for the current user (moderator delete). */
  canRedactOwn: boolean;
  canRedactOther: boolean;
  /** True once the initial window (+ small buffer) has loaded; gates the list. */
  initialLoadComplete: boolean;
  /** Set when creating the SDK timeline failed; the view offers a retry. */
  loadFailed?: boolean;
  /** id of the read-marker entry while the "NEW" divider should show. */
  unreadMarkerId?: string;
}

const PAGE_SIZE = 50;
// Virtuoso firstItemIndex base, decremented as older messages are prepended so
// the scroll position is maintained (per react-virtuoso docs; must stay > 0).
const FIRST_INDEX_BASE = 1_000_000;
const MAX_BACKOFF_MS = 30_000;

export class TimelineViewModel extends ViewModel<TimelineState> {
  private timeline?: TimelineInterface;
  private subs = new Subscriptions();
  private listenerHandle?: TaskHandleInterface;

  // Keep the raw FFI items index-aligned with `entries` for lazy per-row work
  // (shields) that needs the live item, not the value snapshot.
  private items: TimelineItemInterface[] = [];

  private startPromise?: Promise<void>;
  private disposed = false;
  private parked = false;

  // Pagination
  private paginateBackoffMs = 1000;
  private paginationLoopActive = false;

  // Receipts (explicit-poll correction)
  private explicitReceipts = new Map<string, string>(); // userId → eventId
  private ephemeralSince?: string;
  private ephemeralActive = false;
  private lastOwnMessageId?: string;

  // Read-marker auto-dismiss
  private dismissedMarkerId?: string;
  private markerDismissTimer?: ReturnType<typeof setTimeout>;

  // Typing expiry
  private typingExpiryTimer?: ReturnType<typeof setTimeout>;

  // markAsRead debounce (per newest eventId)
  private lastMarkedEventId?: string;

  // Anchor id for firstItemIndex tracking (a stable item whose position we track
  // across prepends; see setEntries).
  private firstItemId?: string;
  // The base the anchor offsets from. Rebased downward when the anchor is lost
  // (reset with no shared ids), so the published firstItemIndex never increases
  // within a mount — react-virtuoso only supports decreases (prepends).
  private firstIndexBase = FIRST_INDEX_BASE;

  // Lazy shield fetch bookkeeping
  private shieldsRequested = new Set<string>();

  // Lazy reply-detail fetch bookkeeping
  private replyDetailsFetched = new Set<string>();

  constructor(
    private session: MatrixSession,
    private room: RoomInterface,
    private roomId: string,
    private mode: TimelineMode = { type: "live" },
  ) {
    super({
      entries: [],
      visibleItems: [],
      firstItemIndex: FIRST_INDEX_BASE,
      reachedStart: false,
      isPaginating: false,
      typingUsers: [],
      roomName: safe(() => room.displayName()) ?? roomId,
      topic: safe(() => room.topic()) ?? undefined,
      isEncrypted: false,
      hasActiveCall: false,
      callParticipantCount: 0,
      canRedactOwn: true,
      canRedactOther: false,
      memberCount: 0,
      initialLoadComplete: false,
    });
  }

  /** The live SDK timeline (thread- or room-focused), once started. */
  getTimeline(): TimelineInterface | undefined {
    return this.timeline;
  }

  private get ctx(): MapContext {
    const own = this.session.ownProfile.value;
    return { ownUserId: this.session.userId, ownDisplayName: own.displayName, ownAvatarUrl: own.avatarUrl };
  }

  // --- lifecycle -----------------------------------------------------------

  /** Idempotent; dedupes concurrent callers. */
  async start(): Promise<void> {
    if (this.timeline) return;
    if (this.startPromise) return this.startPromise;
    this.startPromise = this.performStart();
    try {
      await this.startPromise;
    } finally {
      this.startPromise = undefined;
    }
  }

  private async performStart(): Promise<void> {
    if (this.disposed) return;
    if (this.state.loadFailed) this.setState({ loadFailed: false });

    // Create the timeline and attach the listener first. This delivers the
    // room's already-synced (cached) events immediately, so the room opens
    // near-instant; the open does not block on the network room-subscribe.
    const config = this.buildConfig();
    let timeline: TimelineInterface;
    try {
      timeline = await this.room.timelineWithConfiguration(config);
    } catch (err) {
      console.error("[timeline] timelineWithConfiguration failed", this.roomId, err);
      this.setState({ loadFailed: true, initialLoadComplete: true });
      return;
    }
    if (this.disposed) return;
    this.timeline = timeline;

    await this.attachTimelineListener();

    if (this.mode.type === "live") {
      this.attachTypingListener();
      this.attachRoomInfoListener();
      void safeAsync(() => this.room.roomInfo()).then((info) => info && this.applyRoomInfo(info));
      void safeAsync(() => this.room.getPowerLevels()).then((pl) => {
        if (pl && !this.disposed) {
          this.setState({
            canRedactOwn: pl.canOwnUserRedactOwn(),
            canRedactOther: pl.canOwnUserRedactOther(),
          });
        }
      });
      this.startEphemeralSync();
      void this.markAsRead();
      // Subscribe to the room in the background. Sliding sync fully populates
      // and live-streams a subscribed room, but the cached window is already on
      // screen, so this must not block the open.
      void (async () => {
        if (this.disposed) return;
        const ok = await this.subscribeToRoom();
        if (!ok && !this.disposed) await this.subscribeToRoom();
      })();
    }

    // Ensure at least a first page is present (paginate only if the cached
    // window came back empty), then reveal the list.
    void this.ensureInitialContent();
  }

  private async subscribeToRoom(): Promise<boolean> {
    const service = this.session.roomListService;
    if (!service) return false;
    try {
      await service.subscribeToRooms([this.roomId]);
      return true;
    } catch (err) {
      console.warn("[timeline] subscribeToRooms threw", this.roomId, err);
      return false;
    }
  }

  /**
   * Guarantee the timeline has content on open. The initial reset can land
   * empty (sliding sync hasn't delivered events for a freshly-subscribed room
   * yet), so pull back-pages until there are some entries or the start is hit,
   * retrying a few times to give the subscription time to stream events in.
   */
  private async ensureInitialContent(): Promise<void> {
    // Reveal the room as soon as the first window of messages is available (fast
    // open at the bottom). No bulk preload: that made opening slow and, when
    // prepended at the bottom, jumped the scroll. Older history loads on
    // scroll-up (startReached), where firstItemIndex keeps the position.
    for (let attempt = 0; attempt < 24; attempt++) {
      if (this.disposed || this.parked) break;
      if (this.hasRenderableContent() || this.state.reachedStart) break;
      await this.paginateBackwards();
      if (this.hasRenderableContent() || this.state.reachedStart) break;
      await delay(500);
    }
    if (!this.state.initialLoadComplete) {
      this.setState({ initialLoadComplete: true });
    }
  }

  private hasRenderableContent(): boolean {
    return this.state.entries.some((e) => e.kind === "event");
  }

  private buildConfig(): TimelineConfiguration {
    let focus: TimelineFocus;
    let filter: TimelineFilter;
    let internalIdPrefix: string | undefined;

    switch (this.mode.type) {
      case "thread":
        focus = new TimelineFocus.Thread({ rootEventId: this.mode.rootEventId });
        filter = new TimelineFilter.All();
        internalIdPrefix = "thread";
        break;
      case "media":
        focus = new TimelineFocus.Live({ hideThreadedEvents: false });
        filter = new TimelineFilter.All();
        internalIdPrefix = "media";
        break;
      case "live":
      default:
        focus = new TimelineFocus.Live({ hideThreadedEvents: true });
        filter = new TimelineFilter.All();
        internalIdPrefix = undefined;
        break;
    }

    return {
      focus,
      filter,
      internalIdPrefix,
      dateDividerMode: DateDividerMode.Daily,
      trackReadReceipts: this.mode.type === "live",
      reportUtds: false,
    };
  }

  private async attachTimelineListener(): Promise<void> {
    if (!this.timeline) return;
    // The initial state is replayed as a `.reset` diff.
    const handle = await this.timeline.addListener({
      onUpdate: (diffs: Array<TimelineDiff>) => {
        // The wasm SDK dispatches callbacks on the JS thread; apply inline so
        // successive diff batches keep their ordering.
        this.apply(diffs);
      },
    });
    // Bail if the VM was disposed OR re-parked while addListener was awaiting:
    // otherwise a fast park→unpark→park (or dispose) race could re-attach a live
    // listener onto a VM that should be dormant. This matters now that view
    // models are cached and parked/unparked across room switches.
    if (this.disposed || this.parked) {
      disposeHandle(handle);
      return;
    }
    this.listenerHandle = handle;
    this.subs.track(handle); // retained, else the subscription detaches
  }

  private attachTypingListener(): void {
    const handle = this.room.subscribeToTypingNotifications({
      call: (userIds: Array<string>) => {
        this.setTypingUsers(userIds, 10_000);
      },
    });
    this.subs.track(handle);
  }

  private attachRoomInfoListener(): void {
    const handle = this.room.subscribeToRoomInfoUpdates({
      call: (info: RoomInfo) => this.applyRoomInfo(info),
    });
    this.subs.track(handle);
  }

  private applyRoomInfo(info: RoomInfo): void {
    this.setState({
      roomName: info.displayName ?? this.state.roomName,
      topic: info.topic ?? undefined,
      isEncrypted: info.encryptionState === EncryptionState.Encrypted,
      hasActiveCall: info.hasRoomCall,
      callParticipantCount: info.activeRoomCallParticipants.length,
      memberCount: Number(info.joinedMembersCount),
    });
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.stopEphemeralSync();
    if (this.markerDismissTimer) clearTimeout(this.markerDismissTimer);
    if (this.typingExpiryTimer) clearTimeout(this.typingExpiryTimer);
    this.subs.dispose();
    this.listenerHandle = undefined;
    this.items = [];
    this.timeline = undefined;
    super.dispose();
  }

  // --- parking (memory shedding on route-away) -----------------------------

  park(): void {
    if (this.parked || this.mode.type !== "live") return;
    this.parked = true;
    this.stopEphemeralSync();
    // Detach the diff listener so offscreen rooms stop mutating.
    disposeHandle(this.listenerHandle);
    this.listenerHandle = undefined;
    // Truncate to a tail to shed memory; reopen pagination.
    const tail = 200;
    if (this.items.length > tail) {
      this.items = this.items.slice(-tail);
      this.setEntries(this.state.entries.slice(-tail), { reachedStart: false });
    }
  }

  async unpark(): Promise<void> {
    if (!this.parked) return;
    this.parked = false;
    if (!this.timeline) return;
    await this.attachTimelineListener(); // the initial reset rebuilds the full list
    this.startEphemeralSync();
  }

  get isParked(): boolean {
    return this.parked;
  }

  get isDisposed(): boolean {
    return this.disposed;
  }

  // --- diff application (the 11-case algebra) ------------------------------

  private apply(diffs: Array<TimelineDiff>): void {
    if (this.disposed) return;
    try {
      this.applyInner(diffs);
    } catch (err) {
      // A diff batch must never silently no-op; that's how a room opens blank.
      // Surface it and keep the (already partially-applied) state so the next
      // batch can recover instead of the timeline staying empty forever.
      console.error("[timeline] failed to apply diff batch", this.roomId, err);
    }
  }

  private applyInner(diffs: Array<TimelineDiff>): void {
    let entries = this.state.entries.slice();
    const items = this.items;
    let appendedAtBottom = false;
    let shrunk = false;

    for (const diff of diffs) {
      switch (diff.tag) {
        case TimelineDiff_Tags.Append: {
          for (const value of diff.inner.values) {
            items.push(value);
            entries.push(this.mapItem(value));
          }
          appendedAtBottom = true;
          break;
        }
        case TimelineDiff_Tags.PushBack: {
          items.push(diff.inner.value);
          entries.push(this.mapItem(diff.inner.value));
          appendedAtBottom = true;
          break;
        }
        case TimelineDiff_Tags.PushFront: {
          items.unshift(diff.inner.value);
          entries.unshift(this.mapItem(diff.inner.value));
          break;
        }
        case TimelineDiff_Tags.PopFront: {
          items.shift();
          entries.shift();
          break;
        }
        case TimelineDiff_Tags.PopBack: {
          items.pop();
          entries.pop();
          break;
        }
        case TimelineDiff_Tags.Insert: {
          const { index, value } = diff.inner;
          items.splice(index, 0, value);
          entries.splice(index, 0, this.mapItem(value));
          break;
        }
        case TimelineDiff_Tags.Set: {
          const { index, value } = diff.inner;
          items[index] = value;
          entries[index] = this.mapItem(value);
          // Re-arm lazy work for this event (verification or shape may have changed).
          this.rearmLazy(entries[index]);
          break;
        }
        case TimelineDiff_Tags.Remove: {
          const { index } = diff.inner;
          items.splice(index, 1);
          entries.splice(index, 1);
          break;
        }
        case TimelineDiff_Tags.Truncate: {
          const { length } = diff.inner;
          items.length = length;
          entries = entries.slice(0, length);
          shrunk = true;
          break;
        }
        case TimelineDiff_Tags.Clear: {
          items.length = 0;
          entries = [];
          shrunk = true;
          break;
        }
        case TimelineDiff_Tags.Reset: {
          const prevLen = entries.length;
          items.length = 0;
          entries = [];
          for (const value of diff.inner.values) {
            items.push(value);
            entries.push(this.mapItem(value));
          }
          if (entries.length < prevLen) shrunk = true;
          this.shieldsRequested.clear();
          this.replyDetailsFetched.clear();
          break;
        }
      }
    }

    this.regroup(entries);

    // Reopen pagination on shrink; clear/reset also cleared entries.
    const reachedStart = shrunk ? false : this.state.reachedStart;

    // Post-batch bookkeeping.
    this.updateLastOwnMessageId(entries);
    this.applyExplicitReceipts(entries);
    const unreadMarkerId = this.computeUnreadMarker(entries);

    this.setEntries(entries, { reachedStart, unreadMarkerId });
    this.fetchPendingReplyDetails(entries);

    if (appendedAtBottom) {
      // The view decides whether to auto-scroll; mark read when at bottom.
      // markAsRead gating on !parked and live happens inside.
      void this.maybeMarkReadOnAppend(entries);
    }
  }

  private mapItem(item: TimelineItemInterface): TimelineEntry {
    // The mapper reaches across the wasm FFI boundary (uniqueId/asEvent/content/
    // …), any of which can throw for an unexpected item shape. A single throw
    // here used to abort the whole Reset/Append batch, which is why opening a
    // room "almost never" showed messages: one bad item in the initial ~50-item
    // reset blanked the entire timeline. Degrade a bad item to a placeholder
    // slot so the rest of the batch still renders, and keep index alignment with
    // the SDK's item list intact (positional diffs depend on it).
    try {
      return mapTimelineItem(item, this.ctx);
    } catch (err) {
      console.warn("[timeline] failed to map timeline item; using placeholder", this.roomId, err);
      return this.placeholderEntry(item);
    }
  }

  /**
   * A render-nothing entry that still occupies an array slot so the SDK's
   * positional diffs stay index-aligned. It carries an unknown virtual `type`,
   * so the view's virtual-row switch falls through to its `null` default and
   * grouping/unread logic (which only match `readMarker`/event kinds) ignore it.
   */
  private placeholderEntry(item: TimelineItemInterface): TimelineEntry {
    let id: string;
    try {
      id = item.uniqueId().id;
    } catch {
      id = `placeholder-${Math.random().toString(36).slice(2)}`;
    }
    const virtual = { type: "unmappable" } as unknown as VirtualEntry["virtual"];
    return { kind: "virtual", id, virtual };
  }

  // --- sender grouping -----------------------------------------------------
  //
  // A message shows its header unless it directly follows another message from
  // the same sender within the grouping window. Any non-message entry breaks
  // the group. We compute `showsHeader` and stash it on the entry (extra field
  // ignored by the type contract but read by the view).

  /**
   * The single choke-point for publishing entries. Computes the filtered render
   * list and firstItemIndex atomically: track an anchor item id and set
   * firstItemIndex = BASE - (its index in the new list), so Virtuoso keeps the
   * scroll position when older messages are prepended. Doing this in the VM (not
   * the view) is what makes it non-jumpy.
   */
  private setEntries(entries: TimelineEntry[], extra?: Partial<TimelineState>): void {
    const visibleItems = entries.filter(
      (e) =>
        !isHiddenEntry(e) &&
        (e.kind === "event" ||
          e.virtual.type === "dateDivider" ||
          e.virtual.type === "readMarker" ||
          e.virtual.type === "timelineStart"),
    );
    let firstItemIndex = this.firstIndexBase;
    if (this.firstItemId !== undefined) {
      const found = visibleItems.findIndex((e) => e.id === this.firstItemId);
      if (found > 0) firstItemIndex = this.firstIndexBase - found;
      else if (found < 0) {
        // Anchor gone (reset): rebase to the currently-published index so the
        // next value can only stay equal or decrease.
        this.firstIndexBase = this.state.firstItemIndex;
        firstItemIndex = this.firstIndexBase;
        this.firstItemId = visibleItems[0]?.id;
      }
      // found === 0 means the anchor is still first (no prepend); keep base.
    } else {
      this.firstItemId = visibleItems[0]?.id;
    }
    this.setState({ entries, visibleItems, firstItemIndex, ...extra } as Partial<TimelineState>);
  }

  private regroup(entries: TimelineEntry[]): void {
    const windowMs = preferences.get("groupingWindowMinutes") * 60_000;
    let prev: EventEntry | null = null;
    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i];
      if (entry.kind !== "event" || isHiddenEntry(entry)) {
        prev = null;
        continue;
      }
      // System/state rows (non-message content) break grouping too.
      const isMessage = isRenderedMessage(entry);
      const shows = isMessage
        ? !(prev != null && prev.sender === entry.sender && entry.timestamp - prev.timestamp <= windowMs)
        : true;
      // Only write when it changes; swap in a fresh object so memoized rows
      // re-render on the identity change while untouched rows keep identity.
      if ((entry as WithHeader).showsHeader !== shows) {
        entries[i] = Object.assign({}, entry, { showsHeader: shows } as WithHeader) as EventEntry;
      }
      prev = isMessage ? (entries[i] as EventEntry) : null;
    }
  }

  // --- pagination ----------------------------------------------------------

  /** Back-paginate until an event is loaded (or the start is hit). Returns true
   *  if the event is now present. Powers permalink/notification/reply jumps to
   *  messages that aren't in the loaded window yet. */
  async ensureLoaded(eventId: string): Promise<boolean> {
    const has = () =>
      this.state.entries.some((e) => e.kind === "event" && e.eventId === eventId);
    if (has()) return true;
    for (let i = 0; i < 40; i++) {
      if (this.disposed || this.state.reachedStart) break;
      if (this.state.isPaginating) {
        await delay(150); // a view-driven page is in flight; let it land
        if (has()) return true;
        continue;
      }
      await this.paginateBackwards();
      if (has()) return true;
    }
    return has();
  }

  /**
   * Drive back-pagination. Called on start and repeatedly by the view while the
   * top sentinel is visible. Reentrancy-guarded, with exponential backoff on
   * failure.
   */
  async paginateBackwards(): Promise<void> {
    if (!this.timeline || this.disposed || this.parked) return;
    if (this.state.isPaginating || this.state.reachedStart) return;
    this.setState({ isPaginating: true });
    try {
      const reachedStart = await this.timeline.paginateBackwards(PAGE_SIZE);
      this.paginateBackoffMs = 1000; // reset backoff on success
      this.setState({ reachedStart, isPaginating: false });
    } catch (err) {
      console.warn("[timeline] paginateBackwards failed", this.roomId, err);
      this.setState({ isPaginating: false });
      // Exponential backoff (offline). The view's loop will retry.
      await delay(this.paginateBackoffMs);
      this.paginateBackoffMs = Math.min(this.paginateBackoffMs * 2, MAX_BACKOFF_MS);
    }
  }

  /**
   * A polling loop the view starts while the top sentinel is visible. Loops
   * every ~1s (not tied to entry count, which changes every diff).
   */
  startPaginationLoop(): void {
    if (this.paginationLoopActive) return;
    this.paginationLoopActive = true;
    const tick = async () => {
      if (!this.paginationLoopActive || this.disposed) return;
      await this.paginateBackwards();
      if (this.paginationLoopActive && !this.state.reachedStart) {
        setTimeout(tick, 1000);
      } else {
        this.paginationLoopActive = false;
      }
    };
    void tick();
  }

  stopPaginationLoop(): void {
    this.paginationLoopActive = false;
  }

  // --- reactions / redaction / send actions --------------------------------

  async toggleReaction(entry: EventEntry, key: string): Promise<void> {
    if (!this.timeline) return;
    const itemId = this.eventOrTxId(entry);
    if (!itemId) return;
    await safeAsync(() => this.timeline!.toggleReaction(itemId, key));
  }

  async redactEvent(entry: EventEntry, reason?: string): Promise<void> {
    if (!this.timeline) return;
    const itemId = this.eventOrTxId(entry);
    if (!itemId) return;
    await safeAsync(() => this.timeline!.redactEvent(itemId, reason ?? undefined));
  }

  /** Retry failed sends by re-enabling the room's send queue (SDK disables it on failure). */
  retrySend(): void {
    try {
      this.room.enableSendQueue(true);
    } catch {
      /* best effort */
    }
  }

  /** Report an event to the server moderators (does NOT redact it). */
  async report(entry: EventEntry, reason?: string): Promise<boolean> {
    if (!entry.eventId) return false;
    return (
      (await safeAsync(() =>
        this.room.reportContent(entry.eventId!, undefined, reason ?? undefined),
      )) !== undefined
    );
  }

  /** Newest own, editable (text) message, for the composer's up-to-edit. */
  lastOwnEditableMessage(): EventEntry | undefined {
    const entries = this.state.entries;
    for (let i = entries.length - 1; i >= 0; i--) {
      const e = entries[i];
      if (e.kind !== "event") continue;
      if (e.isOwn && e.eventId && e.content.type === "text") return e;
    }
    return undefined;
  }

  /** Cast (or change) this account's vote on a poll. */
  async votePoll(pollStartEventId: string, answerId: string): Promise<void> {
    if (!this.timeline) return;
    await safeAsync(() => this.timeline!.sendPollResponse(pollStartEventId, [answerId]));
  }

  /** End a poll you started, revealing the final tally. */
  async endPoll(pollStartEventId: string, text = "The poll has ended."): Promise<void> {
    if (!this.timeline) return;
    await safeAsync(() => this.timeline!.endPoll(pollStartEventId, text));
  }

  /** Create + send a poll to this room. */
  async createPoll(
    question: string,
    answers: string[],
    kind: "disclosed" | "undisclosed",
  ): Promise<void> {
    if (!this.timeline) return;
    const pollKind = kind === "undisclosed" ? PollKind.Undisclosed : PollKind.Disclosed;
    await safeAsync(() => this.timeline!.createPoll(question, answers, 1, pollKind));
  }

  /** Share the device's current location as a map pin. Resolves false if denied. */
  async shareLocation(): Promise<boolean> {
    if (!this.timeline || !navigator.geolocation) return false;
    const pos = await new Promise<GeolocationPosition | undefined>((resolve) =>
      navigator.geolocation.getCurrentPosition(
        (p) => resolve(p),
        () => resolve(undefined),
        { enableHighAccuracy: true, timeout: 10_000 },
      ),
    );
    if (!pos) return false;
    const { latitude, longitude } = pos.coords;
    const geoUri = `geo:${latitude},${longitude}`;
    await safeAsync(() =>
      this.timeline!.sendLocation("Shared location", geoUri, undefined, undefined, AssetType.Sender, undefined),
    );
    return true;
  }

  private eventOrTxId(entry: EventEntry): EventOrTransactionId | undefined {
    if (entry.eventId) return new EventOrTransactionId.EventId({ eventId: entry.eventId });
    if (entry.transactionId) return new EventOrTransactionId.TransactionId({ transactionId: entry.transactionId });
    return undefined;
  }

  // --- read receipts / markAsRead ------------------------------------------

  async markAsRead(): Promise<void> {
    if (this.mode.type !== "live") return;
    const newest = this.newestEventId();
    if (newest && newest === this.lastMarkedEventId) return;
    this.lastMarkedEventId = newest;
    // Room-level mark-read is the canonical "catch the whole room up": it marks
    // to the latest event the SDK knows, not just the loaded timeline window. A
    // timeline-only receipt left later events unread, so the count never cleared
    // and grew as the room synced.
    if (preferences.get("sendReadReceipts")) {
      await safeAsync(() => this.room.markAsRead(ReceiptType.Read));
    }
    void safeAsync(() => this.room.setUnreadFlag(false));
    // Reading catches up, so hide the unread marker.
    this.dismissUnreadMarker();
  }

  private async maybeMarkReadOnAppend(_entries: TimelineEntry[]): Promise<void> {
    // Only auto-mark when the view reports it's at the bottom. The view calls
    // `markAsRead()` directly on scroll; this just clears the debounce so a new
    // tail message re-marks. No-op if not live/parked (handled in markAsRead).
  }

  private newestEventId(): string | undefined {
    const entries = this.state.entries;
    for (let i = entries.length - 1; i >= 0; i--) {
      const e = entries[i];
      if (e.kind === "event" && e.eventId) return e.eventId;
    }
    return undefined;
  }

  // Explicit-receipt correction. `explicitReceipts` holds each user's true read
  // position (from the ephemeral poll). Every message's receipt list is rewritten
  // to the users whose position == that event, so avatars land on the exact event
  // read, including the newest, which the SDK otherwise leaves behind.
  private applyExplicitReceipts(entries: TimelineEntry[]): void {
    if (this.explicitReceipts.size === 0) return;
    // eventId → readers
    const byEvent = new Map<string, string[]>();
    for (const [userId, eventId] of this.explicitReceipts) {
      if (userId === this.session.userId) continue;
      const arr = byEvent.get(eventId) ?? [];
      arr.push(userId);
      byEvent.set(eventId, arr);
    }
    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i];
      if (entry.kind !== "event" || !entry.eventId) continue;
      const readers = byEvent.get(entry.eventId);
      const next = readers ? readers.slice().sort() : [];
      // Replace with a fresh object only when the receipt list actually changed,
      // so memoized rows re-render while untouched rows keep identity.
      if (!sameArray(next, entry.readReceipts)) {
        entries[i] = { ...entry, readReceipts: next };
      }
    }
  }

  /** Update explicit receipts from an ephemeral poll and re-apply to entries. */
  updateExplicitReceipts(receipts: Record<string, string>): void {
    let changed = false;
    for (const [userId, eventId] of Object.entries(receipts)) {
      if (this.explicitReceipts.get(userId) !== eventId) {
        this.explicitReceipts.set(userId, eventId);
        changed = true;
      }
    }
    if (!changed) return;
    const entries = this.state.entries.slice();
    this.applyExplicitReceipts(entries);
    this.updateLastOwnMessageId(entries);
    this.setEntries(entries);
  }

  // The newest own message that nobody has read past, used for the "Sent" tick.
  private updateLastOwnMessageId(entries: TimelineEntry[]): void {
    let lastOwn: string | undefined;
    for (let i = entries.length - 1; i >= 0; i--) {
      const e = entries[i];
      if (e.kind !== "event") continue;
      if (e.readReceipts.length > 0 && !e.isOwn) {
        // Someone read this later row, so own message before it was read.
        break;
      }
      if (e.isOwn && e.eventId && !e.sendState) {
        lastOwn = e.eventId;
        break;
      }
    }
    this.lastOwnMessageId = lastOwn;
  }

  /** Whether a given own entry should show the tertiary "Sent" tick. */
  showsSentTick(entry: EventEntry): boolean {
    return (
      entry.isOwn &&
      entry.readReceipts.length === 0 &&
      entry.eventId != null &&
      entry.eventId === this.lastOwnMessageId &&
      entry.sendState == null
    );
  }

  // --- ephemeral sync (typing + receipts long-poll) ------------------------
  //
  // A parallel `/sync` loop reads the sliding-sync receipts and typing
  // extensions for this room. The first call snapshots full state; subsequent
  // long-polls block until something changes, via the session's REST helper.

  private startEphemeralSync(): void {
    if (this.ephemeralActive || this.mode.type !== "live") return;
    this.ephemeralActive = true;
    void this.ephemeralLoop();
  }

  private stopEphemeralSync(): void {
    this.ephemeralActive = false;
  }

  private async ephemeralLoop(): Promise<void> {
    let failures = 0;
    while (this.ephemeralActive && !this.disposed) {
      const result = await this.fetchRoomEphemerals(this.ephemeralSince);
      if (!this.ephemeralActive) break;
      if (result) {
        failures = 0;
        this.ephemeralSince = result.nextBatch;
        if (result.receipts) this.updateExplicitReceipts(result.receipts);
        if (result.typing) this.setTypingUsers(result.typing, 12_000);
      } else {
        // The receipt/typing correction is best-effort. If the server keeps
        // rejecting the filtered /sync (e.g. a 400 from a strict homeserver),
        // stop rather than hammer it; the SDK's own receipts still apply.
        if (++failures >= 3) {
          this.ephemeralActive = false;
          break;
        }
        await delay(3000);
      }
    }
  }

  /**
   * Poll the room's ephemeral events (read receipts + typing) via a long-poll
   * `/sync` filtered to this room. Returns corrected receipt positions
   * (userId → eventId) and typing user ids. Best-effort; returns undefined on
   * failure so the loop backs off.
   */
  private async fetchRoomEphemerals(
    since: string | undefined,
  ): Promise<{ nextBatch: string; receipts?: Record<string, string>; typing?: string[] } | undefined> {
    // Minimal filter: Conduit-family servers (e.g. Tuwunel) 400 on the richer
    // presence/account_data/state sub-filters, so keep just the room ephemerals.
    const filter = encodeURIComponent(
      JSON.stringify({
        room: {
          rooms: [this.roomId],
          timeline: { limit: 1 },
          ephemeral: { types: ["m.receipt", "m.typing"] },
        },
      }),
    );
    const timeout = since ? 30000 : 0;
    const q = `_matrix/client/v3/sync?filter=${filter}&timeout=${timeout}${since ? `&since=${encodeURIComponent(since)}` : ""}`;
    const json = await safeAsync(() => this.session.restGet(q));
    if (!json || typeof json.next_batch !== "string") return undefined;

    const roomBlock = json.rooms?.join?.[this.roomId];
    const receipts: Record<string, string> = {};
    let typing: string[] | undefined;
    const ephemeralEvents: any[] = roomBlock?.ephemeral?.events ?? [];
    for (const ev of ephemeralEvents) {
      if (ev.type === "m.receipt") {
        for (const [eventId, byType] of Object.entries(ev.content ?? {})) {
          const read = (byType as any)?.["m.read"] ?? {};
          for (const userId of Object.keys(read)) {
            receipts[userId] = eventId;
          }
        }
      } else if (ev.type === "m.typing") {
        typing = (ev.content?.user_ids ?? []).filter((u: string) => u !== this.session.userId);
      }
    }
    return {
      nextBatch: json.next_batch,
      receipts: Object.keys(receipts).length ? receipts : undefined,
      typing,
    };
  }

  // --- typing --------------------------------------------------------------

  /**
   * Best-effort display name for a user id, resolved synchronously from the
   * sender profiles already carried on loaded timeline events (typing users have
   * almost always spoken recently). Falls back to the localpart.
   */
  displayNameFor(userId: string): string {
    for (let i = this.state.entries.length - 1; i >= 0; i--) {
      const e = this.state.entries[i];
      if (e.kind === "event" && e.sender === userId) {
        const name = e.senderProfile.displayName;
        if (name) return name;
        break;
      }
    }
    const local = userId.startsWith("@") ? userId.slice(1).split(":")[0] : userId;
    return local;
  }

  private setTypingUsers(userIds: string[], expiryMs: number): void {
    const filtered = userIds.filter((u) => u !== this.session.userId).sort();
    const current = this.state.typingUsers;
    if (sameArray(filtered, current)) {
      // Same value; just refresh the expiry.
    } else {
      this.setState({ typingUsers: filtered });
    }
    if (this.typingExpiryTimer) clearTimeout(this.typingExpiryTimer);
    if (filtered.length > 0) {
      this.typingExpiryTimer = setTimeout(() => {
        this.setState({ typingUsers: [] });
      }, expiryMs);
    }
  }

  // --- unread marker -------------------------------------------------------

  private computeUnreadMarker(entries: TimelineEntry[]): string | undefined {
    const marker = entries.find((e) => e.kind === "virtual" && e.virtual.type === "readMarker" && !isHiddenEntry(e));
    if (!marker) return undefined;
    if (marker.id === this.dismissedMarkerId) return undefined;
    // Arm auto-dismiss for a genuinely new marker.
    if (marker.id !== this.state.unreadMarkerId) {
      if (this.markerDismissTimer) clearTimeout(this.markerDismissTimer);
      this.markerDismissTimer = setTimeout(() => {
        this.dismissedMarkerId = marker.id;
        this.setState({ unreadMarkerId: undefined });
      }, 5000);
    }
    return marker.id;
  }

  dismissUnreadMarker(): void {
    if (this.state.unreadMarkerId) this.dismissedMarkerId = this.state.unreadMarkerId;
    if (this.markerDismissTimer) clearTimeout(this.markerDismissTimer);
    this.setState({ unreadMarkerId: undefined });
  }

  // --- lazy per-row work ----------------------------------------------------

  /** Fetch the encryption shield for a row on appearance (once per event). */
  loadShieldIfNeeded(entryId: string): void {
    if (this.shieldsRequested.has(entryId)) return;
    this.shieldsRequested.add(entryId);
    const index = this.state.entries.findIndex((e) => e.id === entryId);
    if (index < 0) return;
    const item = this.items[index];
    if (!item) return;
    // getShields is synchronous but can be crypto-heavy; defer off the paint.
    queueMicrotask(() => {
      const shield = shieldForEvent(item);
      if (!shield) return;
      const entries = this.state.entries.slice();
      const i = entries.findIndex((e) => e.id === entryId);
      if (i < 0 || entries[i].kind !== "event") return;
      entries[i] = { ...(entries[i] as EventEntry), shield };
      this.setEntries(entries);
    });
  }

  private rearmLazy(entry: TimelineEntry): void {
    this.shieldsRequested.delete(entry.id);
    if (entry.kind === "event" && entry.eventId) {
      this.replyDetailsFetched.delete(entry.eventId);
    }
  }

  private fetchPendingReplyDetails(entries: TimelineEntry[]): void {
    if (!this.timeline) return;
    for (const entry of entries) {
      if (entry.kind !== "event") continue;
      const reply = entry.inReplyTo;
      if (!reply || reply.status !== "pending") continue;
      if (this.replyDetailsFetched.has(reply.eventId)) continue;
      this.replyDetailsFetched.add(reply.eventId);
      void safeAsync(() => this.timeline!.fetchDetailsForEvent(reply.eventId));
      // The fill-in arrives as a `.set` diff, which re-maps the entry.
    }
  }

  // --- helpers consumed by the view ----------------------------------------

  markerVisible(): boolean {
    return this.state.unreadMarkerId != null;
  }

  get roomIdValue(): string {
    return this.roomId;
  }
}

// --- module helpers --------------------------------------------------------

/** Extra fields written by the VM onto entries; the view reads them. */
export interface WithHeader {
  showsHeader?: boolean;
}

function isRenderedMessage(entry: EventEntry): boolean {
  const t = entry.content.type;
  return (
    t === "text" ||
    t === "image" ||
    t === "video" ||
    t === "audio" ||
    t === "file" ||
    t === "sticker" ||
    t === "poll" ||
    t === "location" ||
    t === "redacted" ||
    t === "encrypted" ||
    t === "unsupported"
  );
}

function sameArray(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function safe<T>(fn: () => T): T | undefined {
  try {
    return fn();
  } catch {
    return undefined;
  }
}

async function safeAsync<T>(fn: () => Promise<T> | T | undefined): Promise<T | undefined> {
  try {
    return (await fn()) as T | undefined;
  } catch {
    return undefined;
  }
}
