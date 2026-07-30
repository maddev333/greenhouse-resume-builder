/**
 * Load the repo-root `.env` so `AZURE_MAPS_*` / `DISCOVERY_*` are available without exporting them by
 * hand. Imported FIRST by every entry point. Never overrides variables already set in the shell
 * (dotenv default), so `cross-env DISCOVERY_MCP_PORT=4011 ...` still wins.
 *
 * `.env` lives five levels up: capabilities/engagements/mcp/discovery/src → repo root.
 */
import { config as loadDotenv } from "dotenv";
import { resolve } from "node:path";

loadDotenv({
  path: resolve(import.meta.dirname, "..", "..", "..", "..", "..", ".env"),
});
