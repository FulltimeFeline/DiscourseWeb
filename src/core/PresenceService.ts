// Tracks other users' presence (online / idle / offline).
//
// The Rust SDK exposes no presence API, so this polls the Client-Server API
// directly with the session's access token (via MatrixSession.restGet). One
// shared 20s poll drives every visible presence dot; watchers are refcounted so
// the poll only runs while something is on screen. A 403 (presence disabled
// server-side) PERMANENTLY disables polling: no dots, no repeated calls, no
// user-facing error.
//
// Reactive: a single Store<Snapshot> holds a userId to UserPresence map. A
// change to one user replaces only that entry's boxed object, and
// `usePresence(userId)` subscribes to the whole map but returns the per-user
// entry, so React only re-renders the dots whose entry identity changed.

import { useCallback, useEffect, useSyncExternalStore } from "react";
import { Store } from "./reactive";
import { preferences } from "./Preferences";
import type { MatrixSession } from "./MatrixSession";

export type PresenceState = "online" | "unavailable" | "offline";

export interface UserPresence {
  userId: string;
  state: PresenceState;
  /** Seconds since last activity, when the server reports it. */
  lastActiveAgo?: number;
  /** The Matrix presence `status_msg`, where Commet stores custom status. */
  statusMessage?: string;
  fetchedAt: number;
}

type Snapshot = Record<string, UserPresence>;

const POLL_INTERVAL_MS = 20_000;

function mapState(raw: unknown): PresenceState {
  switch (raw) {
    case "online":
      return "online";
    case "unavailable":
      return "unavailable";
    default:
      return "offline";
  }
}

export class PresenceService {
  private readonly store = new Store<Snapshot>({});
  private readonly watchers = new Map<string, number>();
  private readonly inFlight = new Set<string>();
  private pollTimer: ReturnType<typeof setInterval> | undefined;
  private paused = false;
  /** Latched true on first 403: the server has presence disabled forever. */
  private unsupported = false;

  /** Pause the poll while the tab is hidden; resume (with an immediate tick)
   *  when it's foregrounded again. */
  private readonly onVisibility = (): void => {
    if (document.visibilityState === "hidden") this.pause();
    else this.resume();
  };

  constructor(private readonly session: MatrixSession) {
    document.addEventListener("visibilitychange", this.onVisibility);
  }

  get isUnsupported(): boolean {
    return this.unsupported;
  }

  // --- reactive access ------------------------------------------------------

  subscribe = (listener: () => void): (() => void) => this.store.subscribe(listener);
  getSnapshot = (): Snapshot => this.store.value;

  entry(userId: string): UserPresence | undefined {
    return this.store.value[userId];
  }

  // --- watcher refcounting --------------------------------------------------

  register(userId: string): void {
    if (this.unsupported) return;
    const n = (this.watchers.get(userId) ?? 0) + 1;
    this.watchers.set(userId, n);
    if (n === 1) {
      // Fresh watcher: fetch soon-ish, allowing a slightly stale cached value.
      void this.fetch(userId, POLL_INTERVAL_MS * 1.25);
    }
    this.startPollingIfNeeded();
  }

  unregister(userId: string): void {
    const n = this.watchers.get(userId);
    if (n === undefined) return;
    if (n <= 1) this.watchers.delete(userId);
    else this.watchers.set(userId, n - 1);
    if (this.watchers.size === 0) this.stopPolling();
  }

  // --- lifecycle ------------------------------------------------------------

  pause(): void {
    this.paused = true;
    this.stopPolling();
  }

  resume(): void {
    this.paused = false;
    this.startPollingIfNeeded();
  }

  dispose(): void {
    document.removeEventListener("visibilitychange", this.onVisibility);
    this.stopPolling();
    this.watchers.clear();
    this.inFlight.clear();
  }

  private startPollingIfNeeded(): void {
    if (this.pollTimer !== undefined) return;
    if (this.unsupported || this.paused || this.watchers.size === 0) return;
    this.pollTimer = setInterval(() => this.tick(), POLL_INTERVAL_MS);
    // Kick an immediate tick so dots fill in without waiting a full interval.
    void this.tick();
  }

  private stopPolling(): void {
    if (this.pollTimer !== undefined) {
      clearInterval(this.pollTimer);
      this.pollTimer = undefined;
    }
  }

  private tick(): void {
    if (this.unsupported || this.paused) return;
    const maxAge = POLL_INTERVAL_MS * 0.75;
    for (const userId of this.watchers.keys()) {
      void this.fetch(userId, maxAge);
    }
  }

  // --- fetch ----------------------------------------------------------------

