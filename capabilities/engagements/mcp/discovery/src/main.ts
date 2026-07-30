/**
 * Entry point. Mirrors the engagements capability: Streamable HTTP (default, stateless — one server
 * per request) or stdio (`--stdio`).
 *
 * Run locally: `npm run serve --workspace @greenhouse-resume-builder/cap-engagements-mcp-discovery`
 */

import "./load-env.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import cors from "cors";
import { createServer } from "./server.js";
import { isMapsConfigured } from "./maps.js";

const PORT = parseInt(
  process.env.DISCOVERY_MCP_PORT ?? process.env.PORT ?? "3011",
  10,
);

async function startHttp(): Promise<void> {
  const app = createMcpExpressApp({ host: "0.0.0.0" });
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
        res
          .status(500)
          .json({
            jsonrpc: "2.0",
            error: { code: -32603, message: "Internal server error" },
            id: null,
          });
      }
    }
  });

  const httpServer = app.listen(PORT, () => {
    console.log(
      `Area Discovery MCP server listening on http://localhost:${PORT}/mcp`,
    );
    console.log(
      isMapsConfigured()
        ? "  -> provider: Azure Maps Search (POI)"
        : "  -> provider: UNCONFIGURED — set AZURE_MAPS_KEY in the repo-root .env or search_businesses will return an error.",
    );
  });

  httpServer.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code === "EADDRINUSE") {
      console.error(
        `Area Discovery MCP server: port ${PORT} is already in use. Stop that process or set DISCOVERY_MCP_PORT to a free port, then retry.`,
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
