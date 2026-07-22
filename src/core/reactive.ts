// The reactive backbone: a tiny `ViewModel<S>` base and a `useViewModel` hook
// backed by `useSyncExternalStore`. A view model holds an immutable snapshot
// `S`; `setState` swaps it and notifies subscribers. React reads the snapshot
// and re-renders on change. No external state library.

import { useSyncExternalStore } from "react";

type Listener = () => void;

export abstract class ViewModel<S extends object> {
  private listeners = new Set<Listener>();
  private _state: S;
  /** Disposers run on `dispose()` (teardown). */
  private disposers: Array<() => void> = [];

  constructor(initial: S) {
    this._state = initial;
  }

  /** Current immutable snapshot. Read freely from methods. */
  get state(): S {
    return this._state;
  }

  /**
   * Replace part (or all) of the snapshot and notify React. Accepts a partial
   * patch or an updater function.
   */
  protected setState(patch: Partial<S> | ((prev: S) => Partial<S>)): void {
    const result =
      typeof patch === "function"
        ? (patch as (prev: S) => Partial<S>)(this._state)
        : patch;
    // Always merge onto the previous snapshot, so an updater may return just the
    // changed slice (matching how the screens use it).
    const next = { ...this._state, ...result };
    this._state = next;
    this.emit();
  }

  /** Force a notification without changing identity (rarely needed). */
  protected touch(): void {
    this._state = { ...this._state };
    this.emit();
  }

  private emit(): void {
    for (const l of this.listeners) l();
  }

  // --- useSyncExternalStore wiring -----------------------------------------
  readonly subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  readonly getSnapshot = (): S => this._state;

  /** Register cleanup to run when this view model is torn down. */
  protected onDispose(fn: () => void): void {
    this.disposers.push(fn);
  }

  /** Tear down. Cancels SDK listener handles, timers, etc. Idempotent. */
  dispose(): void {
    const fns = this.disposers;
    this.disposers = [];
    for (const fn of fns) {
      try {
        fn();
      } catch {
        // best-effort teardown
      }
    }
  }
}

/** Subscribe a React component to a view model's snapshot. */
export function useViewModel<S extends object>(vm: ViewModel<S>): S {
  return useSyncExternalStore(vm.subscribe, vm.getSnapshot);
}

/**
 * A minimal observable value, for cross-cutting stores that aren't screen view
 * models (preferences, presence, media cache signals). Same subscribe/snapshot
 * contract so `useStore` works over it.
 */
export class Store<S> {
  private listeners = new Set<Listener>();
  private _value: S;

  constructor(initial: S) {
    this._value = initial;
  }

  get value(): S {
    return this._value;
  }

  set(next: S): void {
    if (next === this._value) return;
    this._value = next;
    for (const l of this.listeners) l();
  }

  update(fn: (prev: S) => S): void {
    this.set(fn(this._value));
  }

  readonly subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  readonly getSnapshot = (): S => this._value;
}

export function useStore<S>(store: Store<S>): S {
  return useSyncExternalStore(store.subscribe, store.getSnapshot);
}
