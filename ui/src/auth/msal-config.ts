/** MSAL configuration — Vite env vars compiled at build time. */
import { Configuration, LogLevel } from '@azure/msal-browser';

const tenantId = import.meta.env.VITE_AZURE_TENANT_ID || 'common';
const authorityHost = (import.meta.env.VITE_AZURE_AUTHORITY_HOST || 'https://login.microsoftonline.com').replace(/\/+$/, '');

// Browser SPA client ID. This app signs the user in and requests tokens for the backend API.
export const entraClientId = import.meta.env.VITE_AZURE_AD_CLIENT_ID || '';

// Backend API audience. This becomes the access token's `aud` claim.
const apiAudience = import.meta.env.VITE_API_CLIENT_ID || entraClientId;

// Allow a fully custom scope for tenants that expose the API with a non-default App ID URI.
export const apiScope = import.meta.env.VITE_API_SCOPE || (apiAudience ? `api://${apiAudience}/.default` : '');
export const apiScopes = apiScope ? [apiScope] : [];

export const isAuthConfigured = Boolean(entraClientId && apiScopes.length > 0);

export const msalConfig: Configuration = {
  auth: {
    clientId: entraClientId,
    authority: `${authorityHost}/${tenantId}`,
    redirectUri: window.location.origin,
    postLogoutRedirectUri: window.location.origin,
  },
  cache: {
    cacheLocation: (import.meta.env.VITE_AUTH_CACHE_LOCATION as 'sessionStorage' | 'localStorage' | undefined) ?? 'sessionStorage',
  },
  system: {
    loggerOptions: {
      loggerCallback: (_level, message, containsPii) => {
        if (!containsPii && import.meta.env.DEV) console.debug(`[msal] ${message}`);
      },
      logLevel: LogLevel.Warning,
      piiLoggingEnabled: false,
    },
  },
};

export const loginRequest = { scopes: apiScopes };

/**
 * True when the current document URL carries an auth-server response from an MSAL sign-in handshake —
 * an authorization `code` (or an `error`/token) returned alongside the `state` parameter.
 *
 * Because `redirectUri` is the app origin, MSAL loads this whole SPA inside the sign-in popup, the
 * hidden ssoSilent / silent-renewal iframe, and the top window when returning from a redirect. In all
 * of those cases the document must hand the response to MSAL's redirect bridge instead of booting the
 * app (see main.tsx); booting a second MSAL client here races the parent over the shared
 * token-request cache and fails with `no_token_request_cache_error`.
 */
export function hasMsalAuthResponseInUrl(): boolean {
  if (typeof window === 'undefined') return false;
  const sources = [window.location.hash.replace(/^#/, ''), window.location.search.replace(/^\?/, '')];
  return sources.some((raw) => {
    if (!raw) return false;
    const params = new URLSearchParams(raw);
    if (!params.has('state')) return false;
    return params.has('code') || params.has('error') || params.has('id_token') || params.has('access_token');
  });
}
