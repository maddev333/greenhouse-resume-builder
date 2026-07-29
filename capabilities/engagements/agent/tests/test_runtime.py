import asyncio

import pytest
from pydantic import ValidationError

import engagements_agent.runtime as runtime_module
from engagements_agent.config import Settings
from engagements_agent.governance import (
    MODEL_TOOL_NAMES,
    GovernanceDenied,
    GovernanceRuntime,
)
from engagements_agent.mcp_client import GovernedMcpClient
from engagements_agent.models import AgentDecision, AgentRunRequest, CapturedCall
from engagements_agent.runtime import AgentRuntime, AgentRunTimeout


def test_agent_framework_tools_match_governance_allowlist(settings: Settings) -> None:
    governance = GovernanceRuntime(settings)
    bridge = GovernedMcpClient(governance, timeout_seconds=5)
    runtime = AgentRuntime(settings, governance, bridge)
    request = AgentRunRequest(
        system="Use tools.",
        user="Plan a trip.",
        mcpUrl="http://mcp.test/mcp",
        persona="EA_G8",
        traceId="trace-tools",
    )

    tools = runtime._build_tools(request, [])

    assert {tool.name for tool in tools} == MODEL_TOOL_NAMES
    schemas = {tool.name: tool.to_json_schema_spec() for tool in tools}
    assert schemas["plan_options"]["function"]["parameters"]["required"] == ["window"]
    assert (
        "additionalContactIds"
        in schemas["build_itinerary"]["function"]["parameters"]["properties"]
    )


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
        persona="EA_G8",
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
        persona="EA_G8",
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
    class Bridge:
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
                persona="EA_G8",
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
    runtime = AgentRuntime(configured, governance, object())
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
                persona="EA_G8",
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
    runtime = AgentRuntime(settings, governance, object())
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
            persona="EA_G8",
            traceId="trace-decision",
        )
    )

    assert result.decision == expected
    assert result.output == expected.answer
    assert result.iterations == 1
    assert model_client.client.closed
