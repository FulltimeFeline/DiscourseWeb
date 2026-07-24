// SDK readiness gate.
//
// The Matrix Rust SDK ships as a ~48MB wasm module. Rather than block the first
// paint on it (a top-level `await` in main.tsx used to freeze the whole app —
// including the login form — until the wasm finished downloading + compiling),
// we kick initialisation off immediately and let the UI render. The handful of
// code paths that actually build an SDK client (see clientBuilder) `await`
// `ensureSdkReady()` first, so the wasm download overlaps with the user reading
// the login screen / restoring the persisted session metadata.

import { uniffiInitAsync } from "./index.web";

let promise: Promise<void> | undefined;

/**
 * Begin initialising the SDK wasm on first call and return the same promise
 * thereafter (idempotent). Resolves once the wasm is instantiated and the uniffi
 * bindings are registered; rejects if the engine can't load.
 */
export function ensureSdkReady(): Promise<void> {
  if (!promise) promise = uniffiInitAsync();
  return promise;
}
