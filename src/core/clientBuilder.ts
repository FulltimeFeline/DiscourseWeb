// Builds and restores the FFI `Client`, and runs one-time platform init.
//
// Configuration is matched to Discourse's "invisible crypto" posture:
//   - auto cross-signing + auto backups, download keys after a decryption
//     failure, and share history on invite, so encrypted history unlocks
//     without a recovery-key ceremony wherever possible.
//   - native sliding sync (discovered at login, pinned to Native on restore so
//     cold launch skips the discovery round-trip).
//   - a random per-account passphrase over an isolated IndexedDB store.

import {
  BackupDownloadStrategy,
  ClientBuilder,
  type ClientBuilderInterface,
  type ClientInterface,
  type ClientSessionDelegate,
  IndexedDbStoreBuilder,
  LogLevel,
  type Session,
  SlidingSyncVersion,
  SlidingSyncVersionBuilder,
  initPlatform,
} from "@/matrix";

let platformReady = false;

/** One-time Rust SDK platform init; must run before any client is built. */
export function initializePlatformOnce(): void {
  if (platformReady) return;
  platformReady = true;
  initPlatform(
    {
      logLevel: LogLevel.Info,
      traceLogPacks: [],
      extraTargets: [],
      writeToStdoutOrSystem: true,
      writeToFiles: undefined,
    },
    // useLightweightTokioRuntime: true on web (single-threaded wasm).
    true,
  );
}

interface BaseBuilderOptions {
  sessionDelegate: ClientSessionDelegate;
  slidingSync: "discover" | "restored";
  passphrase: string;
  storeName: string;
}

function baseBuilder(options: BaseBuilderOptions): ClientBuilderInterface {
  let builder: ClientBuilderInterface = new ClientBuilder();

  if (options.slidingSync === "discover") {
    builder = builder.slidingSyncVersionBuilder(
      SlidingSyncVersionBuilder.DiscoverNative,
    );
  }
  // For "restored" we leave the version off here and pin it on the Session
  // (see restoreClient) so there is no discovery round-trip on cold launch.

  const store = new IndexedDbStoreBuilder(options.storeName).passphrase(
    options.passphrase,
  );
  builder = builder.indexeddbStore(store);

  // Invisible crypto.
  builder = builder
    .autoEnableCrossSigning(true)
    .autoEnableBackups(true)
    .backupDownloadStrategy(BackupDownloadStrategy.AfterDecryptionFailure)
    .enableShareHistoryOnInvite(true)
    .setSessionDelegate(options.sessionDelegate);

  return builder;
}

function randomPassphrase(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return btoa(String.fromCharCode(...bytes));
}

export interface AuthClient {
  client: ClientInterface;
  passphrase: string;
  storeId: string;
}

/**
 * Phase 1 of login: build a client for a homeserver so its login methods can be
 * discovered. Each auth attempt gets a fresh isolated store.
 */
export async function createAuthenticationClient(
  serverNameOrUrl: string,
  sessionDelegate: ClientSessionDelegate,
  storeName: string,
  storeId: string,
): Promise<AuthClient> {
  initializePlatformOnce();
  const passphrase = randomPassphrase();
  const client = await baseBuilder({
    sessionDelegate,
    slidingSync: "discover",
    passphrase,
    storeName,
  })
    .serverNameOrHomeserverUrl(serverNameOrUrl)
    .build();
  return { client, passphrase, storeId };
}

/** Restore a client from a stored session into its isolated store. */
export async function restoreClient(
  session: Session,
  passphrase: string,
  storeName: string,
  sessionDelegate: ClientSessionDelegate,
): Promise<ClientInterface> {
  initializePlatformOnce();
  const client = await baseBuilder({
    sessionDelegate,
    slidingSync: "restored",
    passphrase,
    storeName,
  })
    .homeserverUrl(session.homeserverUrl)
    .build();

  // Pin native sliding sync so restore skips rediscovery.
  await client.restoreSession({
    ...session,
    slidingSyncVersion: SlidingSyncVersion.Native,
  });
  return client;
}

/** We only support native sliding sync (no legacy proxy), like Element X. */
export function assertNativeSlidingSync(client: ClientInterface): void {
  if (client.slidingSyncVersion() !== SlidingSyncVersion.Native) {
    throw new Error(
      "This homeserver doesn't support native sliding sync, which Discourse requires.",
    );
  }
}
