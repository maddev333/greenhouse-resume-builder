/**
 * MCP-Apps HOST wiring for the chat UI (M6).
 *
 * Adapted from the ext-apps `basic-host` reference, with ONE deliberate change that makes this a
 * "host over the M5 orchestrator" rather than a host that drives the model itself:
 *
 *   - basic-host: the host's own LLM calls a tool, and the tool's CallToolResult is delivered to
 *     the embedded app via AppBridge.sendToolResult(result).
 *   - here:       the M5 orchestrator (:3020 /ask) already decided the itinerary and returned a
 *     `tripMap` payload. The host connects to the engagements MCP server ONLY to read the app's
 *     UI resource (ui://trip-map/trip-map.html), then hands the orchestrator's tripMap to the
 *     sandboxed app as a synthetic tool result. The app is the SAME sandboxed ui://trip-map App a
 *     compliant host would render; the security trim was enforced server-side by the orchestrator.
 */
import {
  RESOURCE_MIME_TYPE,
  AppBridge,
  PostMessageTransport,
  buildAllowAttribute,
  type McpUiSandboxProxyReadyNotification,
  type McpUiResourceCsp,
  type McpUiResourcePermissions,
} from "@modelcontextprotocol/ext-apps/app-bridge";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { getTheme, onThemeChange } from "./theme";
import { HOST_STYLE_VARIABLES } from "./host-styles";

const IMPLEMENTATION = { name: "Engagements Chat Host", version: "1.0.0" };

export const log = {
  info: console.log.bind(console, "[HOST]"),
  warn: console.warn.bind(console, "[HOST]"),
  error: console.error.bind(console, "[HOST]"),
};

export interface UiResourceData {
  html: string;
  csp?: McpUiResourceCsp;
  permissions?: McpUiResourcePermissions;
}

/**
 * Connect an MCP client to the engagements capability, carrying the demo persona on every request
 * (the server enforces the security trim from this header). Used only to read the UI resource.
 */
export async function connectToServer(serverUrl: string, persona: string): Promise<Client> {
  log.info("Connecting to engagements MCP:", serverUrl, "persona:", persona);
  const client = new Client(IMPLEMENTATION);
  const transport = new StreamableHTTPClientTransport(new URL(serverUrl), {
    requestInit: { headers: { "x-demo-persona": persona } },
  });
  await client.connect(transport);
  return client;
}

/** Read the MCP App's HTML + CSP/permission metadata (content-level `_meta.ui`). */
export async function getUiResource(client: Client, uri: string): Promise<UiResourceData> {
  log.info("Reading UI resource:", uri);
  const resource = await client.readResource({ uri });
  if (!resource || resource.contents.length !== 1) {
    throw new Error(`Unexpected resource contents for ${uri}`);
  }
  const content = resource.contents[0] as Record<string, unknown> & { mimeType?: string };
  if (content.mimeType !== RESOURCE_MIME_TYPE) {
    throw new Error(`Unsupported MIME type: ${content.mimeType} (expected ${RESOURCE_MIME_TYPE})`);
  }
  const html = "blob" in content ? atob(content.blob as string) : (content.text as string);
  const contentMeta = (content._meta as any) || (content.meta as any);
  const uiMeta = contentMeta?.ui;
  return { html, csp: uiMeta?.csp, permissions: uiMeta?.permissions };
}

const PROXY_READY_NOTIFICATION: McpUiSandboxProxyReadyNotification["method"] =
  "ui/notifications/sandbox-proxy-ready";

/** Point the outer iframe at the sandbox proxy (distinct origin) and wait for it to signal ready. */
export function loadSandboxProxy(
  iframe: HTMLIFrameElement,
  sandboxProxyBaseUrl: string,
  csp?: McpUiResourceCsp,
  permissions?: McpUiResourcePermissions,
): Promise<boolean> {
  if (iframe.src) return Promise.resolve(false);

  iframe.setAttribute("sandbox", "allow-scripts allow-same-origin allow-forms");
  const allowAttribute = buildAllowAttribute(permissions);
  if (allowAttribute) iframe.setAttribute("allow", allowAttribute);

  const readyPromise = new Promise<boolean>((resolve) => {
    const listener = ({ source, data }: MessageEvent) => {
      if (source === iframe.contentWindow && data?.method === PROXY_READY_NOTIFICATION) {
        window.removeEventListener("message", listener);
        resolve(true);
      }
    };
    window.addEventListener("message", listener);
  });

  const sandboxUrl = new URL(sandboxProxyBaseUrl);
  if (csp) sandboxUrl.searchParams.set("csp", JSON.stringify(csp));
  iframe.src = sandboxUrl.href;
  return readyPromise;
}

