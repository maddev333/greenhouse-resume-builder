/**
 * Keycloak (generic OIDC) auth driver, built on oidc-client-ts. Mirrors the MSAL driver's popup-first
 * flow with a silent-iframe token refresh and a full-page redirect fallback when popups are blocked.
 */
import { User, UserManager } from 'oidc-client-ts';
import { hasOidcAuthResponseInUrl, isKeycloakConfigured, keycloakSettings } from './keycloak-config';
import { AuthDriver, createAuthStore } from './auth-driver';

const NOT_CONFIGURED =
  'Keycloak is not configured. Set VITE_KEYCLOAK_URL, VITE_KEYCLOAK_REALM and VITE_KEYCLOAK_CLIENT_ID.';

const store = createAuthStore();

let manager: UserManager | null = null;
let initializePromise: Promise<void> | null = null;

function mgr(): UserManager {
  if (!manager) manager = new UserManager(keycloakSettings);
  return manager;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function applyUser(user: User): void {
  store.emit({
    authenticated: true,
    loading: false,
    user: {
      ...user.profile,
      username: user.profile.preferred_username,
      name: user.profile.name,
    },
    accessToken: user.access_token ?? null,
    error: null,
  });
}

function clearAuth(error: string | null): void {
  store.emit({ authenticated: false, loading: false, user: null, accessToken: null, error });
}

async function initialize(): Promise<void> {
  if (initializePromise) return initializePromise;

  initializePromise = (async () => {
    if (!isKeycloakConfigured) {
      clearAuth(NOT_CONFIGURED);
      return;
    }
    store.emit({ loading: true });
    try {
      const existing = await mgr().getUser();
      if (existing && !existing.expired && existing.access_token) {
        applyUser(existing);
        return;
      }
      try {
        const renewed = await mgr().signinSilent();
        if (renewed) {
          applyUser(renewed);
          return;
        }
      } catch {
        // No active SSO session — remain signed out.
      }
      clearAuth(null);
    } catch (err) {
      clearAuth(errorMessage(err));
    }
  })();

  return initializePromise;
}

async function getAccessToken(): Promise<string | null> {
  if (!isKeycloakConfigured) return null;
  await initialize();
  try {
    let user = await mgr().getUser();
    if (user && !user.expired && user.access_token) {
      applyUser(user);
      return user.access_token;
    }
    user = await mgr().signinSilent();
    if (user?.access_token) {
      applyUser(user);
      return user.access_token;
    }
  } catch {
    clearAuth(null);
  }
  return null;
}

async function login(): Promise<void> {
  if (!isKeycloakConfigured) {
    clearAuth(NOT_CONFIGURED);
    return;
  }
  await initialize();
  store.emit({ loading: true, error: null });

  try {
    const user = await mgr().signinPopup();
    applyUser(user);
  } catch (err) {
    const message = errorMessage(err);
    // User dismissed the popup — treat as a benign cancel, not an error.
    if (/closed by user|cancel/i.test(message)) {
      store.emit({ loading: false, error: null });
      return;
    }
    // Popup blocked / failed to open — fall back to a full-page redirect.
    try {
      await mgr().signinRedirect();
      return;
    } catch (redirectErr) {
      clearAuth(errorMessage(redirectErr));
    }
  }
}

async function logout(): Promise<void> {
  if (!isKeycloakConfigured) return;
  clearAuth(null);
  try {
    await mgr().signoutRedirect();
  } catch {
    // Fall back to a local sign-out if the end-session redirect is unavailable.
    await mgr()
      .removeUser()
      .catch(() => {});
  }
}

async function processAuthResponseInUrl(): Promise<boolean> {
  if (!hasOidcAuthResponseInUrl()) return false;

  const inIframe = typeof window !== 'undefined' && window.parent && window.parent !== window;
  const inPopup = typeof window !== 'undefined' && Boolean(window.opener) && window.opener !== window;

  try {
    if (inIframe) {
      await mgr().signinSilentCallback();
      return true; // iframe posts to parent; do not mount the app here
    }
    if (inPopup) {
      await mgr().signinPopupCallback();
      return true; // popup posts to opener and closes; do not mount
    }
    await mgr().signinRedirectCallback();
    // Strip the consumed auth params so a reload doesn't attempt to replay the code.
    window.history.replaceState({}, document.title, window.location.origin + window.location.pathname);
    return false; // mount the app after a top-level redirect completes
  } catch {
    return false;
  }
}

export const keycloakDriver: AuthDriver = {
  isConfigured: isKeycloakConfigured,
  subscribe: store.subscribe,
  getSnapshot: store.getSnapshot,
  initialize,
  login,
  logout,
  getAccessToken,
  processAuthResponseInUrl,
};
