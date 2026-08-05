import asyncio
from dataclasses import replace

import pytest
from pydantic import ValidationError

import engagements_agent.runtime as runtime_module
from engagements_agent.config import Settings
from engagements_agent.governance import (
    CAPABILITY_TOOL_NAMES,
    ENGAGEMENTS_TOOL_NAMES,
    GROUNDING_TOOL_NAMES,
    MODEL_TOOL_NAMES,
    GovernanceDenied,
    GovernanceRuntime,
)
from engagements_agent.mcp_client import GovernedMcpClient, McpCallError
from engagements_agent.models import (
    AgentDecision,
    AgentRunRequest,
    CapturedCall,
    ToolDescriptor,
)
from engagements_agent.runtime import AgentRuntime, AgentRunTimeout


class PlannerBridge:
    """Bridge stub advertising the planner surface `AgentRuntime.run` discovers per turn."""

    async def list_tools(self, *, mcp_url: str) -> list[ToolDescriptor]:
        return [ToolDescriptor(name=name) for name in sorted(ENGAGEMENTS_TOOL_NAMES)]


def test_agent_framework_tools_match_governance_allowlist(settings: Settings) -> None:
    governance = GovernanceRuntime(settings)
    bridge = GovernedMcpClient(governance, timeout_seconds=5)
    runtime = AgentRuntime(settings, governance, bridge)
    request = AgentRunRequest(
        system="Use tools.",
        user="Plan a trip.",
        mcpUrl="http://mcp.test/mcp",
        traceId="trace-tools",
    )

    tools = runtime._build_tools(request, [], None, set(CAPABILITY_TOOL_NAMES))

    assert {tool.name for tool in tools} == MODEL_TOOL_NAMES
    schemas = {tool.name: tool.to_json_schema_spec() for tool in tools}
    assert schemas["plan_options"]["function"]["parameters"]["required"] == ["window"]
    assert (
        "additionalContactIds"
        in schemas["build_itinerary"]["function"]["parameters"]["properties"]
    )


def test_grounding_only_capability_builds_only_the_grounding_tool(
    settings: Settings,
) -> None:
    """RETRIEVAL_BACKEND=grounding registers one tool; the model must be offered exactly that.

    Offering the planner surface instead makes every call fail "tool not found", which the model
    hides by answering from its instructions instead of the corpus.
    """
    configured = replace(settings, discovery_mcp_url=None)
    governance = GovernanceRuntime(configured)
    bridge = GovernedMcpClient(governance, timeout_seconds=5)
    runtime = AgentRuntime(configured, governance, bridge)
    request = AgentRunRequest(
        system="Answer from the corpus.",
        user="Who should I meet on UAS at AUSA?",
        mcpUrl="http://mcp.test/mcp",
        traceId="trace-grounding",
    )

    tools = runtime._build_tools(request, [], None, set(GROUNDING_TOOL_NAMES))

    assert {tool.name for tool in tools} == GROUNDING_TOOL_NAMES
    schema = tools[0].to_json_schema_spec()["function"]["parameters"]
    assert schema["required"] == ["query"]


async def test_a_capability_with_no_recognised_surface_fails_the_run(
    settings: Settings,
) -> None:
    class Bridge:
        async def list_tools(self, *, mcp_url: str):
            return []

    runtime = AgentRuntime(settings, GovernanceRuntime(settings), Bridge())
    request = AgentRunRequest(
        system="Use tools.",
        user="Plan a trip.",
        mcpUrl="http://mcp.test/mcp",
        traceId="trace-empty",
    )

    with pytest.raises(McpCallError, match="nor search_grounding"):
        await runtime._discover_capability(request)


def test_discovery_tool_is_omitted_when_no_discovery_endpoint(
    settings: Settings,
) -> None:
    configured = replace(settings, discovery_mcp_url=None)
    governance = GovernanceRuntime(configured)
    bridge = GovernedMcpClient(governance, timeout_seconds=5)
    runtime = AgentRuntime(configured, governance, bridge)
    request = AgentRunRequest(
        system="Use tools.",
        user="What is near Huntsville?",
        mcpUrl="http://mcp.test/mcp",
        traceId="trace-no-discovery",
    )

    names = {tool.name for tool in runtime._build_tools(request, [])}

    assert names == ENGAGEMENTS_TOOL_NAMES


