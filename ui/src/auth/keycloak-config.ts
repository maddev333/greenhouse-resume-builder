/**
 * Keycloak (generic OIDC) configuration for oidc-client-ts.
 *
 * Build-time Vite env (restart `npm run dev -w @greenhouse-resume-builder/ui` after changing):
 *   VITE_AUTH_PROVIDER=keycloak
 *   VITE_KEYCLOAK_URL=https://<host>            (base URL, no trailing /realms/...)
 *   VITE_KEYCLOAK_REALM=<realm>                 (a dedicated realm — avoid `master`, which is admin)
 *   VITE_KEYCLOAK_CLIENT_ID=<public spa client> (Standard flow enabled, PKCE S256, public client)
 *   VITE_KEYCLOAK_SCOPE=openid profile email    (optional; add your API/audience scope here)
 *
 * The Keycloak client's Valid Redirect URIs / Web Origins must include this app's origin.
 */
import { UserManagerSettings, WebStorageStateStore } from 'oidc-client-ts';

const url = (import.meta.env.VITE_KEYCLOAK_URL || '').toString().replace(/\/+$/, '');
const realm = (import.meta.env.VITE_KEYCLOAK_REALM || '').toString();
export const keycloakClientId = (import.meta.env.VITE_KEYCLOAK_CLIENT_ID || '').toString();
const scope = (import.meta.env.VITE_KEYCLOAK_SCOPE || 'openid profile email').toString();

/** OIDC issuer/authority — oidc-client-ts discovers endpoints from `${authority}/.well-known/openid-configuration`. */
export const keycloakAuthority = url && realm ? `${url}/realms/${realm}` : '';

export const isKeycloakConfigured = Boolean(keycloakAuthority && keycloakClientId);

const cacheLocation =
  (import.meta.env.VITE_AUTH_CACHE_LOCATION as 'sessionStorage' | 'localStorage' | undefined) ?? 'sessionStorage';

export const keycloakSettings: UserManagerSettings = {
  authority: keycloakAuthority,
  client_id: keycloakClientId,
  // redirectUri is the app origin so the SPA (loaded in popup / silent iframe / top window) runs the
  // callback handler in main.tsx — mirroring the MSAL redirect-bridge model.
  redirect_uri: window.location.origin,
  post_logout_redirect_uri: window.location.origin,
  popup_redirect_uri: window.location.origin,
  silent_redirect_uri: window.location.origin,
  response_type: 'code', // authorization code + PKCE (S256) — Keycloak supports S256
  scope,
  automaticSilentRenew: false, // we renew explicitly in getAccessToken()
  loadUserInfo: false, // id_token claims (name/email/preferred_username) are sufficient
  userStore: new WebStorageStateStore({
    store: cacheLocation === 'localStorage' ? window.localStorage : window.sessionStorage,
  }),
};

/**
 * True when the current document URL carries an OIDC authorization-code response (`code`/`error`
 * alongside `state`). Present in the popup, the silent-renew iframe, and the top window after a
 * redirect — in all cases the document must run the oidc-client-ts callback instead of booting a
 * second app (see main.tsx).
 */
export function hasOidcAuthResponseInUrl(): boolean {
  if (typeof window === 'undefined') return false;
  const check = (raw: string): boolean => {
    if (!raw) return false;
    const params = new URLSearchParams(raw);
    if (!params.has('state')) return false;
    return params.has('code') || params.has('error') || params.has('session_state');
  };
  return check(window.location.search.replace(/^\?/, '')) || check(window.location.hash.replace(/^#/, ''));
}
