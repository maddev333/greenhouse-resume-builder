"""
FastMCP browser-view MCP App (SEP-1865) demo.

Pairs a Playwright-driven Chromium session with an MCP Apps resource at
``ui://browser/view.html`` so that MCP-Apps-aware hosts mount an interactive
"mini browser" inside a sandboxed iframe. Plain MCP clients still see a text
fallback (URL + title + a snippet of the accessibility snapshot) for the
graceful-degradation contract the spec requires.

Tools
-----
- ``browser_navigate(url)``           — open a URL.
- ``browser_view()``                  — current page snapshot + interactive elements.
- ``browser_click_at(x, y)``          — click at viewport-pixel coordinates.
- ``browser_click_ref(ref)``          — click hotspot #N from the last view.
- ``browser_type_at(text, x, y, ...)``— focus a field at coords and type.
- ``browser_press(key)``               — send a single keypress (Enter, Tab, etc.).
- ``browser_back()`` / ``browser_forward()`` / ``browser_reload()`` — history nav.
- ``browser_close()``                 — tear down the Playwright session.

Every tool that mutates page state returns the same ``BrowserView`` structured
payload and stamps ``_meta.ui.resourceUri = ui://browser/view.html``, so the
host iframe re-renders on each turn.

Iframe-initiated tool calls (typed URLs, click overlays) flow back through the
existing MCP connection via ``bridge.oncalltool`` in
``src/taskpane/components/chat/mcp-ui-app.tsx`` — i.e. the iframe drives the
same browser session that produced it, with no second auth round-trip.

Connection modes
----------------
**Bundled Chromium (default)** — launches a fresh Playwright-managed headless
browser. Requires ``playwright install chromium`` to download the browser once.

**Connect to existing browser (CDP)** — attaches to a Chrome/Edge instance
already running on your machine via Chrome DevTools Protocol. No extra browser
download needed, and automation runs inside a context the user controls.
Set ``BROWSER_CDP_URL`` to the remote-debugging HTTP endpoint.

**Attach to existing tab (CDP)** — same as above, but re-uses a tab already
open in the connected browser instead of opening a new isolated context.
Set ``BROWSER_CDP_ATTACH=1`` together with ``BROWSER_CDP_URL``.

Run
---
    pip install -r requirements.txt
    # Only needed if you plan to use the bundled Chromium fallback:
    playwright install chromium

    # Option A — bundled Chromium (default)
    fastmcp run browser_server.py --transport http --port 8001

    # Option B — connect to an existing browser via CDP
    # 1. Start Chrome with a remote-debugging port:
    #    /Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome \
    #        --remote-debugging-port=9222 --user-data-dir=/tmp/chrome-dev-profile
    # 2. Point the server at it:
    #    BROWSER_CDP_URL=http://localhost:9222 fastmcp run browser_server.py --transport http --port 8001

    # Option C — attach to an existing tab in the connected browser
    #    BROWSER_CDP_URL=http://localhost:9222 BROWSER_CDP_ATTACH=1 python browser_server.py
"""

from __future__ import annotations

import asyncio
import base64
import os
import uuid
from contextlib import asynccontextmanager
from typing import Any

from dotenv import load_dotenv
from fastmcp import FastMCP
from fastmcp.tools.tool import ToolResult
from starlette.middleware import Middleware
from starlette.middleware.cors import CORSMiddleware

load_dotenv()

UI_RESOURCE_URI = "ui://browser/view.html"
DEFAULT_VIEWPORT = {"width": 1024, "height": 720}
SCREENSHOT_QUALITY = 70  # JPEG quality, balances size vs. legibility

# Budgets for the *text channel* the LLM consumes. The structured payload
# (screenshot + raw element list) is unaffected — these only bound the
# human-readable summary so a content-heavy page (e.g. Google News) doesn't
# blow out the model's context window.
VIEWPORT_TEXT_MAX_CHARS = 8000
AX_SUMMARY_MAX_CHARS = 4000
ELEMENT_LABEL_MAX_CHARS = 240
ELEMENT_FALLBACK_MAX_REFS = 60


# ---------------------------------------------------------------------------
# Playwright session — single lazy-init browser context shared across calls.
# ---------------------------------------------------------------------------


