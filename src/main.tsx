import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./styles/globals.css";
import { uniffiInitAsync } from "@/matrix";
import { App } from "./App";
import { isSsoCallbackPopup } from "@/features/auth/sso";

// If this document is the SSO popup landing on the callback route, the opener
// reads our URL and closes us, so don't boot the heavy app in here.
if (isSsoCallbackPopup()) {
  document.body.innerHTML =
    '<div class="boot"><div>Signing in… you can close this window.</div></div>';
  throw new Error("sso-callback-popup"); // halt module init
}

// Desktop-only for now. Phones get a friendly notice instead of the (heavy,
// unusable-at-that-width) app; bail before loading the ~48MB SDK so mobile
// users don't download it for nothing.
function isMobileDevice(): boolean {
  const ua = navigator.userAgent || "";
  const phoneUa = /Android|webOS|iPhone|iPod|BlackBerry|IEMobile|Opera Mini/i.test(ua);
  const coarseNarrow =
    typeof window.matchMedia === "function" &&
    window.matchMedia("(pointer: coarse)").matches &&
    Math.min(window.innerWidth, window.innerHeight) < 820;
  return phoneUa || coarseNarrow;
}

if (isMobileDevice()) {
  document.body.innerHTML = `
    <div class="mobile-gate">
      <div class="mobile-gate__card">
        <div class="mobile-gate__glyph">🖥️</div>
        <h1>Discourse isn't ready for mobile yet</h1>
        <p>The web app is desktop-only for now. Open it on a computer to sign in
        and chat — a mobile version is on the way.</p>
      </div>
    </div>`;
  throw new Error("mobile-not-supported"); // halt module init (skip loading wasm)
}

const root = createRoot(document.getElementById("root") as HTMLElement);

// The Matrix SDK ships as a ~48MB wasm module. Paint a loading state, then
// initialise it once (registers uniffi callbacks/checksums), then mount. Every
// SDK type is off-limits until this resolves.
root.render(
  <div className="boot">
    <div className="boot__spinner" />
    <div>Loading Discourse…</div>
  </div>,
);

try {
  await uniffiInitAsync();
  root.render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
} catch (err) {
  console.error("Failed to initialise the Matrix SDK", err);
  root.render(
    <div className="boot">
      <div>Couldn't load the Matrix engine.</div>
      <div style={{ color: "var(--text-tertiary)", fontSize: "0.85em" }}>
        {String(err)}
      </div>
    </div>,
  );
}
