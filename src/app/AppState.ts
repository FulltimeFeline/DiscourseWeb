// Root state machine: launching, loggedOut, disconnected, active(session).
//
// Multi-account: signed-in sessions are kept "warm" in `scopes` across switches
// (an account switch is instant if already warm). Restore-time network failure
// drops to `disconnected` with a 30s retry loop; a confirmed dead token drops
// the account without a network logout, then falls back to the next account.

import {
  type ClientInterface,
  type ClientSessionDelegate,
  type Session,
} from "@/matrix";
import { ViewModel } from "@/core/reactive";
import { SessionStore } from "@/core/SessionStore";
import { MatrixSession } from "@/core/MatrixSession";
import { restoreClient } from "@/core/clientBuilder";
import { disposeRoomListScope } from "@/features/roomlist/scope";
import { disposeIncomingCallStore } from "@/features/call";
import { disposeVerificationManager } from "@/features/verification";
import { disposePresenceService } from "@/core/PresenceService";
import { disposeTimelineCache } from "@/features/timeline/timelineCache";

export type Phase = "launching" | "loggedOut" | "disconnected" | "active";

export interface AccountSummary {
  userId: string;
  displayName?: string;
  avatarUrl?: string;
}

/** Persisted per-account navigation (last space+room, plus per-space memory). */
interface NavEntry {
  spaceId: string | null;
  roomId: string | null;
  perSpace: Record<string, string | null>;
}
const NAV_KEY = "discourse.nav.v1";
const navSpaceKey = (id: string | null): string => id ?? "__home__";

interface AppSnapshot {
  phase: Phase;
  activeUserId: string | null;
  accounts: AccountSummary[];
  /** Present when phase === "active". */
  session: MatrixSession | null;
  isAddAccountOpen: boolean;
  isQuickSwitcherOpen: boolean;
  /** Selected space in the rail; null = Home (all rooms). */
  selectedSpaceId: string | null;
  /** Open room in the main pane; null = empty state. */
  selectedRoomId: string | null;
}

export class AppState extends ViewModel<AppSnapshot> {
  private store = new SessionStore();
  private scopes = new Map<string, MatrixSession>();
  private reconnectTimer?: ReturnType<typeof setTimeout>;
  private reconnectDelayMs = 2000;
  private authErrorHandled = new Set<string>();

  constructor() {
    super({
      phase: "launching",
      activeUserId: null,
      accounts: [],
      session: null,
      isAddAccountOpen: false,
      isQuickSwitcherOpen: false,
      selectedSpaceId: null,
      selectedRoomId: null,
    });
  }

  selectSpace(spaceId: string | null): void {
    // Restore the last room you were viewing in that space (per-space memory),
    // so switching spaces returns you where you were.
    const uid = this.state.activeUserId;
    const perSpace = uid ? this.loadAllNav()[uid]?.perSpace ?? {} : {};
    const lastRoom = perSpace[navSpaceKey(spaceId)] ?? null;
    this.setState({ selectedSpaceId: spaceId, selectedRoomId: lastRoom });
    this.persistNav();
  }
  selectRoom(roomId: string | null): void {
    this.setState({ selectedRoomId: roomId, isQuickSwitcherOpen: false });
    this.persistNav();
  }

  /** Persist the current space+room (and per-space memory) for the active user. */
  private persistNav(): void {
    const uid = this.state.activeUserId;
    if (!uid) return;
    const all = this.loadAllNav();
    const prev = all[uid] ?? { spaceId: null, roomId: null, perSpace: {} };
    all[uid] = {
      spaceId: this.state.selectedSpaceId,
      roomId: this.state.selectedRoomId,
      perSpace: { ...prev.perSpace, [navSpaceKey(this.state.selectedSpaceId)]: this.state.selectedRoomId },
    };
    try {
      localStorage.setItem(NAV_KEY, JSON.stringify(all));
    } catch {
      /* storage unavailable */
    }
  }

  /** Restore the persisted space+room for a user (called on activation). */
  private restoreNav(userId: string): void {
    const entry = this.loadAllNav()[userId];
    if (!entry) return;
    this.setState({ selectedSpaceId: entry.spaceId ?? null, selectedRoomId: entry.roomId ?? null });
  }

  private loadAllNav(): Record<string, NavEntry> {
    try {
      return JSON.parse(localStorage.getItem(NAV_KEY) || "{}") as Record<string, NavEntry>;
    } catch {
      return {};
    }
  }

  /** The SDK session delegate: persists rotated tokens, serves restore reads. */
  readonly sessionDelegate: ClientSessionDelegate = {
    retrieveSessionFromKeychain: (userId: string): Session => {
      const data = this.store.get(userId);
      if (!data) throw new Error(`No stored session for ${userId}`);
      return data.session;
    },
    saveSessionInKeychain: (session: Session): void => {
      // Only persist if we already track this account (a mid-session token
      // rotation); a fresh login is persisted by completeLogin.
      if (this.store.get(session.userId)) this.store.save(session);
    },
  };

  private refreshAccounts(): void {
    const accounts = this.store.loadAll().map((d) => {
      const warm = this.scopes.get(d.session.userId);
      const p = warm?.ownProfile.value;
      return {
        userId: d.session.userId,
        displayName: p?.displayName,
        avatarUrl: p?.avatarUrl,
      };
    });
    this.setState({ accounts });
  }

  /** Called once at launch: restore the last active account, if any. */
  async start(): Promise<void> {
    if (this.state.phase !== "launching") return;
    const all = this.store.loadAll();
    this.refreshAccounts();
    if (all.length === 0) {
      this.setState({ phase: "loggedOut" });
      return;
    }
    const target = this.store.activeUserId ?? all[0].session.userId;
    await this.activate(target);
  }

