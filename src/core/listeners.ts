// Helpers for the SDK's listener/handle model.
//
// A listener is an object literal implementing an interface (`{ onUpdate }` or
// `{ call }`), and every `subscribe*`/`state`/`addListener` call returns a
// `TaskHandle` with `.cancel()`. So most call sites can pass an inline object
// and keep the handle for teardown. These helpers cover the two recurring
// needs: tracking handles for disposal, and turning a listener into an async
// iterable for flows that read sequentially (e.g. verification).

import type { TaskHandleInterface } from "@/matrix";

export type Disposer = () => void;

/** Cancels a TaskHandle; safe to call once, tolerant of nulls. */
export function disposeHandle(
  handle: TaskHandleInterface | undefined | null,
): void {
  try {
    handle?.cancel();
  } catch {
    // handle already finished/cancelled
  }
}

/** Collects disposers/handles and tears them all down together. */
export class Subscriptions {
  private items: Disposer[] = [];

  add(item: Disposer | TaskHandleInterface): void {
    if (typeof item === "function") {
      this.items.push(item);
    } else {
      this.items.push(() => disposeHandle(item));
    }
  }

  /** Track a TaskHandle produced by a subscribe call. */
  track(handle: TaskHandleInterface | undefined | null): void {
    if (handle) this.add(handle);
  }

  dispose(): void {
    const items = this.items;
    this.items = [];
    for (const d of items) {
      try {
        d();
      } catch {
        // best effort
      }
    }
  }
}

/**
 * Bridge a listener callback into an async iterable. `subscribe` receives an
 * emit function and returns the TaskHandle (or a disposer). Consume with
 * `for await`. Backed by an unbounded queue with a single consumer (one
 * `for await` loop per bridge).
 */
export function listenerStream<T>(
  subscribe: (emit: (value: T) => void) => TaskHandleInterface | Disposer,
): { stream: AsyncIterable<T>; dispose: Disposer } {
  const queue: T[] = [];
  let resolveNext: ((r: IteratorResult<T>) => void) | null = null;
  let done = false;

  const emit = (value: T) => {
    if (done) return;
    if (resolveNext) {
      const r = resolveNext;
      resolveNext = null;
      r({ value, done: false });
    } else {
      queue.push(value);
    }
  };

  const handle = subscribe(emit);
  const dispose = () => {
    if (done) return;
    done = true;
    if (typeof handle === "function") handle();
    else disposeHandle(handle);
    if (resolveNext) {
      const r = resolveNext;
      resolveNext = null;
      r({ value: undefined, done: true });
    }
  };

  const stream: AsyncIterable<T> = {
    [Symbol.asyncIterator]() {
      return {
        next(): Promise<IteratorResult<T>> {
          if (queue.length > 0) {
            return Promise.resolve({ value: queue.shift() as T, done: false });
          }
          if (done) return Promise.resolve({ value: undefined, done: true });
          return new Promise((resolve) => {
            resolveNext = resolve;
          });
        },
        return(): Promise<IteratorResult<T>> {
          dispose();
          return Promise.resolve({ value: undefined, done: true });
        },
      };
    },
  };

  return { stream, dispose };
}