  private async fetch(userId: string, maxAge: number): Promise<void> {
    if (this.unsupported) return;
    if (this.inFlight.has(userId)) return;

    // Own presence: skip when "share presence" is off, since each GET is
    // activity the server reads as "online".
    if (userId === this.session.userId && !preferences.get("sendPresence")) return;

    const cached = this.store.value[userId];
    if (cached && Date.now() - cached.fetchedAt < maxAge) return;

    this.inFlight.add(userId);
    try {
      const result = await this.getStatus(userId);
      if (result === "unsupported") {
        this.disablePermanently();
        return;
      }
      if (!result) return; // transient failure / unparsable: leave entry as-is
      // Preserve object identity when nothing a subscriber renders has changed:
      // a poll produces a fresh object every time (new fetchedAt), which would
      // otherwise re-render every watching row on every tick. Keep the previous
      // object (just refresh its freshness stamp so we don't immediately refetch)
      // unless a displayed field actually changed.
      const prev = this.store.value[userId];
      if (
        prev &&
        prev.state === result.state &&
        prev.lastActiveAgo === result.lastActiveAgo &&
        prev.statusMessage === result.statusMessage
      ) {
        prev.fetchedAt = result.fetchedAt;
        return;
      }
      this.store.update((p) => ({ ...p, [userId]: result }));
    } finally {
      this.inFlight.delete(userId);
    }
  }

  /**
   * Returns a parsed UserPresence, `"unsupported"` on 403 (disable forever), or
   * undefined on any other non-200 / parse failure (transient, retried). Uses
   * the raw fetch so we can distinguish the 403 (restGet swallows status).
   */
  private async getStatus(userId: string): Promise<UserPresence | "unsupported" | undefined> {
    const base = await this.session.apiBase();
    if (!base) return undefined;
    const token = this.session.session()?.accessToken;
    const url = `${base.replace(/\/$/, "")}/_matrix/client/v3/presence/${encodeURIComponent(
      userId,
    )}/status`;
    try {
      const res = await fetch(url, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      if (res.status === 403) return "unsupported";
      if (!res.ok) return undefined;
      const json = await res.json();
      const lastMs = typeof json.last_active_ago === "number" ? json.last_active_ago : undefined;
      const status =
        typeof json.status_msg === "string" ? json.status_msg.trim() : "";
      return {
        userId,
        state: mapState(json.presence),
        lastActiveAgo: lastMs !== undefined ? lastMs / 1000 : undefined,
        statusMessage: status || undefined,
        fetchedAt: Date.now(),
      };
    } catch {
      return undefined;
    }
  }

  private disablePermanently(): void {
    this.unsupported = true;
    this.stopPolling();
    this.watchers.clear();
    this.inFlight.clear();
  }
}

// --- module-level cache + hook ----------------------------------------------
//
// Keyed by session.userId.

const services = new Map<string, PresenceService>();

export function presenceServiceFor(session: MatrixSession): PresenceService {
  let svc = services.get(session.userId);
  if (!svc) {
    svc = new PresenceService(session);
    services.set(session.userId, svc);
  }
  return svc;
}

export function disposePresenceService(session: MatrixSession): void {
  const svc = services.get(session.userId);
  if (svc) {
    svc.dispose();
    services.delete(session.userId);
  }
}

/** Presence dot colors: online=green, idle=orange, offline=gray. */
export function presenceColor(state: PresenceState): string {
  switch (state) {
    case "online":
      return "var(--presence-online)";
    case "unavailable":
      return "#f59e0b";
    default:
      return "var(--text-tertiary)";
  }
}

/** Human-readable detail text (Online / Idle / Last active … ago / Offline). */
export function presenceDetail(p: UserPresence | undefined): string {
  if (!p) return "Offline";
  if (p.state === "online") return "Online";
  if (p.state === "unavailable") return "Idle";
  if (p.lastActiveAgo !== undefined) {
    return `Last active ${formatDuration(p.lastActiveAgo)} ago`;
  }
  return "Offline";
}

function formatDuration(seconds: number): string {
  const s = Math.round(seconds);
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.round(h / 24)}d`;
}

/**
 * Subscribe a component to one user's presence. Registers a watcher on mount and
 * releases it on unmount. Returns undefined until the first poll lands (or if
 * presence is unsupported on this homeserver).
 */
export function usePresence(
  session: MatrixSession,
  userId: string | undefined,
): UserPresence | undefined {
  const svc = presenceServiceFor(session);
  // Select only this user's entry. useSyncExternalStore re-renders only when the
  // returned value's identity changes, so a poll for some OTHER user (or for a
  // room with no DM user at all) no longer re-renders this row — previously every
  // RoomRow subscribed to the whole snapshot and re-rendered on every tick.
  const getSnapshot = useCallback(
    () => (userId ? svc.getSnapshot()[userId] : undefined),
    [svc, userId],
  );
  const presence = useSyncExternalStore(svc.subscribe, getSnapshot);

  useEffect(() => {
    if (!userId) return;
    svc.register(userId);
    return () => svc.unregister(userId);
  }, [svc, userId]);

  return presence;
}

/** Subscribe to presence for many users at once (e.g. the member roster). */
export function usePresenceMap(
  session: MatrixSession,
  userIds: string[],
): Record<string, UserPresence | undefined> {
  const svc = presenceServiceFor(session);
  const snapshot = useSyncExternalStore(svc.subscribe, svc.getSnapshot);
  const key = userIds.join(",");
  useEffect(() => {
    for (const id of userIds) svc.register(id);
    return () => {
      for (const id of userIds) svc.unregister(id);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [svc, key]);
  return snapshot;
}