  async switchAccount(userId: string): Promise<void> {
    if (userId === this.state.activeUserId) return;
    await this.activate(userId);
  }

  private async activate(userId: string): Promise<void> {
    const data = this.store.get(userId);
    if (!data) {
      this.setState({ phase: this.store.loadAll().length ? this.state.phase : "loggedOut" });
      return;
    }

    const warm = this.scopes.get(userId);
    if (warm) {
      this.clearReconnect();
      this.store.activeUserId = userId;
      this.setState({ phase: "active", session: warm, activeUserId: userId });
      this.restoreNav(userId);
      return;
    }

    try {
      const client = await restoreClient(
        data.session,
        data.passphrase,
        this.store.storeName(data.storeId),
        this.sessionDelegate,
      );
      const session = this.adoptSession(client, data.storeId, data.passphrase);
      this.clearReconnect();
      this.store.activeUserId = userId;
      this.setState({ phase: "active", session, activeUserId: userId });
      this.restoreNav(userId);
      // Start sync after flipping active, so we paint first.
      void session.startSync().then(() => session.loadOwnProfile()).then(() => this.refreshAccounts());
    } catch {
      // Restore fails only when unreachable/unbuildable; a dead token surfaces
      // later during sync. Keep retrying rather than logging out on a blip.
      this.setState({ phase: "disconnected", activeUserId: userId });
      this.scheduleReconnect(userId);
    }
  }

  /** Wire a freshly built client into a warm MatrixSession scope. */
  private adoptSession(client: ClientInterface, storeId: string, passphrase: string): MatrixSession {
    const session = new MatrixSession(client, storeId, passphrase);
    session.onAuthError = (uid) => void this.handleAuthError(uid);
    this.scopes.set(session.userId, session);
    this.authErrorHandled.delete(session.userId);
    return session;
  }

  /**
   * Finalise any successful auth: persist the session, enter it. Called by the
   * login flow with the built client and its store keys.
   */
  async completeLogin(client: ClientInterface, passphrase: string, storeId: string): Promise<void> {
    const ffiSession = client.session() as Session;
    this.store.save(ffiSession, passphrase, storeId);
    this.store.activeUserId = ffiSession.userId;
    const session = this.adoptSession(client, storeId, passphrase);
    this.setState({
      phase: "active",
      session,
      activeUserId: session.userId,
      isAddAccountOpen: false,
    });
    this.restoreNav(session.userId);
    this.refreshAccounts();
    void session.startSync().then(() => session.loadOwnProfile()).then(() => this.refreshAccounts());
  }

  async logOut(): Promise<void> {
    this.clearReconnect();
    const session = this.state.session;
    if (!session) {
      this.setState({ phase: "loggedOut" });
      return;
    }
    const userId = session.userId;
    await session.logOut();
    this.disposeSessionFeatures(session);
    this.scopes.delete(userId);
    await this.store.remove(userId);
    await this.fallbackAfterRemoval(userId);
  }

  /** Confirmed dead token: drop the account without a network logout. */
  private async handleAuthError(userId: string): Promise<void> {
    if (this.authErrorHandled.has(userId)) return;
    if (!this.store.get(userId)) return;
    this.authErrorHandled.add(userId);
    const scope = this.scopes.get(userId);
    scope?.tearDown();
    if (scope) this.disposeSessionFeatures(scope);
    this.scopes.delete(userId);
    await this.store.remove(userId);
    await this.fallbackAfterRemoval(userId);
  }

  /** Release the per-session feature stores (room list, calls, verification, presence). */
  private disposeSessionFeatures(session: MatrixSession): void {
    try {
      disposeRoomListScope(session.userId);
      disposeIncomingCallStore(session);
      disposeVerificationManager(session);
      disposePresenceService(session);
      // Dynamic import: keep the emoji feature (and its ~540 KB emojibase
      // dataset) off the cold-boot module graph. It's only pulled here during a
      // rare session teardown, by which point the chunk is already cached.
      void import("@/features/emotes/emojiSession").then((m) => m.disposeEmojiSession(session));
      disposeTimelineCache(session);
    } catch {
      // best-effort teardown
    }
  }

  private async fallbackAfterRemoval(removedUserId: string): Promise<void> {
    this.refreshAccounts();
    const wasActive = this.state.activeUserId === removedUserId;
    if (!wasActive) return;
    const next = this.store.loadAll()[0];
    if (next) {
      this.setState({ phase: "launching", session: null });
      await this.activate(next.session.userId);
    } else {
      this.store.clearAll();
      this.setState({ phase: "loggedOut", session: null, activeUserId: null });
    }
  }

  private scheduleReconnect(userId: string): void {
    if (this.reconnectTimer) return;
    const tick = async () => {
      if (this.state.phase !== "disconnected") return;
      await this.activate(userId);
      if (this.state.phase === "disconnected") {
        this.reconnectDelayMs = Math.min(this.reconnectDelayMs * 2, 30_000);
        this.reconnectTimer = setTimeout(tick, this.reconnectDelayMs);
      }
    };
    this.reconnectTimer = setTimeout(tick, this.reconnectDelayMs);
  }

  private clearReconnect(): void {
    this.reconnectDelayMs = 2000;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
  }

  // UI flag setters
  setAddAccountOpen(open: boolean): void {
    this.setState({ isAddAccountOpen: open });
  }
  setQuickSwitcherOpen(open: boolean): void {
    this.setState({ isQuickSwitcherOpen: open });
  }

  /** The session delegate + store, exposed for the login flow. */
  get sessionStore(): SessionStore {
    return this.store;
  }
}

export const appState = new AppState();
