import { Suspense, lazy, useEffect } from "react";
import { useViewModel } from "@/core/reactive";
import { appState } from "@/app/AppState";
import { AppProvider } from "@/app/context";
import { LoginView } from "@/features/auth/LoginView";
import { completeOidcCallbackIfPresent } from "@/features/auth/LoginViewModel";
import { ErrorBoundary } from "@/app/ErrorBoundary";

// Code-split the authenticated shell. The whole timeline/composer/emoji/picker
// subtree (including the large emojibase dataset) is a separate chunk loaded
// only once a session is active, so the login screen and initial paint aren't
// blocked parsing megabytes of app code the logged-out user never sees.
const MainShell = lazy(() =>
  import("@/app/MainShell").then((m) => ({ default: m.MainShell })),
);

export function App() {
  const s = useViewModel(appState);

  useEffect(() => {
    void (async () => {
      // If we're landing on an OIDC redirect, finish that flow; otherwise do the
      // normal launch (restore the last active account).
      const handled = await completeOidcCallbackIfPresent(appState);
      if (!handled) await appState.start();
    })();
  }, []);

  return (
    <AppProvider app={appState}>
      {s.phase === "launching" && (
        <div className="boot">
          <div className="boot__spinner" />
          <div>Starting up…</div>
        </div>
      )}

      {s.phase === "loggedOut" && <LoginView app={appState} />}

      {s.phase === "disconnected" && (
        <div className="boot">
          <div className="boot__spinner" />
          <div>Reconnecting to your homeserver…</div>
          <button
            style={{ color: "var(--accent)", fontSize: "0.85em" }}
            onClick={() => void appState.logOut()}
          >
            Sign out
          </button>
        </div>
      )}

      {s.phase === "active" && s.session && (
        <ErrorBoundary label="Main shell">
          <Suspense
            fallback={
              <div className="boot">
                <div className="boot__spinner" />
                <div>Loading…</div>
              </div>
            }
          >
            <MainShell app={appState} session={s.session} />
          </Suspense>
        </ErrorBoundary>
      )}
    </AppProvider>
  );
}
