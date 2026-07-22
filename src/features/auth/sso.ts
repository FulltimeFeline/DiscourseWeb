// Legacy (non-OIDC) SSO. Uses a popup (not a full-page redirect) so the in-memory
// SsoHandler survives to call finish() on the callback URL. We poll the popup's
// location (readable only once it navigates back to our origin) for the callback,
// then close it.

const SSO_CALLBACK_PATH = "/sso/callback";

export function ssoRedirectUrl(): string {
  return `${window.location.origin}${SSO_CALLBACK_PATH}`;
}

/** Open the IdP URL in a popup and resolve with the callback URL it lands on. */
export function runSsoPopup(url: string, redirectPrefix: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const popup = window.open(url, "discourse-sso", "width=640,height=760");
    if (!popup) {
      reject(new Error("Popup blocked — allow popups to sign in with SSO."));
      return;
    }
    const timer = window.setInterval(() => {
      try {
        if (popup.closed) {
          window.clearInterval(timer);
          reject(new Error("SSO window was closed."));
          return;
        }
        // Throws while the popup is on the cross-origin identity provider.
        const href = popup.location.href;
        if (href.startsWith(redirectPrefix)) {
          window.clearInterval(timer);
          popup.close();
          resolve(href);
        }
      } catch {
        /* still on the IdP, keep waiting */
      }
    }, 300);
  });
}

/** True when this document is the SSO popup landing on the callback route; the
 *  opener reads our URL and closes us, so we must not boot the full app. */
export function isSsoCallbackPopup(): boolean {
  return !!window.opener && window.location.pathname.startsWith(SSO_CALLBACK_PATH);
}
