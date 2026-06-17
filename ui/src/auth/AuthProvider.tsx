/** Auth context provider — wraps the app with shared MSAL state. */

import React, { createContext, useContext } from 'react';
import { useAuth } from './useAuth';

export const AuthContext = createContext({
  user: null as any | null,
  isAuthenticated: false,
  login: async () => {},
  logout: async () => {},
  accessToken: null as string | null,
});

interface MsalState {
  user: any | null;
  isAuthenticated: boolean;
  login: () => Promise<void>;
  logout: () => Promise<void>;
  accessToken: string | null;
}

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const auth = useAuth();
  const state: MsalState = {
    user: auth.user,
    isAuthenticated: auth.authenticated,
    login: auth.login,
    logout: auth.logout,
    accessToken: auth.accessToken,
  };

  return (
    <AuthContext.Provider value={state}>
      {children}
    </AuthContext.Provider>
  );
}

export const useAuthState = () => useContext(AuthContext);
