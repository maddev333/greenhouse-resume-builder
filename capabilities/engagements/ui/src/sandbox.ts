/**
 * Sandbox proxy — the OUTER iframe of the double-iframe isolation model.
 *
 * Reproduced from the ext-apps `basic-host` reference (examples/basic-host/src/sandbox.ts).
 * It runs on a DISTINCT origin from the host page (SANDBOX_PORT), creates an inner iframe for
 * the untrusted MCP App HTML, and relays postMessage traffic between Host ↔ Sandbox ↔ View.
 */
import type {
  McpUiSandboxProxyReadyNotification,
  McpUiSandboxResourceReadyNotification,
} from "@modelcontextprotocol/ext-apps/app-bridge";
import { buildAllowAttribute } from "@modelcontextprotocol/ext-apps/app-bridge";

const ALLOWED_REFERRER_PATTERN = /^http:\/\/(localhost|127\.0\.0\.1)(:|\/|$)/;

if (window.self === window.top) {
  throw new Error("This file is only to be used in an iframe sandbox.");
}

if (!document.referrer) {
  throw new Error("No referrer, cannot validate embedding site.");
}

if (!document.referrer.match(ALLOWED_REFERRER_PATTERN)) {
  throw new Error(
    `Embedding domain not allowed in referrer ${document.referrer}. (Consider updating the validation logic to allow your domain.)`,
  );
}

// The origin we expect all parent messages to come from.
const EXPECTED_HOST_ORIGIN = new URL(document.referrer).origin;
const OWN_ORIGIN = new URL(window.location.href).origin;

// Security self-test: verify iframe isolation is working. This MUST throw a SecurityError —
// if window.top is reachable, the sandbox is broken (host and sandbox share an origin).
try {
  window.top!.alert("If you see this, the sandbox is not setup securely.");
  throw "FAIL";
} catch (e) {
  if (e === "FAIL") {
    throw new Error("The sandbox is not setup securely.");
  }
  // Expected: SecurityError confirms proper sandboxing.
}

// Inner iframe for the untrusted MCP App HTML content.
const inner = document.createElement("iframe");
inner.style.cssText = "width:100%; height:100%; border:none;";
inner.setAttribute("sandbox", "allow-scripts allow-same-origin allow-forms");
document.body.style.cssText = "margin:0; padding:0; height:100vh;";
document.body.appendChild(inner);

const RESOURCE_READY_NOTIFICATION: McpUiSandboxResourceReadyNotification["method"] =
  "ui/notifications/sandbox-resource-ready";
const PROXY_READY_NOTIFICATION: McpUiSandboxProxyReadyNotification["method"] =
  "ui/notifications/sandbox-proxy-ready";

window.addEventListener("message", async (event) => {
  if (event.source === window.parent) {
    if (event.origin !== EXPECTED_HOST_ORIGIN) {
      console.error(
        "[Sandbox] Rejecting message from unexpected origin:",
        event.origin,
        "expected:",
        EXPECTED_HOST_ORIGIN,
      );
      return;
    }

    if (event.data && event.data.method === RESOURCE_READY_NOTIFICATION) {
      const { html, sandbox, permissions } = event.data.params;
      if (typeof sandbox === "string") {
        inner.setAttribute("sandbox", sandbox);
      }
      const allowAttribute = buildAllowAttribute(permissions);
      if (allowAttribute) {
        inner.setAttribute("allow", allowAttribute);
      }
      if (typeof html === "string") {
        // Use document.write instead of srcdoc (Azure Maps / WebGL apps misbehave with srcdoc).
        const doc = inner.contentDocument || inner.contentWindow?.document;
        if (doc) {
          doc.open();
          doc.write(html);
          doc.close();
        } else {
          console.warn("[Sandbox] document.write not available, falling back to srcdoc");
          inner.srcdoc = html;
        }
      }
    } else if (inner && inner.contentWindow) {
      inner.contentWindow.postMessage(event.data, "*");
    }
  } else if (event.source === inner.contentWindow) {
    if (event.origin !== OWN_ORIGIN) {
      console.error(
        "[Sandbox] Rejecting message from inner iframe with unexpected origin:",
        event.origin,
        "expected:",
        OWN_ORIGIN,
      );
      return;
    }
    window.parent.postMessage(event.data, EXPECTED_HOST_ORIGIN);
  }
});

// Tell the host the sandbox is ready to receive view HTML.
window.parent.postMessage(
  {
    jsonrpc: "2.0",
    method: PROXY_READY_NOTIFICATION,
    params: {},
  },
  EXPECTED_HOST_ORIGIN,
);
