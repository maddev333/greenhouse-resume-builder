"""Governed bridge to the existing TypeScript MCP capability."""

from __future__ import annotations

import itertools
import json
from typing import Any

import httpx

from .governance import GovernanceRuntime
from .models import CapturedCall, ToolDescriptor


class McpCallError(RuntimeError):
    pass


class GovernedMcpClient:
    def __init__(
        self,
        governance: GovernanceRuntime,
        timeout_seconds: float,
        http_client: httpx.AsyncClient | None = None,
    ):
        self.governance = governance
        self._ids = itertools.count(1)
        self._owns_client = http_client is None
        self._client = http_client or httpx.AsyncClient(timeout=timeout_seconds)

    async def close(self) -> None:
        if self._owns_client:
            await self._client.aclose()

    async def list_tools(self, *, mcp_url: str) -> list[ToolDescriptor]:
        payload = await self._rpc(
            mcp_url=mcp_url,
            method="tools/list",
            params={},
        )
        tools = payload.get("tools")
        if not isinstance(tools, list):
            raise McpCallError("MCP tools/list returned no tool list.")
        return [
            ToolDescriptor(
                name=str(item.get("name", "")),
                description=str(item.get("description", "")),
                input_schema=item.get("inputSchema") or {},
            )
            for item in tools
            if isinstance(item, dict) and item.get("name")
        ]

    async def call_tool(
        self,
        *,
        mcp_url: str,
        name: str,
        arguments: dict[str, Any],
        trace_id: str,
        caller_agent_id: str,
    ) -> CapturedCall:
        self.governance.authorize_tool(
            name=name,
            arguments=arguments,
            trace_id=trace_id,
            caller_agent_id=caller_agent_id,
        )
        try:
            raw = await self._rpc(
                mcp_url=mcp_url,
                method="tools/call",
                params={"name": name, "arguments": arguments},
            )
            is_error = bool(raw.get("isError"))
            structured = raw.get("structuredContent")
            text = _text_content(raw)
            model_result: Any = structured if structured is not None else (text or {})
            if name == "build_itinerary" and isinstance(model_result, dict):
                model_result = {
                    key: value for key, value in model_result.items() if key != "tripMap"
                }
            captured = CapturedCall(
                name=name,
                args=arguments,
                result=structured if structured is not None else {},
                text=text,
                model_result=model_result,
            )
            self.governance.record_tool_result(
                name=name,
                arguments=arguments,
                trace_id=trace_id,
                caller_agent_id=caller_agent_id,
                succeeded=not is_error,
                error=text if is_error else None,
            )
            return captured
        except Exception as exc:
            self.governance.record_tool_result(
                name=name,
                arguments=arguments,
                trace_id=trace_id,
                caller_agent_id=caller_agent_id,
                succeeded=False,
                error=str(exc),
            )
            raise

    async def _rpc(
        self,
        *,
        mcp_url: str,
        method: str,
        params: dict[str, Any],
    ) -> dict[str, Any]:
        request_id = next(self._ids)
        try:
            response = await self._client.post(
                mcp_url,
                headers={
                    "content-type": "application/json",
                    "accept": "application/json, text/event-stream",
                },
                json={
                    "jsonrpc": "2.0",
                    "id": request_id,
                    "method": method,
                    "params": params,
                },
            )
            response.raise_for_status()
            body = _decode_rpc_response(response, request_id)
        except (httpx.HTTPError, ValueError) as exc:
            raise McpCallError(f"MCP {method} request failed: {exc}") from exc

        if body.get("error"):
            error = body["error"]
            message = error.get("message") if isinstance(error, dict) else str(error)
            raise McpCallError(f"MCP {method} error: {message}")
        result = body.get("result")
        if not isinstance(result, dict):
            raise McpCallError(f"MCP {method} returned an invalid result.")
        return result


def _text_content(result: dict[str, Any]) -> str:
    content = result.get("content")
    if not isinstance(content, list):
        return ""
    return "\n".join(
        str(part.get("text", ""))
        for part in content
        if isinstance(part, dict) and part.get("type") == "text"
    )


def _decode_rpc_response(
    response: httpx.Response,
    request_id: int,
) -> dict[str, Any]:
    content_type = response.headers.get("content-type", "").lower()
    if "text/event-stream" not in content_type:
        body = response.json()
        if not isinstance(body, dict):
            raise ValueError("JSON-RPC response body is not an object.")
        return body

    data_lines: list[str] = []
    candidates: list[dict[str, Any]] = []
    for line in [*response.text.splitlines(), ""]:
        if line.startswith("data:"):
            data_lines.append(line[5:].lstrip())
            continue
        if line or not data_lines:
            continue
        payload = json.loads("\n".join(data_lines))
        data_lines.clear()
        if isinstance(payload, dict):
            candidates.append(payload)

    for candidate in candidates:
        if candidate.get("id") == request_id:
            return candidate
    raise ValueError(f"SSE stream contained no JSON-RPC response for id {request_id}.")
