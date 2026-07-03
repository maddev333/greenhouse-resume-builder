/**
 * Authentication state hook. Delegates to whichever provider the build selected
 * (VITE_AUTH_PROVIDER — Entra/MSAL by default, or Keycloak/OIDC). Components consume this identical
 * interface regardless of provider; see auth-driver.ts and active-driver.ts.
 */

import { useCallback, useEffect, useSyncExternalStore } from 'react';
import { activeDriver } from './active-driver';
import type { AuthSnapshot } from './auth-driver';

export interface AuthState extends AuthSnapshot {
  login: () => Promise<void>;
  logout: () => Promise<void>;
  getToken: () => string | null;
  getAccessToken: () => Promise<string | null>;
}

/** True when the active provider has enough client config to attempt sign-in. */
export const isAuthConfigured = activeDriver.isConfigured;

/** Silently acquire (refreshing if needed) an API access token for the active provider. */
export function getAccessToken(): Promise<string | null> {
  return activeDriver.getAccessToken();
}

/**
 * Handle an auth-server response in the current URL (popup / silent-iframe / redirect callback).
 * Returns true when handled and the app should NOT mount. Called from main.tsx before booting.
 */
export function processAuthResponseInUrl(): Promise<boolean> {
  return activeDriver.processAuthResponseInUrl();
}

/** Returns shared auth state. Multiple components subscribe to the same provider session. */
export function useAuth(): AuthState {
  const auth = useSyncExternalStore(activeDriver.subscribe, activeDriver.getSnapshot, activeDriver.getSnapshot);

  useEffect(() => {
    void activeDriver.initialize();
  }, []);

  return {
    ...auth,
    login: useCallback(() => activeDriver.login(), []),
    logout: useCallback(() => activeDriver.logout(), []),
    getToken: useCallback(() => activeDriver.getSnapshot().accessToken, []),
    getAccessToken: useCallback(() => activeDriver.getAccessToken(), []),
  };
}
