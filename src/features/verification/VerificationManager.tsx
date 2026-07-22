// The mountable verification surface; mount once in the shell.
//
// - Starts the SessionVerificationManager (incoming-request watcher + the
//   verificationState gate).
// - Renders a VerificationSheet automatically when an INCOMING request arrives.
// - Exposes the outgoing "verify this device" sheet when `showVerify` is set by
//   the shell (e.g. from the needsVerification banner).
//
// The needsVerification gate itself is read via useNeedsVerification() so the
// shell can decide when to prompt.

import { useEffect, useState } from "react";
import { useSession } from "@/app/context";
import { useStore } from "@/core/reactive";
import { VerificationSheet } from "./VerificationSheet";
import { verificationManagerFor } from "./SessionVerificationManager";

export function VerificationManager({
  showVerify = false,
  onVerifyClosed,
}: {
  /** When true, show the outgoing "verify this session" sheet. */
  showVerify?: boolean;
  onVerifyClosed?: () => void;
}) {
  const session = useSession();
  const manager = verificationManagerFor(session);
  const incoming = useStore(manager.incoming);
  const [showOutgoing, setShowOutgoing] = useState(showVerify);

  useEffect(() => {
    void manager.start();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [manager]);

  useEffect(() => {
    setShowOutgoing(showVerify);
  }, [showVerify]);

  // The OUTGOING flow the user started wins: don't let an incoming request
  // (often the echo of our own request, or a lingering one) hijack it and
  // prompt the initiator as if THEY were being verified.
  if (showOutgoing) {
    return (
      <VerificationSheet
        onClose={() => {
          setShowOutgoing(false);
          // Drop any incoming request that arrived for our own outgoing flow.
          manager.clearIncoming();
          onVerifyClosed?.();
        }}
      />
    );
  }

  // Incoming requests: dedicated sheet with acknowledge+accept.
  if (incoming) {
    return (
      <VerificationSheet
        incoming={incoming}
        onClose={() => manager.clearIncoming()}
      />
    );
  }

  return null;
}

/** Reactive "this device needs verification" gate for the shell's prompt. */
export function useNeedsVerification(): boolean {
  const session = useSession();
  const manager = verificationManagerFor(session);
  const gate = useStore(manager.gate);
  return gate === "unverified";
}
