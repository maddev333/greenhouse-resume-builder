/**
 * Entry point. Two transports:
 *   - Streamable HTTP (default): stateless, one server per request. This is what the chat host +
 *     basic-host use.
 *   - stdio (`--stdio`): a single server over stdin/stdout.
 *
 * Run locally: `npm run serve --workspace @greenhouse-resume-builder/cap-engagements-mcp-engagements`
 */

import "./load-env.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import cors from "cors";
import { createServer } from "./server.js";
import { createLogger, logLevel } from "./log.js";
import { resolveBackend } from "./readmodel.js";
import {
  entityKinds,
  groundingDeclaration,
  indexName,
  isGroundingConfigured,
  loadIndexRegistry,
} from "./retrieval/index-schema.js";

const log = createLogger("startup");

const PORT = parseInt(
  process.env.ENGAGEMENTS_MCP_PORT ?? process.env.PORT ?? "3010",
  10,
);

/**
 * Report the configuration ONCE at startup, so a broken deployment is obvious before the first
 * question rather than as an opaque tool error afterwards. Nothing here is fatal: the server still
 * starts, and the per-request path reports the same faults — this just puts them where they are
 * seen. Set `ENGAGEMENTS_LOG_LEVEL=debug` for per-query detail.
 */
function logConfiguration(): void {
  log.info(
    `log level ${logLevel()} (set ENGAGEMENTS_LOG_LEVEL=debug for query-level detail)`,
  );

  let backend: string;
  try {
    backend = resolveBackend();
  } catch (err) {
    log.error(
      "RETRIEVAL_BACKEND is misconfigured -- every tool call will fail until this is fixed",
      err,
    );
    return;
  }
  log.info(`retrieval backend: ${backend}`);

  if (backend === "memory") {
    log.info(
      "serving the demo seed; no Azure AI Search calls will be made and no customer data is read",
    );
    return;
  }

  log.info(
    `search service: ${process.env.AZURE_SEARCH_SERVICE?.trim() || "(unset)"}, auth: ` +
      (process.env.AZURE_SEARCH_API_KEY
        ? "AZURE_SEARCH_API_KEY"
        : 'DefaultAzureCredential -- the identity needs the "Search Index Data Reader" role (run `az login` locally)'),
  );

  try {
    const registry = loadIndexRegistry();
    log.info(`index declarations: ${registry.length}`);
    for (const d of registry) {
      const kinds = entityKinds(d);
      log.info(
        `  "${d.id}" -> index "${indexName(d)}" | grounding: ${
          isGroundingConfigured(d) ? d.mapping.grounding!.content : "(none)"
        } | kinds: ${kinds.length ? kinds.join(", ") : "(none)"} | ${d.sourcePath}`,
      );
    }
    if (backend === "grounding" && !groundingDeclaration()) {
      log.error(
        "RETRIEVAL_BACKEND=grounding but no declaration carries a `mapping.grounding` block, so " +
          "search_grounding cannot run. Add one to the config above.",
      );
    }
  } catch (err) {
    log.error(
      "index schema registry failed to load -- every retrieval tool will fail until this is fixed",
      err,
    );
  }
}

async function startHttp(): Promise<void> {
  const app = createMcpExpressApp({ host: "0.0.0.0" });
  // The chat UI / MCP Apps host loads from a different origin.
  app.use(
    cors({
      exposedHeaders: ["mcp-session-id"],
      allowedHeaders: [
        "content-type",
        "mcp-session-id",
        "mcp-protocol-version",
        "last-event-id",
      ],
    }),
  );

  app.all("/mcp", async (req, res) => {
    // Fresh server per request (stateless).
    const server = createServer();
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    });

    res.on("close", () => {
      transport.close().catch(() => {});
      server.close().catch(() => {});
    });

    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (error) {
      console.error("MCP error:", error);
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: "2.0",
          error: { code: -32603, message: "Internal server error" },
          id: null,
        });
      }
    }
  });

  const httpServer = app.listen(PORT, () => {
    console.log(
      `Engagements MCP server listening on http://localhost:${PORT}/mcp`,
    );
  });

  httpServer.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code === "EADDRINUSE") {
      console.error(
        `Engagements MCP server: port ${PORT} is already in use — a previous MCP server may still be running. Stop that process or set ENGAGEMENTS_MCP_PORT to a free port, then retry.`,
      );
    } else {
      console.error(err);
    }
    process.exit(1);
  });

  const shutdown = () => httpServer.close(() => process.exit(0));
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

async function startStdio(): Promise<void> {
  await createServer().connect(new StdioServerTransport());
}

async function main(): Promise<void> {
  logConfiguration();
  if (process.argv.includes("--stdio")) {
    await startStdio();
  } else {
    await startHttp();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
