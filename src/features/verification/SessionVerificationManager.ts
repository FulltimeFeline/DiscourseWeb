// Watches the session for two things and exposes them reactively:
//   1. Incoming verification requests (another device asks to verify).
//   2. The overall verificationState(), which gates the "verify this device"
//      prompt (needsVerification when Unverified).
//
// The incoming watcher sets a delegate on the shared controller. When a sheet
// opens it takes the delegate over (see VerificationViewModel.attachController);
// on close the sheet calls resumeIncomingWatch() to hand the delegate back.

import { Store } from "@/core/reactive";
import { Subscriptions } from "@/core/listeners";
import type { MatrixSession } from "@/core/MatrixSession";
import { VerificationState } from "@/matrix";
import type { SessionVerificationControllerDelegate } from "@/matrix";
import { makeDelegateBridge, sharedVerificationController } from "./VerificationViewModel";

export interface IncomingVerification {
  senderId: string;
  flowId: string;
}

export type VerificationGate = "verified" | "unverified" | "unknown";

export class SessionVerificationManager {
  /** Set when another device requests verification; the shell shows a sheet. */
  readonly incoming = new Store<IncomingVerification | undefined>(undefined);
  /** Live cross-signing verification state for this device. */
  readonly gate = new Store<VerificationGate>("unknown");

  private subs = new Subscriptions();
  private watching = false;
  // Retained so the SDK keeps delivering incoming requests to it.
  private watcherBridge?: SessionVerificationControllerDelegate;

  constructor(private readonly session: MatrixSession) {}

  async start(): Promise<void> {
    this.watchVerificationState();
    await this.resumeIncomingWatch();
  }

  /** True while this device still needs to be verified. */
  get needsVerification(): boolean {
    return this.gate.value === "unverified";
  }

  // --- incoming-request watcher ---------------------------------------------

  /**
   * (Re)install our delegate on the shared controller to catch incoming
   * requests. Called on start, and again by the sheet on dismiss so the watcher
   * regains the delegate the active flow had taken.
   */
  async resumeIncomingWatch(): Promise<void> {
    const controller = await sharedVerificationController(this.session);
    this.watcherBridge = makeDelegateBridge((e) => {
      if (e.type === "requestReceived") {
        // Guard: only surface one at a time.
        if (!this.incoming.value) {
          this.incoming.set({ senderId: e.senderId, flowId: e.flowId });
        }
      }
    });
    controller.setDelegate(this.watcherBridge);
    this.watching = true;
  }

  clearIncoming(): void {
    this.incoming.set(undefined);
  }

  // --- verification-state gate ----------------------------------------------

  private watchVerificationState(): void {
    const enc = this.session.client.encryption();
    // Seed synchronously, then subscribe to updates.
    try {
      this.gate.set(mapState(enc.verificationState()));
    } catch {
      /* leave as unknown */
    }
    try {
      const handle = enc.verificationStateListener({
        onUpdate: (state) => this.gate.set(mapState(state)),
      });
      this.subs.track(handle);
    } catch {
      /* listener unavailable in this build */
    }
  }

  dispose(): void {
    this.subs.dispose();
    if (this.watching) {
      // Best-effort: drop our delegate so a torn-down manager stops receiving.
      void sharedVerificationController(this.session)
        .then((c) => c.setDelegate(undefined))
        .catch(() => {});
    }
  }
}

function mapState(state: VerificationState): VerificationGate {
  switch (state) {
    case VerificationState.Verified:
      return "verified";
    case VerificationState.Unverified:
      return "unverified";
    default:
      return "unknown";
  }
}

// --- module-level cache -------------------------------------------------------

const managers = new Map<string, SessionVerificationManager>();

export function verificationManagerFor(session: MatrixSession): SessionVerificationManager {
  let m = managers.get(session.userId);
  if (!m) {
    m = new SessionVerificationManager(session);
    managers.set(session.userId, m);
  }
  return m;
}

export function disposeVerificationManager(session: MatrixSession): void {
  const m = managers.get(session.userId);
  if (m) {
    m.dispose();
    managers.delete(session.userId);
  }
}
