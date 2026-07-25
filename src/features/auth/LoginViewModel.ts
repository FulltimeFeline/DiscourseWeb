// Two-stage login: enter a homeserver, discover its methods, then authenticate.

import type { ClientInterface, HomeserverLoginDetailsInterface } from "@/matrix";
import { ViewModel } from "@/core/reactive";
import {
  createAuthenticationClient,
  assertNativeSlidingSync,
} from "@/core/clientBuilder";
import type { AppState } from "@/app/AppState";
import {
  getOidcConfiguration,
  savePendingOidc,
  takePendingOidc,
} from "./oidc";
import { runSsoPopup, ssoRedirectUrl } from "./sso";

const DEVICE_NAME = "Discourse (Web)";
const AUTH_ERROR_KEY = "discourse.authError";

export interface LoginMethods {
  password: boolean;
  oidc: boolean;
  sso: boolean;
}

interface LoginSnapshot {
  stage: "server" | "methods";
  homeserver: string;
  username: string;
  password: string;
  registrationToken: string;
  /** Toggles the methods stage between signing in and creating an account. */
  isRegistering: boolean;
  methods: LoginMethods | null;
  serverUrl: string | null;
  busy: boolean;
  error: string | null;
}

export class LoginViewModel extends ViewModel<LoginSnapshot> {
  private client?: ClientInterface;
  private passphrase?: string;
  private storeId?: string;

  constructor(private app: AppState) {
    const pendingError = sessionStorage.getItem(AUTH_ERROR_KEY);
    if (pendingError) sessionStorage.removeItem(AUTH_ERROR_KEY);
    super({
      stage: "server",
      homeserver: "matrix.org",
      username: "",
      password: "",
      registrationToken: "",
      isRegistering: false,
      methods: null,
      serverUrl: null,
      busy: false,
      error: pendingError,
    });
  }

  setHomeserver(v: string): void {
    this.setState({ homeserver: v, error: null });
  }
  setUsername(v: string): void {
    this.setState({ username: v, error: null });
  }
  setPassword(v: string): void {
    this.setState({ password: v, error: null });
  }
  setRegistrationToken(v: string): void {
    this.setState({ registrationToken: v, error: null });
  }
  /** Switch the methods stage between "sign in" and "create account". */
  setRegistering(registering: boolean): void {
    this.setState({ isRegistering: registering, error: null });
  }

  backToServer(): void {
    this.client = undefined;
    this.setState({
      stage: "server",
      methods: null,
      error: null,
      password: "",
      registrationToken: "",
      isRegistering: false,
    });
  }

  /** Stage 1: build a client for the homeserver and discover login methods. */
  async checkHomeserver(): Promise<void> {
    const homeserver = this.state.homeserver.trim();
    if (!homeserver) {
      this.setState({ error: "Enter a homeserver." });
      return;
    }
    this.setState({ busy: true, error: null });
    try {
      const store = this.app.sessionStore;
      const storeId = store.generateStoreId();
      const { client, passphrase } = await createAuthenticationClient(
        homeserver,
        this.app.sessionDelegate,
        store.storeName(storeId),
        storeId,
      );
      this.client = client;
      this.passphrase = passphrase;
      this.storeId = storeId;
      const details: HomeserverLoginDetailsInterface = await client.homeserverLoginDetails();
      this.setState({
        stage: "methods",
        busy: false,
        serverUrl: details.url(),
        methods: {
          password: details.supportsPasswordLogin(),
          oidc: details.supportsOidcLogin(),
          sso: details.supportsSsoLogin(),
        },
      });
    } catch (e) {
      this.setState({
        busy: false,
        error: describe(e, "Couldn't reach that homeserver."),
      });
    }
  }

  /** Password login. */
  async loginWithPassword(): Promise<void> {
    if (!this.client || !this.passphrase || !this.storeId) return;
    const { username, password } = this.state;
    if (!username || !password) {
      this.setState({ error: "Enter your username and password." });
      return;
    }
    this.setState({ busy: true, error: null });
    try {
      await this.client.login(username, password, DEVICE_NAME, undefined);
      assertNativeSlidingSync(this.client);
      await this.app.completeLogin(this.client, this.passphrase, this.storeId);
    } catch (e) {
      this.setState({ busy: false, error: describe(e, "Login failed.") });
    }
  }

  /**
   * Create a new account, then sign in. The SDK exposes no registration API, so
   * this drives `/_matrix/client/v3/register` directly (token UIA, with
   * `inhibit_login` so no throwaway device is minted) and then logs in through
   * the SDK's normal password path — identical session/crypto setup to a login.
   */
  async register(): Promise<void> {
    if (!this.client || !this.passphrase || !this.storeId) return;
    const username = this.state.username.trim();
    const { password } = this.state;
    const registrationToken = this.state.registrationToken.trim();
    if (!username || !password || !registrationToken) {
      this.setState({ error: "Enter a username, password, and registration token." });
      return;
    }
    const base = (this.state.serverUrl ?? "").replace(/\/+$/, "");
    if (!base) {
      this.setState({ error: "Couldn't determine the homeserver address." });
      return;
    }
    this.setState({ busy: true, error: null });
    try {
      await registerAccount(base, username, password, registrationToken);
      // Account exists (no device, thanks to inhibit_login) — sign in.
      await this.client.login(username, password, DEVICE_NAME, undefined);
      assertNativeSlidingSync(this.client);
      await this.app.completeLogin(this.client, this.passphrase, this.storeId);
    } catch (e) {
      this.setState({ busy: false, error: describe(e, "Registration failed.") });
    }
  }

