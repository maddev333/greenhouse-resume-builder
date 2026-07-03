/** Selects the active auth provider at build time via VITE_AUTH_PROVIDER (default: entra). */

export type AuthProviderId = 'entra' | 'keycloak';

const raw = (import.meta.env.VITE_AUTH_PROVIDER || 'entra').toString().trim().toLowerCase();

export const authProvider: AuthProviderId = raw === 'keycloak' ? 'keycloak' : 'entra';
export const isKeycloak = authProvider === 'keycloak';
