/** MSAL configuration — Vite env vars compiled at build time. */
import { Configuration, LogLevel } from '@azure/msal-browser';

// Backend API's client ID — this becomes an access token's `aud` claim.
const apiAudience = import.meta.env.VITE_API_CLIENT_ID || import.meta.env.VITE_AZURE_AD_CLIENT_ID;

export const msalConfig: Configuration = {
  auth: {
    clientId: import.meta.env.VITE_AZURE_AD_CLIENT_ID,
    authority: `https://login.microsoftonline.com/${import.meta.env.VITE_AZURE_TENANT_ID ?? 'common'}`,
  },
  cache: {
    cacheLocation: 'sessionStorage', // auto-renews tokens — no redirect after first login
  },
};

// Token audience: the backend app registration's API endpoint (api://client-id/.default)
export const apiScope = `api://${apiAudience}/.default`;
