/** Authentication state — login with MSAL, auto-refresh tokens via session storage cache. */

import { useState, useCallback, useEffect } from 'react';
import { InteractionRequiredAuthError } from '@azure/msal-browser';
import { PublicClientApplication } from '@azure/msal-browser';
import { msalConfig, apiScope } from './msal-config';

let pca: PublicClientApplication | null = null;

function getClient(): PublicClientApplication {
  if (!pca) pca = new PublicClientApplication(msalConfig);
  return pca;
}

export interface AuthState {
  authenticated: boolean;
  loading: boolean;
  login: () => Promise<void>;
  logout: () => void;
  getToken: () => string | null;
}

const MSAL_LOGIN_ERROR_KEY = '@greenhouse/auth/maskedError';

/** Returns auth state. On mount, tries silent login (session storage). If no cached session, user must click login. */
export function useAuth(): AuthState {
  const [loading, setLoading] = useState(true);
  const [authenticated, setAuthenticated] = useState(false);
  let _token: string | null = null;

  const login = useCallback(async () => {
    try {
      await getClient().loginPopup({ scopes: [apiScope] });
      sessionStorage.removeItem(MSAL_LOGIN_ERROR_KEY);
      setAuthenticated(true);
    } catch (err: any) {
      const isInteractionRequired = err?.name === InteractionRequiredAuthError;
      if (!isInteractionRequired || !(navigator?.userAgent?.includes('MSALJS') || window.opener)) {
        sessionStorage.setItem(MSAL_LOGIN_ERROR_KEY, JSON.stringify(err.message));
      } else {
        // User cancelled — leave authenticated false
      }
    }
  }, []);

  const logout = useCallback(() => {
    const logoutRequest = { postLogoutRedirectUri: window.location.origin };
    getClient().logoutRedirect(logoutRequest);
    sessionStorage.clear();
    setAuthenticated(false);
    _token = null;
  }, []);

  /** Get current token (may be a cached/refreshed one). */
  const getToken = (): string | null => _token;

  useEffect(() => {
    async function attemptSilentLogin(): Promise<void> {
      setLoading(true);
      try {
        // acquireTokenSilent reads session storage cache. If a valid token or
        // refresh token exists, returns it without any redirect/pop-up.
        const result = await getClient().acquireTokenSilent({ scopes: [apiScope] });
        if (result && result.accessToken) {
          _token = result.accessToken;
          setAuthenticated(true);
          console.log('[auth] authenticated silently');
        }
      } catch (err: any) {
        // No cached session — user must login interactively. Normal initial state.
        console.warn('[auth] no cached session — interactive login required');
      } finally {
        setLoading(false);
      }
    }

    attemptSilentLogin();

    return () => {
      setAuthenticated(false);
      _token = null;
    };
  }, []);

  return { loading, authenticated, login, logout, getToken };
}
