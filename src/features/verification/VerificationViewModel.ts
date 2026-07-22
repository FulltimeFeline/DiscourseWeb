// Device/session verification (SAS). Drives a single, session-shared
// SessionVerificationController. The SDK mints a new controller on every
// getSessionVerificationController() call, and each controller gets its own
// delegate, so if an active flow and the incoming-request watcher held different
// controllers, an accept/emoji event would land on the wrong delegate and stall.
// So one controller is cached per session.userId (module-level, since
// MatrixSession may not be edited) and its delegate is handed between the watcher
// and the active sheet.

import { ViewModel } from "@/core/reactive";
import type { MatrixSession } from "@/core/MatrixSession";
import {
  SessionVerificationData_Tags,
  type SessionVerificationControllerInterface,
  type SessionVerificationControllerDelegate,
  type SessionVerificationData,
  type SessionVerificationRequestDetails,
} from "@/matrix";

// --- shared controller cache -------------------------------------------------

const controllers = new Map<string, Promise<SessionVerificationControllerInterface>>();

/** The one shared controller for this session (created lazily, then reused). */
export function sharedVerificationController(
  session: MatrixSession,
): Promise<SessionVerificationControllerInterface> {
  let c = controllers.get(session.userId);
  if (!c) {
    c = session.client.getSessionVerificationController();
    controllers.set(session.userId, c);
  }
  return c;
}

// --- delegate bridge ---------------------------------------------------------

export type VerificationEvent =
  | { type: "requestReceived"; senderId: string; flowId: string }
  | { type: "acceptedByOtherDevice" }
  | { type: "sasStarted" }
  | { type: "emojis"; emojis: VerificationEmoji[] }
  | { type: "finished" }
  | { type: "failed" }
  | { type: "cancelled" };

export interface VerificationEmoji {
  symbol: string;
  description: string;
}

/** Builds a delegate that funnels every controller callback into `emit`. */
export function makeDelegateBridge(
  emit: (e: VerificationEvent) => void,
): SessionVerificationControllerDelegate {
  const log = (m: string, ...a: unknown[]) => console.info(`[verification] ${m}`, ...a);
  return {
    didReceiveVerificationRequest(details: SessionVerificationRequestDetails) {
      log("didReceiveVerificationRequest", details.senderProfile.userId, details.flowId);
      emit({
        type: "requestReceived",
        senderId: details.senderProfile.userId,
        flowId: details.flowId,
      });
    },
    didAcceptVerificationRequest() {
      log("didAcceptVerificationRequest (other device accepted)");
      emit({ type: "acceptedByOtherDevice" });
    },
    didStartSasVerification() {
      log("didStartSasVerification");
      emit({ type: "sasStarted" });
    },
    didReceiveVerificationData(data: SessionVerificationData) {
      log("didReceiveVerificationData", data.tag);
      if (data.tag === SessionVerificationData_Tags.Emojis) {
        const emojis = data.inner.emojis.map((e) => ({
          symbol: e.symbol(),
          description: e.description(),
        }));
        emit({ type: "emojis", emojis });
      } else if (data.tag === SessionVerificationData_Tags.Decimals) {
        // Some pairs negotiate the decimal SAS instead of emoji; show the
        // three numbers rather than stalling with a blank screen.
        const emojis = data.inner.values.map((v) => ({
          symbol: String(v),
          description: "",
        }));
        emit({ type: "emojis", emojis });
      }
    },
    didFail() {
      log("didFail");
      emit({ type: "failed" });
    },
    didCancel() {
      log("didCancel");
      emit({ type: "cancelled" });
    },
    didFinish() {
      log("didFinish");
      emit({ type: "finished" });
    },
  };
}

// --- view model --------------------------------------------------------------

export type VerificationStep =
  | { kind: "intro" }
  | { kind: "waitingForOtherDevice" }
  | { kind: "comparingEmojis"; emojis: VerificationEmoji[] }
  | { kind: "confirming" }
  | { kind: "done" }
  | { kind: "failed"; message: string }
  | { kind: "recoveryKeyEntry" }
  | { kind: "recovering" };

interface State {
  step: VerificationStep;
  recoveryKey: string;
}

export class VerificationViewModel extends ViewModel<State> {
  private controller?: SessionVerificationControllerInterface;
  private delegateAttached = false;
  // Retain the delegate for the flow's lifetime; a dropped reference can stop
  // the SDK's callbacks mid-flow.
  private bridge?: SessionVerificationControllerDelegate;

  constructor(private readonly session: MatrixSession) {
    super({ step: { kind: "intro" }, recoveryKey: "" });
  }

  get step(): VerificationStep {
    return this.state.step;
  }

  // --- controller wiring ----------------------------------------------------

  private async attachController(): Promise<SessionVerificationControllerInterface> {
    const controller = await sharedVerificationController(this.session);
    this.controller = controller;
    // Take over the delegate from the incoming-watcher for the duration of the
    // flow, handling events directly rather than through an async stream: the SDK
    // delivers callbacks on the JS thread already. Retain the bridge (field) so
    // it isn't collected while the flow is in progress.
    this.bridge = makeDelegateBridge((e) => this.handle(e));
    controller.setDelegate(this.bridge);
    this.delegateAttached = true;
    return controller;
  }

