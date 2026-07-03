/**
 * Provider-agnostic auth driver abstraction.
 *
 * The UI supports more than one identity provider (Microsoft Entra ID via MSAL, and generic OIDC —
 * currently Keycloak — via oidc-client-ts). Each provider implements this small interface, and
 * `useAuth()` renders whichever one the build selected (VITE_AUTH_PROVIDER). Keeping a single shape
 * means components (AuthBar, AuthProvider, api-auth) never learn which provider is active.
 */

export interface AuthUser {
  /** Human-readable sign-in name (`preferred_username`/UPN/email). */
  username?: string;
  name?: string;
  [claim: string]: unknown;
}

export interface AuthSnapshot {
  authenticated: boolean;
  loading: boolean;
  user: AuthUser | null;
  accessToken: string | null;
  error: string | null;
}

export interface AuthDriver {
  /** True once the provider has the minimum client config to attempt sign-in. */
  readonly isConfigured: boolean;
  subscribe(listener: () => void): () => void;
  getSnapshot(): AuthSnapshot;
  initialize(): Promise<void>;
  login(): Promise<void>;
  logout(): Promise<void>;
  getAccessToken(): Promise<string | null>;
  /**
   * Handle an auth-server response present in the current document URL (a popup / silent-iframe /
   * top-level redirect callback). Returns `true` when the response was handled and the app should
   * NOT mount (the window will close or navigate); `false` when there is nothing to handle or the
   * app should mount normally.
   */
  processAuthResponseInUrl(): Promise<boolean>;
}

export const INITIAL_SNAPSHOT: AuthSnapshot = {
  authenticated: false,
  loading: true,
  user: null,
  accessToken: null,
  error: null,
};

/** Minimal observable store shared by both drivers (feeds React's useSyncExternalStore). */
export function createAuthStore(initial: AuthSnapshot = INITIAL_SNAPSHOT) {
  let snapshot = initial;
  const listeners = new Set<() => void>();
  return {
    getSnapshot: (): AuthSnapshot => snapshot,
    subscribe(listener: () => void): () => void {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    emit(next: Partial<AuthSnapshot>): void {
      snapshot = { ...snapshot, ...next };
      listeners.forEach((listener) => listener());
    },
  };
}