  /** Legacy SSO login (popup flow, see sso.ts). */
  async loginWithSso(idpId?: string): Promise<void> {
    if (!this.client || !this.passphrase || !this.storeId) return;
    this.setState({ busy: true, error: null });
    try {
      const redirectUrl = ssoRedirectUrl();
      const handler = await this.client.startSsoLogin(redirectUrl, idpId);
      const callbackUrl = await runSsoPopup(handler.url(), redirectUrl);
      await handler.finish(callbackUrl);
      assertNativeSlidingSync(this.client);
      await this.app.completeLogin(this.client, this.passphrase, this.storeId);
    } catch (e) {
      this.setState({ busy: false, error: describe(e, "SSO sign-in failed or was cancelled.") });
    }
  }

  /** OIDC: stash rebuild state, then redirect the browser to the issuer. */
  async loginWithOidc(): Promise<void> {
    if (!this.client || !this.passphrase || !this.storeId) return;
    this.setState({ busy: true, error: null });
    try {
      const authData = await this.client.urlForOidc(
        getOidcConfiguration(),
        undefined,
        undefined,
        undefined,
        undefined,
      );
      savePendingOidc({
        homeserver: this.state.serverUrl ?? this.state.homeserver,
        storeId: this.storeId,
        passphrase: this.passphrase,
      });
      window.location.assign(authData.loginUrl());
    } catch (e) {
      this.setState({ busy: false, error: describe(e, "Couldn't start sign-in.") });
    }
  }
}

/**
 * Finish an OIDC redirect on app load: rebuild the auth client against the same
 * isolated store and complete the login. Returns true if a callback was handled.
 */
export async function completeOidcCallbackIfPresent(app: AppState): Promise<boolean> {
  const pending = takePendingOidc();
  if (!pending) return false;
  const callbackUrl = window.location.href;
  // Clean the URL so a reload doesn't re-trigger.
  window.history.replaceState({}, "", "/");
  try {
    const { client } = await createAuthenticationClient(
      pending.homeserver,
      app.sessionDelegate,
      app.sessionStore.storeName(pending.storeId),
      pending.storeId,
    );
    await client.loginWithOidcCallback(callbackUrl);
    assertNativeSlidingSync(client);
    await app.completeLogin(client, pending.passphrase, pending.storeId);
    return true;
  } catch (e) {
    console.error("OIDC callback failed", e);
    try {
      sessionStorage.setItem(AUTH_ERROR_KEY, "Sign-in couldn't be completed. Please try again.");
    } catch {
      /* storage unavailable */
    }
    return false;
  }
}

/**
 * Registers an account via UIA, satisfying the registration-token stage (this
 * homeserver's only registration flow) plus any trailing `m.login.dummy`.
 * `inhibit_login` avoids minting a device — the caller logs in through the SDK.
 */
async function registerAccount(
  base: string,
  username: string,
  password: string,
  token: string,
): Promise<void> {
  const url = `${base}/_matrix/client/v3/register`;
  let auth: Record<string, unknown> | undefined;
  let sessionId: string | undefined;
  // Bounded: a single token stage (optionally + dummy).
  for (let i = 0; i < 5; i++) {
    const body: Record<string, unknown> = {
      username,
      password,
      initial_device_display_name: "Discourse (Web)",
      inhibit_login: true,
    };
    if (auth) body.auth = auth;
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const json: any = await res.json().catch(() => ({}));
    if (res.status === 200) return;
    if (res.status === 401) {
      sessionId = json.session ?? sessionId;
      if (!sessionId) throw new Error("Registration couldn't start on this homeserver.");
      const completed: string[] = json.completed ?? [];
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const stages: string[] = (json.flows ?? []).flatMap((f: any) => f.stages ?? []);
      if (stages.length && !stages.includes("m.login.registration_token")) {
        throw new Error("This homeserver doesn't allow creating an account from the app.");
      }
      auth = completed.includes("m.login.registration_token")
        ? { type: "m.login.dummy", session: sessionId }
        : { type: "m.login.registration_token", token, session: sessionId };
    } else {
      throw new Error(registrationError(json, res.status));
    }
  }
  throw new Error("Registration didn't complete. Please try again.");
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function registrationError(json: any, status: number): string {
  const msg = typeof json?.error === "string" && json.error ? json.error : null;
  switch (json?.errcode) {
    case "M_USER_IN_USE":
      return "That username is already taken.";
    case "M_INVALID_USERNAME":
      return "That username isn't allowed. Use lowercase letters, numbers, and ._=-/";
    case "M_WEAK_PASSWORD":
      return msg ? `Weak password: ${msg}` : "That password is too weak.";
    case "M_EXCLUSIVE":
      return "That username is reserved.";
    case "M_FORBIDDEN":
      return "That registration token isn't valid.";
    default:
      return msg ?? `Registration failed (HTTP ${status}).`;
  }
}

function describe(e: unknown, fallback: string): string {
  if (e && typeof e === "object" && "message" in e) {
    const m = String((e as { message: unknown }).message);
    if (m) return m;
  }
  return typeof e === "string" && e ? e : fallback;
}