  private handle(event: VerificationEvent): void {
    console.info("[verification] handle", event.type, "(step was", this.state.step.kind + ")");
    switch (event.type) {
      case "requestReceived":
        // Only meaningful to the incoming watcher; the active flow ignores it.
        break;
      case "acceptedByOtherDevice":
        void this.controller?.startSasVerification();
        break;
      case "sasStarted":
        // Await the emoji data next.
        break;
      case "emojis":
        this.setState({ step: { kind: "comparingEmojis", emojis: event.emojis } });
        break;
      case "finished":
        this.setState({ step: { kind: "done" } });
        break;
      case "failed":
        this.setState({
          step: { kind: "failed", message: "Verification failed. Try again from the other device too." },
        });
        break;
      case "cancelled":
        this.setState({ step: { kind: "failed", message: "Verification was cancelled." } });
        break;
    }
  }

  // --- outgoing flow --------------------------------------------------------

  async beginDeviceVerification(): Promise<void> {
    // Log the crypto/verification state: a generic failure here usually means
    // no cross-signing identity is available yet (not bootstrapped, or not
    // synced), which is what "verify with another device" needs.
    try {
      console.info(
        "[verification] state before request:",
        this.session.client.encryption().verificationState(),
      );
    } catch (e) {
      console.info("[verification] verificationState() threw", e);
    }
    let controller: SessionVerificationControllerInterface;
    try {
      controller = await this.attachController();
      console.info("[verification] got controller ok");
    } catch (err) {
      console.error("[verification] getSessionVerificationController failed", err);
      const msg = err instanceof Error ? err.message : String(err);
      this.setState({ step: { kind: "failed", message: `Couldn't get verification controller: ${msg}` } });
      return;
    }
    try {
      await controller.requestDeviceVerification();
      console.info("[verification] requestDeviceVerification sent");
      this.setState({ step: { kind: "waitingForOtherDevice" } });
    } catch (err) {
      console.error("[verification] requestDeviceVerification failed", err);
      const msg = err instanceof Error ? err.message : String(err);
      this.setState({ step: { kind: "failed", message: `Couldn't request verification: ${msg}` } });
    }
  }

  // --- incoming flow --------------------------------------------------------

  async beginIncomingVerification(senderId: string, flowId: string): Promise<void> {
    try {
      const controller = await this.attachController();
      await controller.acknowledgeVerificationRequest(senderId, flowId);
      await controller.acceptVerificationRequest();
      this.setState({ step: { kind: "waitingForOtherDevice" } });
    } catch (err) {
      console.error("[verification] accept incoming failed", err);
      this.setState({ step: { kind: "failed", message: "Couldn't accept verification." } });
    }
  }

  // --- SAS decision ---------------------------------------------------------

  async confirmMatch(): Promise<void> {
    this.setState({ step: { kind: "confirming" } });
    try {
      await this.controller?.approveVerification();
    } catch {
      this.setState({ step: { kind: "failed", message: "Couldn't confirm the emoji." } });
    }
  }

  async declineMatch(): Promise<void> {
    try {
      await this.controller?.declineVerification();
    } catch {
      /* ignore */
    }
    this.setState({
      step: { kind: "failed", message: "You reported the emoji didn't match." },
    });
  }

  // --- recovery key ---------------------------------------------------------

  showRecoveryKeyEntry(): void {
    this.setState({ step: { kind: "recoveryKeyEntry" } });
  }

  setRecoveryKey(value: string): void {
    this.setState({ recoveryKey: value });
  }

  async submitRecoveryKey(): Promise<void> {
    const key = this.state.recoveryKey.trim();
    if (!key) return;
    this.setState({ step: { kind: "recovering" } });
    try {
      await this.session.client.encryption().recover(key);
      this.setState({ step: { kind: "done" } });
    } catch {
      this.setState({
        step: {
          kind: "failed",
          message: "That recovery key didn't work. Check for typos and try again.",
        },
      });
    }
  }

  // --- cancel / cleanup -----------------------------------------------------

  /** Whether the flow is mid-verification (so dismiss should cancel it). */
  get isInFlight(): boolean {
    const k = this.state.step.kind;
    return k === "waitingForOtherDevice" || k === "comparingEmojis" || k === "confirming";
  }

  async cancel(): Promise<void> {
    try {
      await this.controller?.cancelVerification();
    } catch {
      /* ignore */
    }
    this.cleanUp();
  }

  /** Detach our delegate so the incoming watcher can take it back. */
  cleanUp(): void {
    if (this.controller && this.delegateAttached) {
      try {
        this.controller.setDelegate(undefined);
      } catch {
        /* ignore */
      }
    }
    this.delegateAttached = false;
    this.controller = undefined;
    this.bridge = undefined;
  }

  reset(): void {
    this.cleanUp();
    this.setState({ step: { kind: "intro" }, recoveryKey: "" });
  }

  override dispose(): void {
    this.cleanUp();
    super.dispose();
  }
}
