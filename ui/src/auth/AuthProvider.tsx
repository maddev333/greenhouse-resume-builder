/** Auth context provider — wraps the app with MSAL login/logoud state. */

import React, { createContext, useContext, useState, useEffect } from 'react';
import { PublicClientApplication } from '@azure/msal-browser';
import { msalConfig } from './msal-config';

export const AuthContext = createContext({
  user: null as any | null,
  isAuthenticated: false,
  login: () => {},
  logout: () => {},
  accessToken: null as string | null,
});

interface MsalState {
  user: any | null;
  isAuthenticated: boolean;
  login: () => void;
  logout: () => void;
  accessToken: string | null;
}

const msalInstance = new PublicClientApplication(msalConfig);

// Simple MSAL state wrapper for your app
export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<MsalState>({ user: null, isAuthenticated: false, login: () => {}, logout: () => {}, accessToken: null });

  // Auto-login on mount — try silent first, fall back to popup
  useEffect(() => {
    msalInstance.loginRedirect({ scopes: ['api://<BACKEND_CLIENT_ID>/.default'] });
  }, []);

  return (
    <AuthContext.Provider value={state}>
      {children}
    </AuthContext.Provider>
  );
}

export const useAuthState = () => useContext(AuthContext);
