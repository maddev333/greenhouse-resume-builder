import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import { parse as parseDotenv } from "dotenv";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

/** Read one key from the nearest .env up the tree (the repo root) without mutating process.env. */
function nearestEnvValue(key: string): string | undefined {
  let dir = here;
  for (let i = 0; i < 8; i++) {
    const envPath = resolve(dir, ".env");
    if (existsSync(envPath)) {
      const parsed = parseDotenv(readFileSync(envPath));
      if (parsed[key]) return parsed[key] as string | undefined;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return undefined;
}

// LLMwiki Browser — hybrid web + MCP App.
// Server defaults to port `8765` as defined in LLMWiki-MCP-Server/app.py.
export default defineConfig(({ mode }) => {
  const uiEnv = loadEnv(mode, here, "VITE_");

  return {
    plugins: [react()],
    server: {
      port: 5184, // one below discovery (5173), avoids collision with workspace defaults
      proxy: {
        "/api/mcp": {
          target: "http://localhost:8765",
          changeOrigin: true,
        },
      },
    },
    define: {
      // Pass the LLMWiki MCP server URL from .env at build time.
      "import.meta.env.VITE_LLMWIKI_MCP_URL": JSON.stringify(
        uiEnv.VITE_LLMWIKI_MCP_URL || nearestEnvValue("LLMWIKI_MCP_URL") || "http://localhost:8765/api/mcp/llmwiki",
      ),
    },
  };
});
