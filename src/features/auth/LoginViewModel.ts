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

  backToServer(): void {
    this.client = undefined;
    this.setState({ stage: "server", methods: null, error: null, password: "" });
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

function describe(e: unknown, fallback: string): string {
  if (e && typeof e === "object" && "message" in e) {
    const m = String((e as { message: unknown }).message);
    if (m) return m;
  }
  return typeof e === "string" && e ? e : fallback;
}
