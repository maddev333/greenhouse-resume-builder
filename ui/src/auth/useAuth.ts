/** Authentication state — login with MSAL and silently refresh API access tokens. */

import { useCallback, useEffect, useSyncExternalStore } from 'react';
import {
  AccountInfo,
  AuthenticationResult,
  InteractionRequiredAuthError,
  PublicClientApplication,
} from '@azure/msal-browser';
import { isAuthConfigured, loginRequest, msalConfig } from './msal-config';

interface AuthSnapshot {
  authenticated: boolean;
  loading: boolean;
  user: AccountInfo | null;
  accessToken: string | null;
  error: string | null;
}

export interface AuthState extends AuthSnapshot {
  login: () => Promise<void>;
  logout: () => Promise<void>;
  getToken: () => string | null;
  getAccessToken: () => Promise<string | null>;
}

let pca: PublicClientApplication | null = null;
let initializePromise: Promise<void> | null = null;
let snapshot: AuthSnapshot = {
  authenticated: false,
  loading: true,
  user: null,
  accessToken: null,
  error: null,
};
const listeners = new Set<() => void>();

function emit(next: Partial<AuthSnapshot>): void {
  snapshot = { ...snapshot, ...next };
  listeners.forEach((listener) => listener());
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function getSnapshot(): AuthSnapshot {
  return snapshot;
}

function getClient(): PublicClientApplication {
  if (!pca) pca = new PublicClientApplication(msalConfig);
  return pca;
}

function activeAccount(client: PublicClientApplication): AccountInfo | null {
  return client.getActiveAccount() ?? client.getAllAccounts()[0] ?? null;
}

function applyAuthResult(client: PublicClientApplication, result: AuthenticationResult): void {
  if (result.account) client.setActiveAccount(result.account);
  emit({
    authenticated: true,
    loading: false,
    user: result.account ?? activeAccount(client),
    accessToken: result.accessToken,
    error: null,
  });
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function isPopupFallbackCandidate(err: any): boolean {
  return ['popup_window_error', 'empty_window_error', 'block_nested_popups'].includes(err?.errorCode);
}

async function acquireTokenForAccount(client: PublicClientApplication, account: AccountInfo): Promise<string | null> {
  try {
    const result = await client.acquireTokenSilent({ ...loginRequest, account });
    applyAuthResult(client, result);
    return result.accessToken;
  } catch (err) {
    if (err instanceof InteractionRequiredAuthError) {
      emit({ authenticated: false, loading: false, accessToken: null, error: null });
      return null;
    }
    emit({ authenticated: false, loading: false, accessToken: null, error: errorMessage(err) });
    return null;
  }
}

async function initializeAuth(): Promise<void> {
  if (initializePromise) return initializePromise;

  initializePromise = (async () => {
    if (!isAuthConfigured) {
      emit({
        authenticated: false,
        loading: false,
        accessToken: null,
        error: 'Entra ID is not configured. Set VITE_AZURE_AD_CLIENT_ID and VITE_API_CLIENT_ID or VITE_API_SCOPE.',
      });
      return;
    }

    const client = getClient();
    emit({ loading: true });
    try {
      await client.initialize();
      const redirectResult = await client.handleRedirectPromise();
      if (redirectResult) {
        applyAuthResult(client, redirectResult);
        return;
      }

      const account = activeAccount(client);
      if (account) {
        client.setActiveAccount(account);
        await acquireTokenForAccount(client, account);
        return;
      }

      try {
        const result = await client.ssoSilent(loginRequest);
        applyAuthResult(client, result);
      } catch {
        emit({ authenticated: false, loading: false, accessToken: null, user: null, error: null });
      }
    } catch (err) {
      emit({ authenticated: false, loading: false, accessToken: null, user: null, error: errorMessage(err) });
    }
  })();

  return initializePromise;
}

export async function getAccessToken(): Promise<string | null> {
  if (!isAuthConfigured) return null;
  await initializeAuth();
  const client = getClient();
  const account = activeAccount(client);
  if (!account) return null;
  return acquireTokenForAccount(client, account);
}

async function login(): Promise<void> {
  if (!isAuthConfigured) {
    emit({
      authenticated: false,
      loading: false,
      accessToken: null,
      error: 'Entra ID is not configured. Set VITE_AZURE_AD_CLIENT_ID and VITE_API_CLIENT_ID or VITE_API_SCOPE.',
    });
    return;
  }
  await initializeAuth();
  const client = getClient();
  emit({ loading: true, error: null });

  try {
    const result = await client.loginPopup(loginRequest);
    applyAuthResult(client, result);
  } catch (err: any) {
    if (isPopupFallbackCandidate(err)) {
      await client.loginRedirect(loginRequest);
      return;
    }
    emit({ authenticated: false, loading: false, accessToken: null, user: null, error: errorMessage(err) });
  }
}

async function logout(): Promise<void> {
  if (!isAuthConfigured) return;
  await initializeAuth();
  const client = getClient();
  const account = activeAccount(client);
  emit({ authenticated: false, loading: false, user: null, accessToken: null, error: null });
  await client.logoutRedirect({ account: account ?? undefined, postLogoutRedirectUri: window.location.origin });
}

/** Returns shared auth state. Multiple components subscribe to the same MSAL client/session. */
export function useAuth(): AuthState {
  const auth = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

  useEffect(() => {
    void initializeAuth();
  }, []);

  return {
    ...auth,
    login: useCallback(login, []),
    logout: useCallback(logout, []),
    getToken: useCallback(() => snapshot.accessToken, []),
    getAccessToken: useCallback(getAccessToken, []),
  };
}
