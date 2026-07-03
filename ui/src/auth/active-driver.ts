/** Resolves the active auth driver from VITE_AUTH_PROVIDER (see provider.ts). */
import type { AuthDriver } from './auth-driver';
import { isKeycloak } from './provider';
import { keycloakDriver } from './keycloak-driver';
import { msalDriver } from './msal-driver';

export const activeDriver: AuthDriver = isKeycloak ? keycloakDriver : msalDriver;
