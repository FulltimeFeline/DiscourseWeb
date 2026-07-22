// Persists signed-in accounts in localStorage.
//
// An ordered map of accounts, each holding the FFI `Session`, the store
// passphrase, and a `storeId`, plus an `activeUserId`. Multiple accounts stay
// signed in and are switched between. Each account owns an isolated IndexedDB
// crypto/event store (named by its `storeId`), encrypted with a random
// `passphrase`. The SDK's session-delegate rotates OAuth/MAS tokens on
// background tasks and calls back into `save()` to persist them.

import { Session } from "@/matrix";

/** One stored account: the SDK session + its isolated store's keys. */
export interface SessionData {
  /** The FFI Session (access/refresh tokens, userId, deviceId, homeserverUrl…). */
  session: Session;
  /** Random passphrase encrypting this account's IndexedDB store. */
  passphrase: string;
  /** Unique id mapped to an IndexedDB database name, isolating accounts. */
  storeId: string;
}

interface PersistedShape {
  /** userId to account. */
  accounts: Record<string, RawSessionData>;
  /** Sign-in order (userIds), oldest first; drives account-switcher order. */
  order: string[];
  /** The account shown on launch. */
  activeUserId: string | null;
}

interface RawSessionData {
  session: unknown; // serialized Session payload
  passphrase: string;
  storeId: string;
}

const KEY = "discourse.accounts.v1";
// Older aurora-format keys we clean up if present.
const LEGACY_KEYS = ["mx_session", "mx_session_v2", "mx_session_v3"];

export class SessionStore {
  private read(): PersistedShape {
    for (const k of LEGACY_KEYS) localStorage.removeItem(k);
    const raw = localStorage.getItem(KEY);
    if (!raw) return { accounts: {}, order: [], activeUserId: null };
    try {
      const parsed = JSON.parse(raw) as PersistedShape;
      return {
        accounts: parsed.accounts ?? {},
        order: parsed.order ?? Object.keys(parsed.accounts ?? {}),
        activeUserId: parsed.activeUserId ?? null,
      };
    } catch {
      return { accounts: {}, order: [], activeUserId: null };
    }
  }

  private write(shape: PersistedShape): void {
    localStorage.setItem(KEY, JSON.stringify(shape));
  }

  private hydrate(raw: RawSessionData): SessionData {
    return {
      session: Session.new(raw.session as never),
      passphrase: raw.passphrase,
      storeId: raw.storeId,
    };
  }

  /** All accounts in sign-in order. */
  loadAll(): SessionData[] {
    const shape = this.read();
    return shape.order
      .map((userId) => shape.accounts[userId])
      .filter((r): r is RawSessionData => !!r)
      .map((r) => this.hydrate(r));
  }

  /** Map keyed by userId, used by the SDK session delegate. */
  loadAllByUserId(): Record<string, SessionData> {
    const shape = this.read();
    const out: Record<string, SessionData> = {};
    for (const [userId, raw] of Object.entries(shape.accounts)) {
      out[userId] = this.hydrate(raw);
    }
    return out;
  }

  get(userId: string): SessionData | undefined {
    const raw = this.read().accounts[userId];
    return raw ? this.hydrate(raw) : undefined;
  }

  get activeUserId(): string | null {
    return this.read().activeUserId;
  }

  set activeUserId(userId: string | null) {
    const shape = this.read();
    shape.activeUserId = userId;
    this.write(shape);
  }

  /**
   * Save (or update) an account. `passphrase`/`storeId` are required on first
   * save (login) and reused on token-refresh saves (delegate) where they are
   * omitted (read-modify-write).
   */
  save(session: Session, passphrase?: string, storeId?: string): void {
    const shape = this.read();
    const existing = shape.accounts[session.userId];
    const finalPassphrase = passphrase ?? existing?.passphrase;
    const finalStoreId = storeId ?? existing?.storeId;
    if (!finalPassphrase || !finalStoreId) {
      throw new Error(
        `SessionStore.save: missing passphrase/storeId for ${session.userId}`,
      );
    }
    shape.accounts[session.userId] = {
      // `Session` is a uniffi record (a plain data object), so it serializes
      // directly and is rebuilt on load via `Session.new(...)`.
      session: session as unknown,
      passphrase: finalPassphrase,
      storeId: finalStoreId,
    };
    if (!shape.order.includes(session.userId)) {
      shape.order.push(session.userId);
    }
    if (!shape.activeUserId) shape.activeUserId = session.userId;
    this.write(shape);
  }

  /** Remove an account and delete its isolated IndexedDB store. */
  async remove(userId: string): Promise<void> {
    const shape = this.read();
    const storeId = shape.accounts[userId]?.storeId;
    delete shape.accounts[userId];
    shape.order = shape.order.filter((u) => u !== userId);
    if (shape.activeUserId === userId) {
      shape.activeUserId = shape.order[0] ?? null;
    }
    this.write(shape);
    if (storeId) await this.deleteStore(storeId);
  }

  clearAll(): void {
    this.write({ accounts: {}, order: [], activeUserId: null });
  }

  // --- IndexedDB store isolation -------------------------------------------

  generateStoreId(): string {
    return crypto.randomUUID();
  }

  /** IndexedDB database name for a store id. */
  storeName(storeId: string): string {
    return `discourse-store-${storeId}`;
  }

  async deleteStore(storeId: string): Promise<void> {
    const name = this.storeName(storeId);
    await new Promise<void>((resolve) => {
      const req = indexedDB.deleteDatabase(name);
      req.onsuccess = () => resolve();
      req.onerror = () => resolve();
      req.onblocked = () => resolve();
    });
  }
}
