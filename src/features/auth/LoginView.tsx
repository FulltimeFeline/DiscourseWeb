import { useMemo } from "react";
import { useViewModel } from "@/core/reactive";
import type { AppState } from "@/app/AppState";
import { LoginViewModel } from "./LoginViewModel";
import { DownloadLinks } from "@/features/download/DownloadLinks";
import "./login.css";

export function LoginView({ app }: { app: AppState }) {
  const vm = useMemo(() => new LoginViewModel(app), [app]);
  const s = useViewModel(vm);

  return (
    <div className="login">
      <div className="login__card">
        <div className="login__brand">
          <img className="login__logo" src="/icon.png" alt="" />
          <h1>Discourse</h1>
          <p className="login__tag">A Matrix client that opens straight into your conversations.</p>
        </div>

        {s.stage === "server" ? (
          <form
            className="login__form"
            onSubmit={(e) => {
              e.preventDefault();
              void vm.checkHomeserver();
            }}
          >
            <label className="login__label" htmlFor="hs">
              Homeserver
            </label>
            <input
              id="hs"
              className="login__input"
              value={s.homeserver}
              onChange={(e) => vm.setHomeserver(e.target.value)}
              placeholder="matrix.org"
              autoFocus
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
            />
            {s.error && <div className="login__error">{s.error}</div>}
            <button className="login__primary" type="submit" disabled={s.busy}>
              {s.busy ? "Checking…" : "Continue"}
            </button>
          </form>
        ) : (
          <div className="login__form">
            <button className="login__back" onClick={() => vm.backToServer()}>
              ← {s.serverUrl?.replace(/^https?:\/\//, "") ?? "change server"}
            </button>

            {s.methods?.oidc && (
              <button
                className="login__primary"
                disabled={s.busy}
                onClick={() => void vm.loginWithOidc()}
              >
                {s.busy ? "Opening…" : "Sign in with your provider"}
              </button>
            )}

            {s.methods?.sso && !s.methods.oidc && (
              <button
                className="login__primary"
                disabled={s.busy}
                onClick={() => void vm.loginWithSso()}
              >
                {s.busy ? "Opening…" : "Sign in with SSO"}
              </button>
            )}

            {s.methods?.password && (
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  if (s.isRegistering) void vm.register();
                  else void vm.loginWithPassword();
                }}
              >
                {s.isRegistering ? (
                  <div className="login__or">create a new account</div>
                ) : (
                  s.methods.oidc && <div className="login__or">or with a password</div>
                )}
                <label className="login__label" htmlFor="user">
                  Username
                </label>
                <input
                  id="user"
                  className="login__input"
                  value={s.username}
                  onChange={(e) => vm.setUsername(e.target.value)}
                  placeholder={s.isRegistering ? "username" : "@you:server"}
                  autoCapitalize="none"
                  autoCorrect="off"
                  spellCheck={false}
                />
                <label className="login__label" htmlFor="pass">
                  Password
                </label>
                <input
                  id="pass"
                  className="login__input"
                  type="password"
                  autoComplete={s.isRegistering ? "new-password" : "current-password"}
                  value={s.password}
                  onChange={(e) => vm.setPassword(e.target.value)}
                />
                {s.isRegistering && (
                  <>
                    <label className="login__label" htmlFor="regtoken">
                      Registration token
                    </label>
                    <input
                      id="regtoken"
                      className="login__input"
                      value={s.registrationToken}
                      onChange={(e) => vm.setRegistrationToken(e.target.value)}
                      autoCapitalize="none"
                      autoCorrect="off"
                      spellCheck={false}
                    />
                    <div className="login__hint">
                      You need a registration token from the server admin.
                    </div>
                  </>
                )}
                <button className="login__primary" type="submit" disabled={s.busy}>
                  {s.busy
                    ? s.isRegistering
                      ? "Creating account…"
                      : "Signing in…"
                    : s.isRegistering
                      ? "Create account"
                      : "Sign in"}
                </button>
                <button
                  type="button"
                  className="login__toggle"
                  onClick={() => vm.setRegistering(!s.isRegistering)}
                >
                  {s.isRegistering
                    ? "Already have an account? Sign in"
                    : "New here? Create an account"}
                </button>
              </form>
            )}

            {!s.methods?.password && !s.methods?.oidc && !s.methods?.sso && (
              <div className="login__error">
                This homeserver doesn't advertise a supported login method.
              </div>
            )}

            {s.error && <div className="login__error">{s.error}</div>}
          </div>
        )}
      </div>
      <DownloadLinks />
    </div>
  );
}
