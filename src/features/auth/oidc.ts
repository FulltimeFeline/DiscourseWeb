// OIDC (MAS/next-gen auth) helpers. Login is a full-page redirect to the issuer
// and back to a callback route. Since a full redirect tears down the in-memory
// client, we stash just enough to rebuild it (the isolated store's id, passphrase
// and homeserver) and finish the flow with loginWithOidcCallback.

import type { OidcConfiguration } from "@/matrix";

export function getOidcConfiguration(): OidcConfiguration {
  const origin = window.location.origin;
  return {
    clientName: "Discourse",
    redirectUri: `${origin}/oidc/callback`,
    // Client metadata URL must be https and public; localhost dev falls back.
    clientUri: origin.includes("localhost")
      ? "https://github.com/FulltimeFeline/Discourse"
      : origin,
    logoUri: undefined,
    tosUri: undefined,
    policyUri: undefined,
    staticRegistrations: new Map(),
  };
}

export interface PendingOidc {
  homeserver: string;
  storeId: string;
  passphrase: string;
}

const KEY = "discourse.pendingOidc";

export function savePendingOidc(p: PendingOidc): void {
  sessionStorage.setItem(KEY, JSON.stringify(p));
}

export function takePendingOidc(): PendingOidc | undefined {
  const raw = sessionStorage.getItem(KEY);
  if (!raw) return undefined;
  sessionStorage.removeItem(KEY);
  try {
    return JSON.parse(raw) as PendingOidc;
  } catch {
    return undefined;
  }
}

/** True when the current URL is the OIDC redirect landing. */
export function isOidcCallback(): boolean {
  return (
    window.location.pathname.startsWith("/oidc/callback") &&
    /[?&](code|state|error)=/.test(window.location.search)
  );
}
