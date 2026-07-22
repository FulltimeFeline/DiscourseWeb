// Verification feature: public surface for the shell to wire.

export { VerificationSheet } from "./VerificationSheet";
export {
  VerificationViewModel,
  sharedVerificationController,
  type VerificationStep,
  type VerificationEmoji,
} from "./VerificationViewModel";
export {
  SessionVerificationManager,
  verificationManagerFor,
  disposeVerificationManager,
  type IncomingVerification,
  type VerificationGate,
} from "./SessionVerificationManager";
export { VerificationManager, useNeedsVerification } from "./VerificationManager";
