/**
 * Retrieval shim — public surface. The local, zero-cloud stand-in for the Azure AI Search read model
 * with an identical claims-based security trim (ARCHITECTURE §5.2–5.4). The M2 capability server and
 * the orchestrator import from here; at M4 only `retrieval-index.ts` swaps to a real AI Search client
 * behind the SAME `SecurityDecision` / `TrimmedResult` contract.
 */
export * from './types';
export * from './labels';
export * from './security';
export * from './personas';
export * from './retrieval-index';