/** Build the host-side AppBridge with theme/style host context and the handlers the app may call. */
export function newAppBridge(client: Client, iframe: HTMLIFrameElement): AppBridge {
  const serverCapabilities = client.getServerCapabilities();
  const appBridge = new AppBridge(
    client,
    IMPLEMENTATION,
    {
      openLinks: {},
      serverTools: serverCapabilities?.tools,
      serverResources: serverCapabilities?.resources,
      updateModelContext: { text: {} },
    },
    {
      hostContext: {
        theme: getTheme(),
        platform: "web",
        styles: { variables: HOST_STYLE_VARIABLES },
        containerDimensions: { maxHeight: 6000 },
        displayMode: "inline",
        availableDisplayModes: ["inline"],
      },
    },
  );

  const disposeTheme = onThemeChange((theme) => appBridge.sendHostContextChange({ theme }));

  const iframeResizeObserver = new ResizeObserver(([entry]) => {
    const width = Math.round(entry.contentRect.width);
    if (width > 0) {
      appBridge.sendHostContextChange({ containerDimensions: { width, maxHeight: 6000 } });
    }
  });
  iframeResizeObserver.observe(iframe);

  const prevOnclose = appBridge.onclose;
  appBridge.onclose = () => {
    iframeResizeObserver.disconnect();
    disposeTheme();
    prevOnclose?.();
  };

  appBridge.onmessage = async () => ({});
  appBridge.onopenlink = async (params) => {
    window.open(params.url, "_blank", "noopener,noreferrer");
    return {};
  };
  appBridge.onloggingmessage = (params) => log.info("App log:", params);
  appBridge.onupdatemodelcontext = async () => ({});
  appBridge.onrequestdisplaymode = async () => ({ mode: "inline" as const });
  appBridge.onsizechange = async ({ width, height }) => {
    if (width !== undefined) iframe.style.minWidth = `min(${width}px, 100%)`;
    if (height !== undefined) iframe.style.height = `${height}px`;
  };

  return appBridge;
}

function hookInitialized(appBridge: AppBridge): Promise<void> {
  const oninitialized = appBridge.oninitialized;
  return new Promise<void>((resolve) => {
    appBridge.oninitialized = (...args) => {
      resolve();
      appBridge.oninitialized = oninitialized;
      appBridge.oninitialized?.(...args);
    };
  });
}

export interface RenderTripMapOptions {
  client: Client;
  iframe: HTMLIFrameElement;
  sandboxProxyBaseUrl: string;
  resource: UiResourceData;
  tripMap: unknown;
  answer?: string;
  toolInput?: Record<string, unknown>;
}

/**
 * Full host handshake to render the orchestrator's tripMap inside the sandboxed ui://trip-map App:
 * load sandbox proxy → connect AppBridge → deliver app HTML → deliver the tripMap as a tool result.
 * Returns the AppBridge so the caller can close() it on unmount.
 */
export async function renderTripMapApp(opts: RenderTripMapOptions): Promise<AppBridge> {
  const { client, iframe, sandboxProxyBaseUrl, resource, tripMap, answer, toolInput } = opts;

  await loadSandboxProxy(iframe, sandboxProxyBaseUrl, resource.csp, resource.permissions);

  const appBridge = newAppBridge(client, iframe);
  const initializedPromise = hookInitialized(appBridge);

  // Pass iframe.contentWindow as BOTH target and source so this bridge only accepts messages from
  // its specific sandbox iframe.
  await appBridge.connect(new PostMessageTransport(iframe.contentWindow!, iframe.contentWindow!));

  log.info("Sending UI resource HTML to sandbox", resource.csp ? `(CSP: ${JSON.stringify(resource.csp)})` : "");
  await appBridge.sendSandboxResourceReady({
    html: resource.html,
    csp: resource.csp,
    permissions: resource.permissions,
  });

  await initializedPromise;
  log.info("MCP App initialized — delivering tripMap");

  // Context for the app; the map only needs the structuredContent.tripMap below.
  appBridge.sendToolInput({ arguments: toolInput ?? {} });

  const result: CallToolResult = {
    content: [{ type: "text", text: answer || "Trip itinerary" }],
    structuredContent: { tripMap },
  };
  appBridge.sendToolResult(result);

  return appBridge;
}