class BrowserSession:
    """Single Chromium page driven by Playwright.

    Lazy-initialised on first tool call so that ``fastmcp run`` doesn't pay
    the browser-launch cost if nothing ever calls a browser tool. Guarded
    by an asyncio lock so concurrent tool calls don't fight over the page.
    """

    def __init__(self) -> None:
        self._lock = asyncio.Lock()
        self._playwright = None
        self._browser = None
        self._context = None
        self._page = None
        # Stable id used as ``_meta.viewUUID`` so iframe re-mounts can
        # correlate themselves to the same browser session server-side.
        self.view_uuid = str(uuid.uuid4())
        # Last interactive-elements list, keyed by ref index, so
        # ``browser_click_ref`` can look up coordinates from a prior view.
        self._last_refs: dict[int, dict[str, Any]] = {}

        # --- CDP / connect-to-existing-browser config -----------------------
        # BROWSER_CDP_URL=http://localhost:9222  (or a ws://… endpoint)
        # Connects to an existing Chrome/Edge via Chrome DevTools Protocol
        # instead of launching Playwright's bundled Chromium.
        self._cdp_url = os.environ.get("BROWSER_CDP_URL", "").strip() or None
        # BROWSER_CDP_ATTACH=1  →  Re-use an existing page/tab instead of
        # creating a fresh isolated context (useful for automating a tab
        # the user already has open).
        self._cdp_attach = os.environ.get("BROWSER_CDP_ATTACH", "").lower() in (
            "1",
            "true",
            "yes",
        )
        # Track how the browser was acquired so we know whether it is safe
        # to call browser.close() (launched) or whether we should just
        # disconnect (CDP).
        self._launched = True
        self._owns_context = True

    async def _ensure(self) -> None:
        if self._page is not None:
            return
        try:
            from playwright.async_api import async_playwright  # type: ignore
        except ImportError as e:  # pragma: no cover - friendlier error
            raise RuntimeError(
                "Playwright is not installed. Run `pip install playwright` "
                "to enable the browser MCP App. If you also plan to use the "
                "bundled Chromium, run `playwright install chromium`."
            ) from e

        self._playwright = await async_playwright().start()

        if self._cdp_url:
            self._browser = await self._playwright.chromium.connect_over_cdp(
                self._cdp_url
            )
            self._launched = False
            if self._cdp_attach:
                # Re-use the default browser context and an existing page.
                ctx = (
                    self._browser.contexts[0]
                    if self._browser.contexts
                    else await self._browser.new_context()
                )
                self._context = ctx
                if ctx.pages:
                    self._page = ctx.pages[0]
                    self._owns_context = False
                    return
                self._page = await ctx.new_page()
                return
            # Normal CDP path: fresh isolated context inside the user's browser.
            self._context = await self._browser.new_context(
                viewport=DEFAULT_VIEWPORT,
                ignore_https_errors=True,
            )
            self._page = await self._context.new_page()
            await self._page.goto("about:blank")
            return

        # Fallback: launch Playwright's bundled Chromium.
        headless = os.environ.get("BROWSER_HEADLESS", "1").lower() not in (
            "0",
            "false",
            "no",
        )
        self._browser = await self._playwright.chromium.launch(headless=headless)
        self._context = await self._browser.new_context(
            viewport=DEFAULT_VIEWPORT,
            ignore_https_errors=True,
        )
        self._page = await self._context.new_page()
        await self._page.goto("about:blank")

    async def navigate(self, url: str) -> None:
        async with self._lock:
            await self._ensure()
            # Tolerate users dropping `example.com` without a scheme.
            if "://" not in url:
                url = f"https://{url}"
            await self._page.goto(url, wait_until="domcontentloaded", timeout=15000)
            await self._settle_locked()

    async def click_at(self, x: float, y: float) -> None:
        async with self._lock:
            await self._ensure()
            await self._click_locked(x, y)

    async def click_ref(self, ref: int) -> None:
        if ref not in self._last_refs:
            raise ValueError(
                f"ref {ref} not in last snapshot — call browser_view first"
            )
        meta = self._last_refs[ref]
        # Click the centre of the recorded bbox.
        cx = meta["x"] + meta["w"] / 2
        cy = meta["y"] + meta["h"] / 2
        async with self._lock:
            await self._ensure()
            await self._click_locked(cx, cy)

    async def type_at(
        self, text: str, x: float, y: float, submit: bool = False
    ) -> None:
        async with self._lock:
            await self._ensure()
            await self._page.mouse.click(x, y)
            await self._page.keyboard.type(text, delay=10)
            if submit:
                # Pressing Enter often triggers a form submit / navigation.
                # Set up the navigation expectation *before* the keypress so
                # we don't miss the race.
                await self._press_locked("Enter")
            else:
                await self._settle_locked()

    async def press(self, key: str) -> None:
        async with self._lock:
            await self._ensure()
            await self._press_locked(key)

    async def go_back(self) -> None:
        async with self._lock:
            await self._ensure()
            await self._page.go_back(timeout=10000)
            await self._settle_locked()

    async def go_forward(self) -> None:
        async with self._lock:
            await self._ensure()
            await self._page.go_forward(timeout=10000)
            await self._settle_locked()

    async def reload(self) -> None:
        async with self._lock:
            await self._ensure()
            await self._page.reload(timeout=15000)
            await self._settle_locked()

    # --- Lock-internal helpers --------------------------------------------
    # All ``_*_locked`` helpers assume ``self._lock`` is already held and
    # ``self._page`` is non-None. They wrap navigation/settle patterns so
    # callers don't have to deal with "click may or may not navigate"
    # races directly.

    async def _click_locked(self, x: float, y: float) -> None:
        """Click ``(x, y)`` and tolerate the click triggering a navigation.

        Sets up the navigation expectation *before* the click so we don't
        race the renderer. If no navigation occurs (most buttons), the
        ``TimeoutError`` is swallowed and we just settle.
        """
        try:
            async with self._page.expect_navigation(
                wait_until="domcontentloaded", timeout=3000
            ):
                await self._page.mouse.click(x, y)
        except Exception:
            # No navigation happened — that's the common case. The click
            # itself already succeeded; fall through to settle.
            pass
        await self._settle_locked()

    async def _press_locked(self, key: str) -> None:
        """Press ``key`` and tolerate the press triggering a navigation."""
        try:
            async with self._page.expect_navigation(
                wait_until="domcontentloaded", timeout=3000
            ):
                await self._page.keyboard.press(key)
        except Exception:
            pass
        await self._settle_locked()

    async def _settle_locked(self) -> None:
        """Wait briefly for the page to stabilise after a potentially-
        navigating action. Swallows timeouts because not every action
        triggers a navigation, and many pages never reach ``networkidle``.
        """
        for state in ("domcontentloaded", "load"):
            try:
                await self._page.wait_for_load_state(state, timeout=5000)
            except Exception:
                pass

    async def view(self) -> dict[str, Any]:
        async with self._lock:
            await self._ensure()
            # If a navigation is mid-flight (e.g. from a click that just
            # happened on a non-navigating-but-async element), give it a
            # moment to settle before we start the snapshot.
            await self._settle_locked()

            # Retry the whole snapshot if a deferred navigation tears down
            # the JS context mid-``page.evaluate``. Cap at 3 attempts so we
            # don't loop on a genuinely broken page.
            last_err: Exception | None = None
            for _attempt in range(3):
                try:
                    return await self._view_once_locked()
                except Exception as e:  # noqa: BLE001 - inspect message
                    msg = str(e)
                    if (
                        "Execution context was destroyed" in msg
                        or "context was destroyed" in msg.lower()
                        or "Target page, context or browser has been closed"
                        in msg
                    ):
                        last_err = e
                        await self._settle_locked()
                        continue
                    raise
            assert last_err is not None
            raise last_err

    async def _view_once_locked(self) -> dict[str, Any]:
        page = self._page

        # Screenshot — JPEG keeps the round-trip cheap for natural pages.
        shot_bytes = await page.screenshot(type="jpeg", quality=SCREENSHOT_QUALITY)
        b64 = base64.b64encode(shot_bytes).decode("ascii")

        url = page.url
        title = await page.title()
        viewport = page.viewport_size or DEFAULT_VIEWPORT

        # Collect interactive elements with viewport-relative bboxes via
        # an in-page evaluate; cheap, deterministic, no AX-tree walking.
        elements = await page.evaluate(
            """(LABEL_MAX) => {
                    const out = [];
                    const sel = 'a[href], button, input:not([type=\"hidden\"]), textarea, select, [role=\"button\"], [role=\"link\"], [role=\"textbox\"], [contenteditable=\"true\"]';
                    const nodes = document.querySelectorAll(sel);
                    for (const el of nodes) {
                        const r = el.getBoundingClientRect();
                        if (r.width < 4 || r.height < 4) continue;
                        if (r.bottom < 0 || r.top > window.innerHeight) continue;
                        if (r.right < 0 || r.left > window.innerWidth) continue;
                        const tag = el.tagName.toLowerCase();
                        const role = el.getAttribute('role') || (tag === 'a' ? 'link' : tag);
                        const label = (
                            el.getAttribute('aria-label') ||
                            (el.innerText || '').trim() ||
                            el.getAttribute('placeholder') ||
                            el.getAttribute('title') ||
                            el.getAttribute('alt') ||
                            ''
                        ).replace(/\\s+/g, ' ').trim().slice(0, LABEL_MAX);
                        out.push({
                            role,
                            tag,
                            label,
                            href: el.getAttribute('href') || null,
                            x: Math.round(r.left),
                            y: Math.round(r.top),
                            w: Math.round(r.width),
                            h: Math.round(r.height),
                        });
                    }
                    return out;
                }""",
            ELEMENT_LABEL_MAX_CHARS,
        )

        # Re-key by ref index and cache for browser_click_ref.
        elements_with_refs = []
        self._last_refs = {}
        for i, el in enumerate(elements):
            ref = i
            self._last_refs[ref] = el
            elements_with_refs.append({"ref": ref, **el})

        # Visible page text — the model can't OCR the JPEG, and the
        # interactive element list only captures clickable nodes, so
        # content-heavy pages (news, articles) need their own text dump.
        viewport_text = await self._extract_visible_text_locked()

        # Truncate the AX snapshot text so it stays readable in plain-text
        # MCP clients without flooding the model context.
        try:
            ax = await page.accessibility.snapshot()
            ax_text = _summarize_ax(ax)[:AX_SUMMARY_MAX_CHARS]
        except Exception:  # pragma: no cover - accessibility flakes
            ax_text = ""

        return {
            "url": url,
            "title": title,
            "viewport_width": viewport["width"],
            "viewport_height": viewport["height"],
            "screenshot_mime": "image/jpeg",
            "screenshot_base64": b64,
            "elements": elements_with_refs,
            "viewport_text": viewport_text,
            "accessibility_summary": ax_text,
        }

    async def _extract_visible_text_locked(self) -> str:
        """Dump the visible-in-viewport text content as plain lines.

        Walks block-level content nodes (headings, paragraphs, list items,
        article/figcaption/blockquote, plus anchor and button text not
        already captured) and emits each unique trimmed string on its own
        line. Skips zero-size and off-screen nodes. Server-side we then
        clip the result to ``VIEWPORT_TEXT_MAX_CHARS`` so the text channel
        stays within the model's context budget.
        """
        page = self._page
        if page is None:
            return ""
        try:
            text = await page.evaluate(
                """() => {
                    const vH = window.innerHeight;
                    const vW = window.innerWidth;
                    const inView = (el) => {
                        const r = el.getBoundingClientRect();
                        if (r.width < 2 || r.height < 2) return false;
                        if (r.bottom < 0 || r.top > vH) return false;
                        if (r.right < 0 || r.left > vW) return false;
                        return true;
                    };
                    const clean = (s) => (s || '').replace(/\\s+/g, ' ').trim();
                    const lines = [];
                    const seen = new Set();
                    const push = (s) => {
                        if (!s || s.length < 2) return;
                        if (seen.has(s)) return;
                        seen.add(s);
                        lines.push(s);
                    };

                    const blockSel = [
                        'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
                        'p', 'li', 'blockquote', 'figcaption',
                        'dt', 'dd', 'summary', 'caption', 'label', 'time',
                        '[role=\"heading\"]', '[role=\"article\"]',
                        '[role=\"listitem\"]', '[role=\"status\"]',
                        '[role=\"alert\"]'
                    ].join(', ');
                    for (const el of document.querySelectorAll(blockSel)) {
                        if (!inView(el)) continue;
                        const tag = el.tagName.toLowerCase();
                        const role = el.getAttribute('role') || '';
                        const isHeading = tag.match(/^h[1-6]$/) || role === 'heading';
                        const prefix = isHeading ? '# ' : '';
                        push(prefix + clean(el.innerText || el.textContent));
                    }

                    for (const a of document.querySelectorAll('a[href], button, [role=\"button\"], [role=\"link\"]')) {
                        if (!inView(a)) continue;
                        const txt = clean(a.innerText || a.textContent || a.getAttribute('aria-label'));
                        if (!txt || txt.length < 3) continue;
                        push('· ' + txt);
                    }

                    return lines.join('\\n');
                }"""
            )
            return _clip_text((text or "").strip(), VIEWPORT_TEXT_MAX_CHARS)
        except Exception:
            return ""

    async def close(self) -> None:
        async with self._lock:
            if self._context is not None and self._owns_context:
                await self._context.close()
                self._context = None
            # Only call browser.close() when we launched the process ourselves.
            # For CDP connections, browser.close() would shut down the user's
            # existing browser; we merely disconnect via playwright.stop().
            if self._browser is not None and self._launched:
                await self._browser.close()
                self._browser = None
            if self._playwright is not None:
                await self._playwright.stop()
                self._playwright = None
            self._page = None
            self._last_refs = {}


