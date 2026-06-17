// This module loads dotenv BEFORE any other module imports process.env.
// Import this FIRST in server.ts (before all other imports).
import { config as loadDotenv } from 'dotenv';
const env = loadDotenv({ path: '/Users/nick/repos/greenhouse-resume-builder/.env' });
if (!env.parsed) throw new Error('Failed to load /Users/nick/repos/greenhouse-resume-builder/.env');
process.env.NODE_ENV = process.env.NODE_ENV || 'development';