async def test_discovery_tool_targets_the_discovery_capability(
    settings: Settings,
) -> None:
    class Bridge:
        seen: list[str] = []

        async def call_tool(self, **kwargs):
            self.seen.append(kwargs["mcp_url"])
            return CapturedCall(
                name=kwargs["name"],
                args=kwargs["arguments"],
                result={},
                text="",
                modelResult={},
            )

    governance = GovernanceRuntime(settings)
    bridge = Bridge()
    runtime = AgentRuntime(settings, governance, bridge)
    request = AgentRunRequest(
        system="Use tools.",
        user="What is near Huntsville?",
        mcpUrl="http://mcp.test/mcp",
        traceId="trace-discovery",
    )
    tools = {tool.name: tool for tool in runtime._build_tools(request, [])}

    await tools["search_businesses"].invoke(
        arguments={"city": "Huntsville", "state": "AL", "focus": ["industry"]}
    )
    await tools["search_contacts"].invoke(arguments={"query": "Huntsville"})

    # Discovery is a DIFFERENT capability server; engagements calls must not be redirected to it.
    assert bridge.seen == ["http://discovery.test/mcp", "http://mcp.test/mcp"]


def test_agent_decision_rejects_inconsistent_stage_fields() -> None:
    with pytest.raises(ValidationError, match="Only lookup intent"):
        AgentDecision(
            intent="event",
            stage="answer",
            answer="Not a grounded event plan.",
        )

    with pytest.raises(ValidationError, match="recommended_option_index is required"):
        AgentDecision(
            intent="event",
            stage="options",
            leaderId="L1",
            answer="Two options.",
        )


async def test_entra_model_client_uses_preconfigured_azure_client(
    settings: Settings,
) -> None:
    class Token:
        token = "test-token"

    class Credential:
        async def get_token(self, scope: str) -> Token:
            assert scope == "https://cognitiveservices.azure.com/.default"
            return Token()

        async def close(self) -> None:
            return None

    configured = Settings(
        **{
            **settings.__dict__,
            "model_endpoint": "https://example.openai.azure.com",
            "model_deployment": "test-deployment",
            "model_api_version": "2024-10-21",
        }
    )
    governance = GovernanceRuntime(configured)
    bridge = GovernedMcpClient(governance, timeout_seconds=5)
    runtime = AgentRuntime(configured, governance, bridge)
    runtime._credential = Credential()

    client = await runtime._create_model_client(20)

    assert client.model == "test-deployment"
    assert client.function_invocation_configuration["max_iterations"] == 20
    assert client.function_invocation_configuration["max_function_calls"] == 10
    await client.client.close()


async def test_function_tool_forwards_only_declared_arguments(
    settings: Settings,
) -> None:
    class Bridge:
        received: dict | None = None

        async def call_tool(self, **kwargs):
            self.received = kwargs
            return CapturedCall(
                name=kwargs["name"],
                args=kwargs["arguments"],
                result={"contacts": []},
                text="No contacts.",
                modelResult={"contacts": []},
            )

    governance = GovernanceRuntime(settings)
    bridge = Bridge()
    runtime = AgentRuntime(settings, governance, bridge)
    request = AgentRunRequest(
        system="Use tools.",
        user="Find cyber contacts.",
        mcpUrl="http://mcp.test/mcp",
        traceId="trace-forwarding",
    )
    search_contacts = runtime._build_tools(request, [])[0]

    await search_contacts.invoke(
        arguments={
            "query": "cyber",
            "topicIds": ["T2"],
            "status": "active",
        }
    )

    assert bridge.received is not None
    assert bridge.received["arguments"] == {
        "query": "cyber",
        "topicIds": ["T2"],
        "status": "active",
    }


async def test_parallel_tools_cannot_exceed_call_budget(
    settings: Settings,
) -> None:
    class Bridge:
        calls = 0

        async def call_tool(self, **kwargs):
            self.calls += 1
            await asyncio.sleep(0)
            return CapturedCall(
                name=kwargs["name"],
                args=kwargs["arguments"],
                result={},
                text="",
                modelResult={},
            )

    bridge = Bridge()
    governance = GovernanceRuntime(settings)
    runtime = AgentRuntime(settings, governance, bridge)
    request = AgentRunRequest(
        system="Use tools.",
        user="Find contacts.",
        mcpUrl="http://mcp.test/mcp",
        traceId="trace-budget",
        maxIterations=1,
    )
    search_contacts = runtime._build_tools(request, [])[0]

    results = await asyncio.gather(
        search_contacts.invoke(arguments={"query": "one"}),
        search_contacts.invoke(arguments={"query": "two"}),
        return_exceptions=True,
    )

    assert bridge.calls == 1
    assert sum(isinstance(result, RuntimeError) for result in results) == 1