def _summarize_ax(node: Any, depth: int = 0) -> str:
    if not node or depth > 5:
        return ""
    role = node.get("role") or ""
    name = (node.get("name") or "").strip()
    line = ""
    # Roles whose presence (with or without a name) is still informative for
    # plain-text consumers. Content roles like "heading", "article",
    # "paragraph", and "listitem" carry the actual page narrative — we used
    # to silently drop them.
    structural_roles = {
        "button",
        "link",
        "textbox",
        "checkbox",
        "radio",
        "switch",
        "tab",
        "menuitem",
        "combobox",
    }
    content_roles = {
        "heading",
        "article",
        "paragraph",
        "listitem",
        "region",
        "main",
        "navigation",
        "banner",
        "contentinfo",
        "dialog",
        "alert",
        "status",
    }
    if role and (
        (role in structural_roles)
        or (role in content_roles and name)
        or name
    ):
        line = f"{'  ' * depth}- {role}: {name[:120]}\n"
    children = node.get("children") or []
    parts = [line] if line else []
    for child in children[:40]:
        parts.append(_summarize_ax(child, depth + 1))
    return "".join(parts)


def _clip_text(s: str, limit: int) -> str:
    """Clip ``s`` to ``limit`` chars with a head + tail split and an
    elision marker, so the start (usually most relevant) and end are
    preserved when the page is large.
    """
    if s is None:
        return ""
    if len(s) <= limit:
        return s
    half = max(limit // 2, 1)
    head = s[:half]
    tail = s[-half:]
    elided = len(s) - len(head) - len(tail)
    return f"{head}\n\n…[{elided} chars elided]…\n\n{tail}"


# ---------------------------------------------------------------------------
# UI resource (SEP-1865)
# ---------------------------------------------------------------------------
# Hand-rolled MCP Apps view-side bridge over postMessage, matching the shape
# used by the `weather` demo in server.py. Direction (per
# `@modelcontextprotocol/ext-apps` v1.7.2 src/app.ts and src/app-bridge.ts):
#   1. View SENDS  `ui/initialize` request to host, awaits result.
#   2. View SENDS  `ui/notifications/initialized` notification.
#   3. View RECVS  `ui/notifications/{tool-input, tool-result,
#                   host-context-changed, tool-cancelled}`.
#   4. View SENDS  `tools/call` requests to drive its own browser session
#                   back through the same MCP connection.
#   5. View REPLIES to inbound requests (ping, etc.) with {} so the host
#                   doesn't time out.

BROWSER_UI_HTML = r"""<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Browser</title>
  <style>
    :root { color-scheme: light dark; }
    html, body { margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; height: 100%; }
    body { color: var(--mcp-ui-foreground, #111); background: var(--mcp-ui-background, transparent); display: flex; flex-direction: column; height: 100%; }
    .bar { display: flex; gap: 6px; padding: 6px 8px; align-items: center; border-bottom: 1px solid rgba(127,127,127,0.2); flex-wrap: wrap; }
    .bar button { padding: 4px 8px; border-radius: 4px; border: 1px solid rgba(127,127,127,0.4); background: rgba(127,127,127,0.08); color: inherit; cursor: pointer; font-size: 12px; }
    .bar button:disabled { opacity: 0.5; cursor: default; }
    .bar input[type=text] { flex: 1; min-width: 180px; padding: 4px 8px; border-radius: 4px; border: 1px solid rgba(127,127,127,0.4); background: var(--mcp-ui-surface, rgba(127,127,127,0.06)); color: inherit; font-size: 12px; }
    .status { font-size: 11px; opacity: 0.7; padding: 2px 8px; }
    .viewport { position: relative; flex: 1; overflow: auto; background: rgba(127,127,127,0.04); }
    .stage { position: relative; display: inline-block; }
    .stage img { display: block; max-width: 100%; height: auto; cursor: crosshair; }
    .hotspot { position: absolute; border: 1px solid transparent; box-sizing: border-box; cursor: pointer; }
    .hotspot:hover { border-color: rgba(99, 102, 241, 0.8); background: rgba(99, 102, 241, 0.12); }
    .hotspot:hover::after {
      content: attr(data-label);
      position: absolute; top: -22px; left: 0;
      background: rgba(20,20,20,0.85); color: #fff;
      font-size: 11px; padding: 2px 6px; border-radius: 3px;
      white-space: nowrap; pointer-events: none; z-index: 10;
    }
    .empty { padding: 16px; font-size: 13px; opacity: 0.7; }
    .err { color: #c53030; font-size: 12px; padding: 4px 8px; }
  </style>
</head>
<body>
  <div class="bar">
    <button id="back" title="Back">←</button>
    <button id="fwd"  title="Forward">→</button>
    <button id="reload" title="Reload">↻</button>
    <input id="url" type="text" placeholder="https://example.com" spellcheck="false" />
    <button id="go">Go</button>
  </div>
  <div class="status" id="status"></div>
  <div class="err" id="err" hidden></div>
  <div class="viewport" id="viewport">
    <div class="empty">Loading…</div>
  </div>
  <script type="module">
    // ----- Outbound JSON-RPC over postMessage to the host -----
    let nextId = 1;
    const pending = new Map();

    function send(message) { window.parent.postMessage(message, '*'); }
    function request(method, params) {
      const id = nextId++;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        send({ jsonrpc: '2.0', id, method, params });
      });
    }
    function notify(method, params) {
      send(params === undefined
        ? { jsonrpc: '2.0', method }
        : { jsonrpc: '2.0', method, params });
    }
    function respond(id, result) {
      send({ jsonrpc: '2.0', id, result });
    }

    // ----- View state -----
    let currentView = null; // structuredContent of the latest tool result
    let inflight = false;

    const $bar = {
      back: document.getElementById('back'),
      fwd: document.getElementById('fwd'),
      reload: document.getElementById('reload'),
      url: document.getElementById('url'),
      go: document.getElementById('go'),
    };
    const $status = document.getElementById('status');
    const $err = document.getElementById('err');
    const $viewport = document.getElementById('viewport');

    function setBusy(b) {
      inflight = b;
      for (const k of ['back', 'fwd', 'reload', 'go']) $bar[k].disabled = b;
    }
    function setError(msg) {
      if (!msg) { $err.hidden = true; $err.textContent = ''; return; }
      $err.hidden = false;
      $err.textContent = msg;
    }

    async function callTool(name, args) {
      setError('');
      setBusy(true);
      try {
        const result = await request('tools/call', { name, arguments: args || {} });
        if (result && result.structuredContent) {
          currentView = result.structuredContent;
          render();
        } else if (result && result.isError) {
          setError('Tool error: ' + (result.content?.[0]?.text || 'unknown'));
        }
      } catch (err) {
        setError(err.message || String(err));
      } finally {
        setBusy(false);
      }
    }

    function render() {
      if (!currentView) {
        $viewport.innerHTML = '<div class="empty">Type a URL and press Go.</div>';
        return;
      }
      const v = currentView;
      $bar.url.value = v.url || '';
      $status.textContent = (v.title || '') + (v.url ? ' — ' + v.url : '');

      const stage = document.createElement('div');
      stage.className = 'stage';
      const img = document.createElement('img');
      img.src = 'data:' + (v.screenshot_mime || 'image/jpeg') + ';base64,' + v.screenshot_base64;
      img.alt = v.title || 'page screenshot';
      stage.appendChild(img);

      img.addEventListener('click', (e) => {
        if (inflight) return;
        const rect = img.getBoundingClientRect();
        const scaleX = (v.viewport_width || rect.width) / rect.width;
        const scaleY = (v.viewport_height || rect.height) / rect.height;
        const x = Math.round((e.clientX - rect.left) * scaleX);
        const y = Math.round((e.clientY - rect.top) * scaleY);
        callTool('browser_click_at', { x, y });
      });

      // Overlay hotspots — scale viewport coords down to image-rendered space
      // after layout settles.
      img.addEventListener('load', () => {
        const rect = img.getBoundingClientRect();
        const sx = rect.width / (v.viewport_width || rect.width);
        const sy = rect.height / (v.viewport_height || rect.height);
        for (const el of v.elements || []) {
          const div = document.createElement('div');
          div.className = 'hotspot';
          div.style.left = (el.x * sx) + 'px';
          div.style.top = (el.y * sy) + 'px';
          div.style.width = (el.w * sx) + 'px';
          div.style.height = (el.h * sy) + 'px';
          div.dataset.label = (el.role || '') + (el.label ? ': ' + el.label : '');
          div.title = div.dataset.label;
          div.addEventListener('click', (ev) => {
            ev.stopPropagation();
            if (inflight) return;
            callTool('browser_click_ref', { ref: el.ref });
          });
          stage.appendChild(div);
        }
      });

      $viewport.replaceChildren(stage);
    }

    // ----- Wire toolbar -----
    $bar.go.addEventListener('click', () => {
      const url = $bar.url.value.trim();
      if (url) callTool('browser_navigate', { url });
    });
    $bar.url.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') $bar.go.click();
    });
    $bar.back.addEventListener('click', () => callTool('browser_back', {}));
    $bar.fwd.addEventListener('click', () => callTool('browser_forward', {}));
    $bar.reload.addEventListener('click', () => callTool('browser_reload', {}));

    // ----- Inbound MCP Apps messages from the host -----
    window.addEventListener('message', (event) => {
      const msg = event.data;
      if (!msg || msg.jsonrpc !== '2.0') return;
      if (msg.id != null && !('method' in msg)) {
        const slot = pending.get(msg.id);
        if (!slot) return;
        pending.delete(msg.id);
        if (msg.error) slot.reject(new Error(msg.error.message ?? 'host error'));
        else slot.resolve(msg.result);
        return;
      }
      const method = msg.method;
      if (method === 'ui/notifications/tool-input') {
        // initial input from the host-issued tool call; we don't pre-fill
        // anything — the result handler will set currentView.
        return;
      }
      if (method === 'ui/notifications/tool-result') {
        const result = msg.params || {};
        if (result.structuredContent) {
          currentView = result.structuredContent;
          render();
        }
        return;
      }
      if (method === 'ui/notifications/host-context-changed') return;
      if (method === 'ui/notifications/tool-cancelled') {
        setError('Tool execution was cancelled.');
        return;
      }
      if (msg.id != null) respond(msg.id, {});
    });

    (async () => {
      try {
        await request('ui/initialize', {
          appInfo: { name: 'browser', version: '1.0.0' },
          appCapabilities: {},
          protocolVersion: '2026-01-26',
        });
        notify('ui/notifications/initialized');
      } catch (err) {
        setError('Failed to initialize: ' + err.message);
      }
    })();
  </script>
</body>
</html>
"""


# ---------------------------------------------------------------------------
# FastMCP server
# ---------------------------------------------------------------------------


def _build_text_fallback(view: dict[str, Any]) -> str:
    """Plain-text content for non-MCP-Apps hosts and the LLM's text channel.

    Layout, top-to-bottom: page identity → visible viewport text →
    interactive element list (refs the model can pass to
    ``browser_click_ref``) → trimmed accessibility tree. The screenshot
    bytes are deliberately *not* echoed here — they live in
    ``structuredContent`` for the iframe / vision-enabled clients.
    """
    head = f"Browser at {view.get('url', '?')} — {view.get('title', '')}".rstrip(" —")
    vp_text = (view.get("viewport_text") or "").strip()
    elements = view.get("elements") or []
    interactive = "\n".join(
        f"  #{e['ref']} {e.get('role','?')}: {(e.get('label') or '').strip()}"
        for e in elements[:ELEMENT_FALLBACK_MAX_REFS]
    )
    elided_elements = max(0, len(elements) - ELEMENT_FALLBACK_MAX_REFS)
    summary = (view.get("accessibility_summary") or "").strip()

    parts = [head]
    if vp_text:
        parts.append("Visible page text:\n" + vp_text)
    if interactive:
        ix_block = "Interactive elements:\n" + interactive
        if elided_elements:
            ix_block += f"\n  …(+{elided_elements} more elements; call browser_view again or scroll)"
        parts.append(ix_block)
    if summary:
        parts.append("Accessibility tree (truncated):\n" + summary)
    return "\n\n".join(parts)


# ---------------------------------------------------------------------------
# FastMCP server
# ---------------------------------------------------------------------------


def create_browser_server() -> FastMCP:
    """Create the browser MCP App server."""
    session = BrowserSession()

    @asynccontextmanager
    async def lifespan(app: FastMCP):
        try:
            yield
        finally:
            await session.close()

    mcp = FastMCP(
        name="Browser-MCP-App",
        instructions=(
            "A Playwright-driven browser exposed as an MCP App (SEP-1865). "
            "Call `browser_navigate(url)` to open a page, then `browser_view()` "
            "for a screenshot + interactive elements. Use `browser_click_ref(ref)` "
            "with refs from the latest view to click reliably; "
            "`browser_click_at(x, y)` is also available for pixel-coord clicks. "
            "MCP-Apps-aware hosts will mount an interactive browser UI; plain "
            "MCP clients receive text + structured fallback."
        ),
        lifespan=lifespan,
    )

    ui_meta = {"ui": {"resourceUri": UI_RESOURCE_URI}, "viewUUID": session.view_uuid}

    def _make_tool_result(view: dict[str, Any]) -> ToolResult:
        """Package a captured view as a ToolResult.

        - ``content`` is the plain-text fallback, which is what the LLM
          actually reads when it doesn't have access to the iframe view.
          This *must not* contain the base64 screenshot, or the model's
          context will be flooded with JPEG noise.
        - ``structured_content`` carries the full view (screenshot,
          interactive elements with refs + bboxes, viewport text, AX
          summary) so the MCP App iframe can render the picture, the
          hotspot overlays, and the address bar.
        - ``meta`` advertises the MCP App resource URI per SEP-1865 so
          MCP-Apps-aware hosts re-mount the iframe on each call.
        """
        text = _build_text_fallback(view)
        structured = {**view, "_meta": dict(ui_meta)}
        return ToolResult(
            content=text,
            structured_content=structured,
            meta=dict(ui_meta),
        )

    # ---- Tools -------------------------------------------------------------
    # FastMCP only inspects the top-level return annotation when synthesising
    # the JSON output schema, so each tool returns a ToolResult. The
    # structured payload is what the iframe consumes; the text content is
    # what the model consumes.

    @mcp.tool(meta={"ui": {"resourceUri": UI_RESOURCE_URI}}, tags={"mcp-app"})
    async def browser_navigate(url: str) -> ToolResult:
        """Open ``url`` in the headless browser and return the resulting view."""
        await session.navigate(url)
        view = await session.view()
        return _make_tool_result(view)

    @mcp.tool(meta={"ui": {"resourceUri": UI_RESOURCE_URI}}, tags={"mcp-app"})
    async def browser_view() -> ToolResult:
        """Screenshot + interactive element list + visible page text for the current page."""
        view = await session.view()
        return _make_tool_result(view)

    @mcp.tool(meta={"ui": {"resourceUri": UI_RESOURCE_URI}}, tags={"mcp-app"})
    async def browser_click_at(x: float, y: float) -> ToolResult:
        """Click at viewport pixel coordinates ``(x, y)`` and return the new view."""
        await session.click_at(x, y)
        view = await session.view()
        return _make_tool_result(view)

    @mcp.tool(meta={"ui": {"resourceUri": UI_RESOURCE_URI}}, tags={"mcp-app"})
    async def browser_click_ref(ref: int) -> ToolResult:
        """Click hotspot ``#ref`` from the most recent ``browser_view`` result."""
        await session.click_ref(ref)
        view = await session.view()
        return _make_tool_result(view)

    @mcp.tool(meta={"ui": {"resourceUri": UI_RESOURCE_URI}}, tags={"mcp-app"})
    async def browser_type_at(
        text: str, x: float, y: float, submit: bool = False
    ) -> ToolResult:
        """Focus the element at ``(x, y)``, type ``text``, optionally press Enter."""
        await session.type_at(text, x, y, submit=submit)
        view = await session.view()
        return _make_tool_result(view)

    @mcp.tool(meta={"ui": {"resourceUri": UI_RESOURCE_URI}}, tags={"mcp-app"})
    async def browser_press(key: str) -> ToolResult:
        """Press a single keyboard key (``Enter``, ``Tab``, ``Escape``, …)."""
        await session.press(key)
        view = await session.view()
        return _make_tool_result(view)

    @mcp.tool(meta={"ui": {"resourceUri": UI_RESOURCE_URI}}, tags={"mcp-app"})
    async def browser_back() -> ToolResult:
        """Navigate back in history and return the new view."""
        await session.go_back()
        view = await session.view()
        return _make_tool_result(view)

    @mcp.tool(meta={"ui": {"resourceUri": UI_RESOURCE_URI}}, tags={"mcp-app"})
    async def browser_forward() -> ToolResult:
        """Navigate forward in history and return the new view."""
        await session.go_forward()
        view = await session.view()
        return _make_tool_result(view)

    @mcp.tool(meta={"ui": {"resourceUri": UI_RESOURCE_URI}}, tags={"mcp-app"})
    async def browser_reload() -> ToolResult:
        """Reload the current page and return the new view."""
        await session.reload()
        view = await session.view()
        return _make_tool_result(view)

    @mcp.tool
    async def browser_close() -> dict:
        """Close the browser session. Subsequent calls will re-launch it."""
        await session.close()
        return {"closed": True}

    # ---- Resource ----------------------------------------------------------

    @mcp.resource(
        UI_RESOURCE_URI,
        mime_type="text/html;profile=mcp-app",
        tags={"mcp-app"},
    )
    def browser_view_html() -> str:
        """HTML payload for the browser MCP App (SEP-1865)."""
        return BROWSER_UI_HTML

    return mcp


# ---------------------------------------------------------------------------
# CORS — same wrapper pattern as server.py so both `fastmcp run` and
# `python browser_server.py` accept browser preflights.
# ---------------------------------------------------------------------------


def _get_cors_middleware() -> list[Middleware]:
    origins_str = os.environ.get("CORS_ORIGINS", "*")
    origins = [o.strip() for o in origins_str.split(",") if o.strip()]
    allow_credentials = os.environ.get(
        "CORS_ALLOW_CREDENTIALS", "true"
    ).lower() in ("1", "true", "yes")
    if "*" in origins and allow_credentials:
        allow_credentials = False
    return [
        Middleware(
            CORSMiddleware,
            allow_origins=origins,
            allow_methods=["*"],
            allow_headers=["*"],
            allow_credentials=allow_credentials,
            expose_headers=["Mcp-Session-Id"],
        )
    ]


def _install_cors_on(server: FastMCP) -> None:
    original_http_app = server.http_app

    def http_app_with_cors(
        path: str | None = None,
        middleware: list | None = None,
        json_response: bool | None = None,
        stateless_http: bool | None = None,
        transport: str = "http",
        event_store=None,
        retry_interval: int | None = None,
    ):
        combined = list(middleware or []) + _get_cors_middleware()
        return original_http_app(
            path=path,
            middleware=combined,
            json_response=json_response,
            stateless_http=stateless_http,
            transport=transport,
            event_store=event_store,
            retry_interval=retry_interval,
        )

    server.http_app = http_app_with_cors  # type: ignore[method-assign]


# Module-level instance for ``fastmcp run browser_server.py``.
mcp: FastMCP = create_browser_server()
_install_cors_on(mcp)


if __name__ == "__main__":
    port = int(os.environ.get("PORT", 8001))
    stateless = os.environ.get("STATELESS_HTTP", "").lower() in (
        "1",
        "true",
        "yes",
    )
    mcp.run(
        transport="http",
        host="0.0.0.0",
        port=port,
        stateless_http=stateless,
    )