#!/usr/bin/env npx tsx
/**
 * Two HTTP servers for the chat host (mirrors the ext-apps basic-host serving model):
 *   - Host server    (HOST_PORT, default 8080): serves dist/index.html + /api/config + /health.
 *   - Sandbox server (SANDBOX_PORT, default 8081): serves dist/sandbox.html with a per-request CSP
 *     HTTP header derived from ?csp=. Running on a SEPARATE port (origin) is required for the
 *     sandbox isolation self-test in src/sandbox.ts.
 *
 * The browser talks directly (CORS-enabled) to the M5 orchestrator (:3020) and the engagements
 * MCP server (:3010); this server does not proxy them. /api/config just advertises their URLs.
 */
import express from "express";
import cors from "cors";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import type { McpUiResourceCsp } from "@modelcontextprotocol/ext-apps";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const HOST_PORT = parseInt(process.env.HOST_PORT || "8080", 10);
const SANDBOX_PORT = parseInt(process.env.SANDBOX_PORT || "8081", 10);
const ORCHESTRATOR_URL = process.env.ORCHESTRATOR_URL || "http://localhost:3020";
const ENGAGEMENTS_MCP_URL = process.env.ENGAGEMENTS_MCP_URL || "http://localhost:3010/mcp";
const DIRECTORY = join(__dirname, "dist");

// ============ Host server ============
const hostApp = express();
hostApp.use(cors());

hostApp.use((req, res, next) => {
  if (req.path === "/sandbox.html") {
    res.status(404).send("Sandbox is served on a different port");
    return;
  }
  next();
});

// Advertise the demo topology so the single-file bundle isn't hard-coded to specific ports.
hostApp.get("/api/config", (req, res) => {
  res.json({
    orchestratorUrl: ORCHESTRATOR_URL,
    engagementsMcpUrl: ENGAGEMENTS_MCP_URL,
    sandboxProxyBaseUrl: `${req.protocol}://${req.hostname}:${SANDBOX_PORT}/sandbox.html`,
  });
});

hostApp.get("/health", (_req, res) => {
  res.json({ ok: true, service: "engagements-chat-host" });
});

hostApp.use(express.static(DIRECTORY));

hostApp.get("/", (_req, res) => {
  res.redirect("/index.html");
});

// ============ Sandbox server (CSP via HTTP header) ============
const sandboxApp = express();
sandboxApp.use(cors());

// Reject entries that could break out of a CSP directive (`;`, newlines, quotes, spaces).
function sanitizeCspDomains(domains?: string[]): string[] {
  if (!domains) return [];
  return domains.filter((d) => typeof d === "string" && !/[;\r\n'" ]/.test(d));
}

function buildCspHeader(csp?: McpUiResourceCsp): string {
  const resourceDomains = sanitizeCspDomains(csp?.resourceDomains).join(" ");
  const connectDomains = sanitizeCspDomains(csp?.connectDomains).join(" ");
  const frameDomains = sanitizeCspDomains(csp?.frameDomains).join(" ") || null;
  const baseUriDomains = sanitizeCspDomains(csp?.baseUriDomains).join(" ") || null;

  const directives = [
    "default-src 'self' 'unsafe-inline'",
    `script-src 'self' 'unsafe-inline' 'unsafe-eval' blob: data: ${resourceDomains}`.trim(),
    `style-src 'self' 'unsafe-inline' blob: data: ${resourceDomains}`.trim(),
    `img-src 'self' data: blob: ${resourceDomains}`.trim(),
    `font-src 'self' data: blob: ${resourceDomains}`.trim(),
    `media-src 'self' data: blob: ${resourceDomains}`.trim(),
    `connect-src 'self' ${connectDomains}`.trim(),
    `worker-src 'self' blob: ${resourceDomains}`.trim(),
    frameDomains ? `frame-src ${frameDomains}` : "frame-src 'none'",
    "object-src 'none'",
    baseUriDomains ? `base-uri ${baseUriDomains}` : "base-uri 'none'",
  ];

  return directives.join("; ");
}

sandboxApp.get(["/", "/sandbox.html"], (req, res) => {
  let cspConfig: McpUiResourceCsp | undefined;
  if (typeof req.query.csp === "string") {
    try {
      cspConfig = JSON.parse(req.query.csp);
    } catch (e) {
      console.warn("[Sandbox] Invalid CSP query param:", e);
    }
  }

  res.setHeader("Content-Security-Policy", buildCspHeader(cspConfig));
  res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
  res.setHeader("Pragma", "no-cache");
  res.setHeader("Expires", "0");
  res.sendFile(join(DIRECTORY, "sandbox.html"));
});

sandboxApp.use((_req, res) => {
  res.status(404).send("Only sandbox.html is served on this port");
});

// ============ Start ============
function onListenError(port: number, label: string) {
  return (err: NodeJS.ErrnoException) => {
    if (err.code === "EADDRINUSE") {
      console.error(`${label}: port ${port} is already in use — a previous chat host may still be running. Stop that process or free the port, then retry.`);
    } else {
      console.error(err);
    }
    process.exit(1);
  };
}

hostApp.listen(HOST_PORT, () => {
  console.log(`Chat host:      http://localhost:${HOST_PORT}`);
  console.log(`  -> orchestrator: ${ORCHESTRATOR_URL}  (POST /ask)`);
  console.log(`  -> engagements MCP: ${ENGAGEMENTS_MCP_URL}  (ui://trip-map resource)`);
}).on("error", onListenError(HOST_PORT, "Chat host"));

sandboxApp.listen(SANDBOX_PORT, () => {
  console.log(`Sandbox proxy:  http://localhost:${SANDBOX_PORT}/sandbox.html`);
  console.log("\nOpen the chat host URL above. Press Ctrl+C to stop.\n");
}).on("error", onListenError(SANDBOX_PORT, "Sandbox proxy"));