async def test_tool_governance_denial_aborts_agent_run(
    settings: Settings,
    monkeypatch,
) -> None:
    class Bridge(PlannerBridge):
        async def call_tool(self, **kwargs):
            raise GovernanceDenied("block-ssn", "Sensitive input is blocked.")

    class UnderlyingClient:
        closed = False

        async def close(self) -> None:
            self.closed = True

    class ModelClient:
        client = UnderlyingClient()

    class Agent:
        default_options = None

        def __init__(self, **kwargs):
            self.tools = kwargs["tools"]
            type(self).default_options = kwargs["default_options"]

        async def __aenter__(self):
            return self

        async def __aexit__(self, *args):
            return None

        async def run(self, _user, **_kwargs):
            try:
                await self.tools[0].invoke(arguments={"query": "blocked"})
            except runtime_module.MiddlewareTermination:
                pass
            return type("Response", (), {"text": "blocked"})()

    governance = GovernanceRuntime(settings)
    runtime = AgentRuntime(settings, governance, Bridge())
    model_client = ModelClient()

    async def create_model_client(_max_iterations: int):
        return model_client

    monkeypatch.setattr(runtime, "_create_model_client", create_model_client)
    monkeypatch.setattr(runtime_module, "Agent", Agent)

    with pytest.raises(GovernanceDenied, match="block-ssn"):
        await runtime.run(
            AgentRunRequest(
                system="Use tools.",
                user="Find contacts.",
                mcpUrl="http://mcp.test/mcp",
                traceId="trace-denial",
            )
        )

    assert model_client.client.closed
    assert Agent.default_options == {"max_tokens": 8192}


async def test_agent_run_timeout_cancels_model_work(
    settings: Settings,
    monkeypatch,
) -> None:
    configured = Settings(
        **{
            **settings.__dict__,
            "request_timeout_seconds": 0.01,
        }
    )

    class UnderlyingClient:
        closed = False

        async def close(self) -> None:
            self.closed = True

    class ModelClient:
        client = UnderlyingClient()

    class Agent:
        def __init__(self, **_kwargs):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *args):
            return None

        async def run(self, _user, **_kwargs):
            await asyncio.sleep(1)

    governance = GovernanceRuntime(configured)
    runtime = AgentRuntime(configured, governance, PlannerBridge())
    model_client = ModelClient()

    async def create_model_client(_max_iterations: int):
        return model_client

    monkeypatch.setattr(runtime, "_create_model_client", create_model_client)
    monkeypatch.setattr(runtime_module, "Agent", Agent)

    with pytest.raises(AgentRunTimeout, match="0.01 seconds"):
        await runtime.run(
            AgentRunRequest(
                system="Use tools.",
                user="Plan a trip.",
                mcpUrl="http://mcp.test/mcp",
                traceId="trace-timeout",
            )
        )

    assert model_client.client.closed


async def test_agent_run_returns_structured_framework_decision(
    settings: Settings,
    monkeypatch,
) -> None:
    class UnderlyingClient:
        closed = False

        async def close(self) -> None:
            self.closed = True

    class ModelClient:
        client = UnderlyingClient()

    expected = AgentDecision(
        intent="area",
        stage="clarify",
        clarify="category",
        answer="Which engagement category should this trip focus on?",
    )

    class Agent:
        def __init__(self, **_kwargs):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *args):
            return None

        async def run(self, _user, *, options):
            assert options == {"response_format": AgentDecision}
            return type("Response", (), {"value": expected})()

    governance = GovernanceRuntime(settings)
    runtime = AgentRuntime(settings, governance, PlannerBridge())
    model_client = ModelClient()

    async def create_model_client(_max_iterations: int):
        return model_client

    monkeypatch.setattr(runtime, "_create_model_client", create_model_client)
    monkeypatch.setattr(runtime_module, "Agent", Agent)

    result = await runtime.run(
        AgentRunRequest(
            system="Use tools.",
            user="Plan a trip to Boston.",
            mcpUrl="http://mcp.test/mcp",
            traceId="trace-decision",
        )
    )

    assert result.decision == expected
    assert result.output == expected.answer
    assert result.iterations == 1
    assert model_client.client.closed
