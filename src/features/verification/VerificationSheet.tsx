// The verification UI. Two entry points, both driven by one
// VerificationViewModel over the shared controller:
//   - <VerificationSheet />                 → "Verify This Session" (outgoing)
//   - <VerificationSheet incoming={…} />    → an incoming request
//
// On dismiss we cancel only in-flight flows and hand the delegate back to the
// incoming watcher (SessionVerificationManager.resumeIncomingWatch).

import { useEffect, useMemo } from "react";
import { Icon } from "@/ui/Icon";
import { useSession } from "@/app/context";
import { useViewModel } from "@/core/reactive";
import { VerificationViewModel, type VerificationEmoji } from "./VerificationViewModel";
import {
  verificationManagerFor,
  type IncomingVerification,
} from "./SessionVerificationManager";

export function VerificationSheet({
  incoming,
  onClose,
}: {
  incoming?: IncomingVerification;
  onClose: () => void;
}) {
  const session = useSession();
  const vm = useMemo(() => new VerificationViewModel(session), [session]);
  // Subscribe so React re-renders on every step transition.
  useViewModel(vm);

  useEffect(() => {
    if (incoming) void vm.beginIncomingVerification(incoming.senderId, incoming.flowId);
    return () => {
      // Cancel the underlying SDK verification on close unless it succeeded: a
      // failed or abandoned flow left a lingering request that reappeared as an
      // incoming prompt. Then restore the incoming watcher's delegate.
      if (vm.step.kind !== "done") void vm.cancel();
      else vm.cleanUp();
      void verificationManagerFor(session).resumeIncomingWatch();
      vm.dispose();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [vm]);

  const close = () => {
    onClose();
  };

  return (
    <div style={scrimStyle} onClick={close}>
      <div style={sheetStyle} onClick={(e) => e.stopPropagation()} role="dialog" aria-modal>
        <Body vm={vm} incoming={!!incoming} onClose={close} />
      </div>
    </div>
  );
}

function Body({
  vm,
  incoming,
  onClose,
}: {
  vm: VerificationViewModel;
  incoming: boolean;
  onClose: () => void;
}) {
  const s = vm.step;
  switch (s.kind) {
    case "intro":
      return (
        <Centered>
          <h2 style={titleStyle}>Verify this session</h2>
          <p style={subtitleStyle}>
            Until this device is verified, your encrypted messages stay locked. Confirm this is you
            by matching emoji with one of your other signed-in devices, or restore from your
            recovery key.
          </p>
          <button style={primaryBtn} onClick={() => void vm.beginDeviceVerification()}>
            Verify with another device
          </button>
          <button style={secondaryBtn} onClick={() => vm.showRecoveryKeyEntry()}>
            Enter recovery key
          </button>
          <button style={textBtn} onClick={onClose}>
            Not now
          </button>
        </Centered>
      );

    case "waitingForOtherDevice":
      return (
        <Centered>
          <h2 style={titleStyle}>
            {incoming ? "Accepting request…" : "Waiting for the other device"}
          </h2>
          <p style={subtitleStyle}>
            {incoming
              ? "Confirm on the device that started this verification."
              : "Accept the verification request on your other device to continue."}
          </p>
          <Spinner />
          <button style={textBtn} onClick={() => void vm.cancel().then(onClose)}>
            Cancel
          </button>
        </Centered>
      );

    case "comparingEmojis":
      return <EmojiCompare vm={vm} emojis={s.emojis} />;

    case "confirming":
      return (
        <Centered>
          <h2 style={titleStyle}>Confirming…</h2>
          <Spinner />
        </Centered>
      );

    case "done":
      return (
        <Centered>
          <div style={{ color: "var(--presence-online)" }}><Icon name="check" size={44} /></div>
          <h2 style={titleStyle}>Verified</h2>
          <p style={subtitleStyle}>This session is now verified.</p>
          <button style={primaryBtn} onClick={onClose}>
            Done
          </button>
        </Centered>
      );

    case "failed":
      return (
        <Centered>
          <div style={{ color: "var(--unread-mention)" }}><Icon name="warning" size={44} /></div>
          <h2 style={titleStyle}>Verification failed</h2>
          <p style={subtitleStyle}>{s.message}</p>
          <button style={secondaryBtn} onClick={() => vm.reset()}>
            Try again
          </button>
          <button style={textBtn} onClick={onClose}>
            Close
          </button>
        </Centered>
      );

    case "recoveryKeyEntry":
      return <RecoveryKeyEntry vm={vm} onClose={onClose} />;

    case "recovering":
      return (
        <Centered>
          <h2 style={titleStyle}>Restoring…</h2>
          <Spinner />
        </Centered>
      );
  }
}

function EmojiCompare({
  vm,
  emojis,
}: {
  vm: VerificationViewModel;
  emojis: VerificationEmoji[];
}) {
  return (
    <Centered>
      <h2 style={titleStyle}>Do these match?</h2>
      <p style={subtitleStyle}>
        Confirm the emoji below appear in the same order on your other device.
      </p>
      <div style={emojiGridStyle}>
        {emojis.map((e, i) => (
          <div key={i} style={emojiCellStyle}>
            <div style={{ fontSize: 34, lineHeight: 1 }}>{e.symbol}</div>
            <div style={{ fontSize: 12, color: "var(--text-secondary)", marginTop: 6 }}>
              {e.description}
            </div>
          </div>
        ))}
      </div>
      <div style={{ display: "flex", gap: 10, width: "100%" }}>
        <button
          style={{ ...secondaryBtn, flex: 1 }}
          onClick={() => void vm.declineMatch()}
        >
          They don't match
        </button>
        <button style={{ ...primaryBtn, flex: 1 }} onClick={() => void vm.confirmMatch()}>
          They match
        </button>
      </div>
    </Centered>
  );
}

function RecoveryKeyEntry({
  vm,
  onClose,
}: {
  vm: VerificationViewModel;
  onClose: () => void;
}) {
  const { recoveryKey } = useViewModel(vm);
  return (
    <Centered>
      <h2 style={titleStyle}>Enter your recovery key</h2>
      <p style={subtitleStyle}>
        It looks like <code>EsTx…</code> in groups of four characters.
      </p>
      <input
        type="password"
        autoComplete="off"
        value={recoveryKey}
        onChange={(e) => vm.setRecoveryKey(e.target.value)}
        placeholder="Recovery key"
        style={inputStyle}
      />
      <button
        style={primaryBtn}
        disabled={!recoveryKey.trim()}
        onClick={() => void vm.submitRecoveryKey()}
      >
        Restore
      </button>
      <button style={textBtn} onClick={onClose}>
        Cancel
      </button>
    </Centered>
  );
}

// --- small presentational bits ----------------------------------------------

function Centered({ children }: { children: React.ReactNode }) {
  return <div style={centeredStyle}>{children}</div>;
}

function Spinner() {
  return (
    <>
      <style>{"@keyframes discourse-spin{to{transform:rotate(360deg)}}"}</style>
      <div
        style={{
          width: 28,
          height: 28,
          border: "3px solid var(--separator)",
          borderTopColor: "var(--accent)",
          borderRadius: "50%",
          animation: "discourse-spin 0.8s linear infinite",
          margin: "8px 0",
        }}
      />
    </>
  );
}

// --- styles (CSS variables only) --------------------------------------------

const scrimStyle: React.CSSProperties = {
  position: "fixed",
  inset: 0,
  background: "var(--scrim)",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  zIndex: 1000,
};

const sheetStyle: React.CSSProperties = {
  width: "min(440px, 92vw)",
  maxHeight: "90vh",
  overflowY: "auto",
  background: "var(--bg-elevated)",
  borderRadius: "var(--radius-lg)",
  boxShadow: "var(--shadow-sheet)",
  padding: 24,
};

const centeredStyle: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  alignItems: "center",
  gap: 12,
  textAlign: "center",
};

const titleStyle: React.CSSProperties = {
  fontSize: 20,
  fontWeight: 600,
  color: "var(--text-primary)",
  margin: 0,
};

const subtitleStyle: React.CSSProperties = {
  fontSize: 14,
  color: "var(--text-secondary)",
  margin: 0,
  lineHeight: 1.5,
};

const emojiGridStyle: React.CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(4, 1fr)",
  gap: 12,
  width: "100%",
  margin: "8px 0",
};

const emojiCellStyle: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  alignItems: "center",
  padding: "12px 4px",
  background: "var(--bg-input)",
  borderRadius: "var(--radius-md)",
};

const baseBtn: React.CSSProperties = {
  padding: "10px 16px",
  borderRadius: "var(--radius-md)",
  border: "none",
  fontSize: 15,
  fontWeight: 600,
  cursor: "pointer",
  width: "100%",
};

const primaryBtn: React.CSSProperties = {
  ...baseBtn,
  background: "var(--accent)",
  color: "var(--text-on-accent)",
};

const secondaryBtn: React.CSSProperties = {
  ...baseBtn,
  background: "var(--bg-input)",
  color: "var(--text-primary)",
};

const textBtn: React.CSSProperties = {
  ...baseBtn,
  background: "transparent",
  color: "var(--text-secondary)",
  fontWeight: 500,
};

const inputStyle: React.CSSProperties = {
  width: "100%",
  padding: "10px 12px",
  borderRadius: "var(--radius-md)",
  border: "1px solid var(--separator)",
  background: "var(--bg-input)",
  color: "var(--text-primary)",
  fontSize: 15,
  fontFamily: "var(--font-mono)",
};
