import { StrictMode, useState } from "react"
import { createRoot } from "react-dom/client"

/** LLMwiki Browser — MCP UI App (hybrid web + MCP App) for the llmwiki capability.
 * Runs embedded in an MCP host or standalone (calling the LLMwiki MCP server over HTTP).
 */

import { createMcpBridge } from "./mcp-bridge"

const SERVER_URL =
  (import.meta as any).env?.VITE_LLMWIKI_MCP_URL || "http://localhost:8765/api/mcp/llmwiki"

function App() {
  const bridge = createMcpBridge(SERVER_URL)
  const [mode, setMode] = useState("initial")

  return (
    <main style={{ fontFamily: "system-ui", maxWidth: 760, margin: "2rem auto", padding: "0 1rem" }}>
      <h1>LLMwiki Browser</h1>
      <p style={{ color: "#555" }}>{bridge.embedded ? "embedded in MCP host" : "standalone HTTP mode"}</p>

      <pre style={{ background: "#f68fa", padding: 12, marginTop: 12, overflowX: "auto", fontSize: 13 }}>
        {JSON.stringify({ status: mode, serverUrl: SERVER_URL }, null, 2)}
      </pre>

    </main>
  )
}

createRoot(document.getElementById("root")).render(<StrictMode><App /></StrictMode>)
