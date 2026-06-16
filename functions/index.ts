/**
 * functions/index.ts — Entry point for Azure Durable Functions.
 * 
 * All activities are registered directly in their own files via `app.activity()`.
 * The orchestrator is registered in its own file via `app.orchestration()`.
 * This file only configures the durable task extension bundle and exports nothing else.
 * 
 * NOTE: This file intentionally does NOT contain persistence helpers. See
 * `functions/src/persistence/index.ts` for the actual Azure Functions persistence layer.
 */

// No-op entry — all function registrations happen at import time in their respective files.
export {};
