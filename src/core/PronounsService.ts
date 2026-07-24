// Per-sender pronouns for the timeline. Pronouns come from the federated
// extended profile (foxchat.pronouns etc.), resolved by session.fetchProfile.
// Caches one fetch per user id per session and exposes a `usePronouns` hook that
// lazily triggers the fetch and re-renders when it lands. Session-keyed like
// PresenceService.

import { useEffect } from "react";
import { useSyncExternalStore } from "react";
import type { MatrixSession } from "./MatrixSession";

class PronounsService {
  private cache = new Map<string, string | null>(); // userId → pronouns (null = fetched, none)
  private inflight = new Set<string>();
  private listeners = new Set<() => void>();

  constructor(private session: MatrixSession) {}

  readonly subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };
  readonly getSnapshot = (): Map<string, string | null> => this.cache;

  private emit(): void {
    // New Map identity so useSyncExternalStore sees a change.
    this.cache = new Map(this.cache);
    for (const l of this.listeners) l();
  }

  get(userId: string): string | undefined {
    const v = this.cache.get(userId);
    return v ?? undefined;
  }

  register(userId: string): void {
    if (this.cache.has(userId) || this.inflight.has(userId)) return;
    this.inflight.add(userId);
    void this.session
      .fetchProfile(userId)
      .then((p) => {
        this.cache.set(userId, p?.pronouns?.trim() || null);
      })
      .catch(() => {
        this.cache.set(userId, null);
      })
      .finally(() => {
        this.inflight.delete(userId);
        this.emit();
      });
  }
}

const services = new WeakMap<MatrixSession, PronounsService>();

function serviceFor(session: MatrixSession): PronounsService {
  let s = services.get(session);
  if (!s) {
    s = new PronounsService(session);
    services.set(session, s);
  }
  return s;
}

/** Pronouns for a user id, lazily fetched + cached. Undefined until resolved. */
export function usePronouns(session: MatrixSession, userId: string | undefined): string | undefined {
  const svc = serviceFor(session);
  // Subscribe to the per-user value, not the whole cache Map: strings are
  // identity-stable, so only rows whose own sender's pronouns changed re-render.
  const value = useSyncExternalStore(svc.subscribe, () => (userId ? svc.get(userId) : undefined));
  useEffect(() => {
    if (userId) svc.register(userId);
  }, [svc, userId]);
  return value;
}
