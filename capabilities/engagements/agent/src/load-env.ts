/**
 * Load the repo-root `.env` so the orchestrator sees the shared runtime config
 * (`AZURE_OPENAI_*`, `ENGAGEMENTS_*`, `RETRIEVAL_BACKEND`, ...) without hand-exporting it.
 * Imported FIRST by every entry point. Never overrides shell-set variables (dotenv default),
 * so `cross-env ENGAGEMENTS_TOP_N=5 ...` still wins.
 *
 * `.env` lives four levels up: capabilities/engagements/agent/src -> repo root.
 */
import { config as loadDotenv } from "dotenv";
import { resolve } from "node:path";

loadDotenv({
  path: resolve(import.meta.dirname, "..", "..", "..", "..", ".env"),
});
