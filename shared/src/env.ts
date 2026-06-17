/**
 * Centralized environment configuration loader for Greenhouse Resume Builder.
 * Import this at the top of any entry point to ensure environment variables are loaded.
 */

import { config } from 'dotenv';
import { resolve } from 'path';
import { existsSync } from 'fs';

// Detect project root (walk up from current file until we find package.json)
function findProjectRoot(startPath: string): string {
  let currentPath = startPath;
  
  while (true) {
    const packagePath = resolve(currentPath, 'package.json');
    if (existsSync(packagePath)) {
      return currentPath;
    }
    
    const parentPath = resolve(currentPath, '..');
    if (parentPath === currentPath) {
      // Reached filesystem root without finding package.json
      throw new Error('Could not find project root (no package.json found)');
    }
    
    currentPath = parentPath;
  }
}

// Find and load environment files
let _loaded = false;

export function loadEnvironment(): void {
  if (_loaded) {
    return; // Already loaded
  }

  try {
    const projectRoot = findProjectRoot(__dirname);
    
    // Load .env first (defaults)
    const envPath = resolve(projectRoot, '.env');
    if (existsSync(envPath)) {
      const result = config({ path: envPath });
      if (result.error) {
        console.warn('[env] Warning loading .env:', result.error.message);
      } else {
        console.log('[env] Loaded', envPath);
      }
    } else {
      console.warn('[env] No .env file found at', envPath);
    }

    // Load .env.local second (overrides)
    const envLocalPath = resolve(projectRoot, '.env.local');
    if (existsSync(envLocalPath)) {
      const result = config({ path: envLocalPath, override: true });
      if (result.error) {
        console.warn('[env] Warning loading .env.local:', result.error.message);
      } else {
        console.log('[env] Loaded', envLocalPath);
      }
    }

    _loaded = true;
  } catch (error) {
    console.error('[env] Failed to load environment:', error);
    throw error;
  }
}

// Auto-load when this module is imported
loadEnvironment();

// Export commonly used environment variables with defaults
export const env = {
  // Server
  PORT: Number(process.env.PORT ?? 3001),
  NODE_ENV: process.env.NODE_ENV ?? 'development',
  
  // PostgreSQL
  PGHOST: process.env.PGHOST,
  PGPORT: Number(process.env.PGPORT ?? 5432),
  PGDATABASE: process.env.PGDATABASE ?? 'resume_builder',
  PGUSER: process.env.PGUSER ?? 'postgres',
  PGPASSWORD: process.env.PGPASSWORD,
  PGSSLMODE: process.env.PGSSLMODE,
  DATABASE_URL: process.env.DATABASE_URL,
  
  // Azure Auth
  AZURE_TENANT_ID: process.env.AZURE_TENANT_ID,
  AZURE_AD_CLIENT_ID: process.env.AZURE_AD_CLIENT_ID,
  AZURE_AD_JWKS_URI: process.env.AZURE_AD_JWKS_URI,
  ALLOW_DEV_AUTH_BYPASS: process.env.ALLOW_DEV_AUTH_BYPASS === 'true',
  
  // Azure Services
  AZURE_STORAGE_ACCOUNT_NAME: process.env.AZURE_STORAGE_ACCOUNT_NAME,
  AZURE_STORAGE_CONTAINER: process.env.AZURE_STORAGE_CONTAINER ?? 'raw',
  AZURE_OPENAI_ENDPOINT: process.env.AZURE_OPENAI_ENDPOINT,
  AZURE_OPENAI_DEPLOYMENT: process.env.AZURE_OPENAI_DEPLOYMENT,
  AZURE_SEARCH_SERVICE: process.env.AZURE_SEARCH_SERVICE,
  AZURE_DOCUMENT_INTELLIGENCE_ENDPOINT: process.env.AZURE_DOCUMENT_INTELLIGENCE_ENDPOINT,
  
  // Functions
  AzureWebJobsStorage: process.env.AzureWebJobsStorage,
};

export default env;
