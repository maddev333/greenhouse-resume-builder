/**
 * Retrieval shim — public surface. The local, zero-cloud stand-in for the Azure AI Search read model
 * (ARCHITECTURE §5.2). The M2 capability server and the orchestrator import from here; at M4 only
 * `retrieval-index.ts` swaps to a real AI Search client behind the SAME result contract.
 */
export * from "./types";
export * from "./labels";
export * from "./index-schema";
export * from "./grounding";
export * from "./retrieval-index";
export * from "./search-backend";
