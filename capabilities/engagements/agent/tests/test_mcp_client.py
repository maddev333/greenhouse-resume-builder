import httpx

from engagements_agent.config import Settings
from engagements_agent.governance import GovernanceRuntime
from engagements_agent.mcp_client import GovernedMcpClient


async def test_mcp_bridge_preserves_map_but_strips_it_from_model(
    settings: Settings,
) -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        payload = __import__("json").loads(request.content)
        assert payload["method"] == "tools/call"
        return httpx.Response(
            200,
            json={
                "jsonrpc": "2.0",
                "id": payload["id"],
                "result": {
                    "content": [{"type": "text", "text": "Built itinerary"}],
                    "structuredContent": {
                        "itinerary": {"leaderId": "L1"},
                        "tripMap": {"stops": [{"id": "C1"}]},
                    },
                },
            },
        )

    http_client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    bridge = GovernedMcpClient(
        GovernanceRuntime(settings),
        timeout_seconds=5,
        http_client=http_client,
    )

    result = await bridge.call_tool(
        mcp_url="http://mcp.test/mcp",
        name="build_itinerary",
        arguments={"leaderId": "L1"},
        trace_id="trace-map",
        caller_agent_id="test-agent",
    )

    assert result.result["tripMap"]["stops"][0]["id"] == "C1"
    assert "tripMap" not in result.model_result
    assert result.text == "Built itinerary"
    await http_client.aclose()


async def test_mcp_bridge_discovers_tools(settings: Settings) -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        payload = __import__("json").loads(request.content)
        result = {
            "jsonrpc": "2.0",
            "id": payload["id"],
            "result": {
                "tools": [
                    {
                        "name": "search_contacts",
                        "description": "Search contacts",
                        "inputSchema": {"type": "object", "properties": {}},
                    }
                ]
            },
        }
        return httpx.Response(
            200,
            headers={"content-type": "text/event-stream"},
            text=(
                "event: message\n"
                f"data: {__import__('json').dumps(result)}\n\n"
            ),
        )

    http_client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    bridge = GovernedMcpClient(
        GovernanceRuntime(settings),
        timeout_seconds=5,
        http_client=http_client,
    )

    tools = await bridge.list_tools(mcp_url="http://mcp.test/mcp")

    assert [tool.name for tool in tools] == ["search_contacts"]
    await http_client.aclose()


async def test_mcp_tool_error_is_returned_to_the_orchestrator(
    settings: Settings,
) -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        payload = __import__("json").loads(request.content)
        return httpx.Response(
            200,
            json={
                "jsonrpc": "2.0",
                "id": payload["id"],
                "result": {
                    "content": [{"type": "text", "text": "No event matched."}],
                    "isError": True,
                },
            },
        )

    http_client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    bridge = GovernedMcpClient(
        GovernanceRuntime(settings),
        timeout_seconds=5,
        http_client=http_client,
    )

    result = await bridge.call_tool(
        mcp_url="http://mcp.test/mcp",
        name="search_events",
        arguments={"query": "unknown"},
        trace_id="trace-error-result",
        caller_agent_id="test-agent",
    )

    assert result.model_result == "No event matched."
    assert result.result == {}
    await http_client.aclose()
