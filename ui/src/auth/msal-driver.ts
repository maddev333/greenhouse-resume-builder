/**
 * Microsoft Entra ID auth driver (MSAL). This is the original useAuth implementation, extracted
 * behind the shared AuthDriver interface so `useAuth()` can pick between providers. Behaviour is
 * unchanged from the pre-Keycloak implementation when VITE_AUTH_PROVIDER is unset/`entra`.
 */
import {
  AccountInfo,
  AuthenticationResult,
  InteractionRequiredAuthError,
  PublicClientApplication,
} from '@azure/msal-browser';
import { broadcastResponseToMainFrame } from '@azure/msal-browser/redirect-bridge';
import { hasMsalAuthResponseInUrl, isAuthConfigured, loginRequest, msalConfig } from './msal-config';
import { AuthDriver, createAuthStore } from './auth-driver';

const store = createAuthStore();

let pca: PublicClientApplication | null = null;
let initializePromise: Promise<void> | null = null;

function getClient(): PublicClientApplication {
  if (!pca) pca = new PublicClientApplication(msalConfig);
  return pca;
}

function activeAccount(client: PublicClientApplication): AccountInfo | null {
  return client.getActiveAccount() ?? client.getAllAccounts()[0] ?? null;
}

function applyAuthResult(client: PublicClientApplication, result: AuthenticationResult): void {
  if (result.account) client.setActiveAccount(result.account);
  store.emit({
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
      store.emit({ authenticated: false, loading: false, accessToken: null, error: null });
      return null;
    }
    store.emit({ authenticated: false, loading: false, accessToken: null, error: errorMessage(err) });
    return null;
  }
}

async function initialize(): Promise<void> {
  if (initializePromise) return initializePromise;

  initializePromise = (async () => {
    if (!isAuthConfigured) {
      store.emit({
        authenticated: false,
        loading: false,
        accessToken: null,
        error: 'Entra ID is not configured. Set VITE_AZURE_AD_CLIENT_ID and VITE_API_CLIENT_ID or VITE_API_SCOPE.',
      });
      return;
    }

    const client = getClient();
    store.emit({ loading: true });
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
        store.emit({ authenticated: false, loading: false, accessToken: null, user: null, error: null });
      }
    } catch (err) {
      store.emit({ authenticated: false, loading: false, accessToken: null, user: null, error: errorMessage(err) });
    }
  })();

  return initializePromise;
}

async function getAccessToken(): Promise<string | null> {
  if (!isAuthConfigured) return null;
  await initialize();
  const client = getClient();
  const account = activeAccount(client);
  if (!account) return null;
  return acquireTokenForAccount(client, account);
}

async function login(): Promise<void> {
  if (!isAuthConfigured) {
    store.emit({
      authenticated: false,
      loading: false,
      accessToken: null,
      error: 'Entra ID is not configured. Set VITE_AZURE_AD_CLIENT_ID and VITE_API_CLIENT_ID or VITE_API_SCOPE.',
    });
    return;
  }
  await initialize();
  const client = getClient();
  store.emit({ loading: true, error: null });

  try {
    const result = await client.loginPopup(loginRequest);
    applyAuthResult(client, result);
  } catch (err: any) {
    if (isPopupFallbackCandidate(err)) {
      await client.loginRedirect(loginRequest);
      return;
    }
    store.emit({ authenticated: false, loading: false, accessToken: null, user: null, error: errorMessage(err) });
  }
}

async function logout(): Promise<void> {
  if (!isAuthConfigured) return;
  await initialize();
  const client = getClient();
  const account = activeAccount(client);
  store.emit({ authenticated: false, loading: false, user: null, accessToken: null, error: null });
  await client.logoutRedirect({ account: account ?? undefined, postLogoutRedirectUri: window.location.origin });
}

async function processAuthResponseInUrl(): Promise<boolean> {
  if (!hasMsalAuthResponseInUrl()) return false;
  // Hand the response to MSAL's redirect bridge (posts to the main frame / caches + navigates back).
  // On any unexpected failure, fall through so the app still mounts and the user isn't stranded.
  try {
    await broadcastResponseToMainFrame();
    return true;
  } catch {
    return false;
  }
}

export const msalDriver: AuthDriver = {
  isConfigured: isAuthConfigured,
  subscribe: store.subscribe,
  getSnapshot: store.getSnapshot,
  initialize,
  login,
  logout,
  getAccessToken,
  processAuthResponseInUrl,
};
