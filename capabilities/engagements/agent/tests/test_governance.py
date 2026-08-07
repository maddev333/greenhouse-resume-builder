import json

import pytest
from agent_framework import Agent

from engagements_agent.config import Settings
from engagements_agent.governance import (
    ENGAGEMENTS_TOOL_NAMES,
    MODEL_TOOL_NAMES,
    SKILL_TOOL_NAMES,
    GovernanceDenied,
    GovernanceRuntime,
    resolve_capability_backend,
)


def test_agt_policy_allows_planning_tool(settings: Settings) -> None:
    governance = GovernanceRuntime(settings)

    governance.authorize_tool(
        name="search_contacts",
        arguments={"query": "UAS"},
        trace_id="trace-1",
        caller_agent_id="test-agent",
    )

    assert governance.verify_audit()
    assert governance.max_tokens == 8192
    assert governance.max_tool_calls == 10
    assert settings.governance_audit_path is not None
    assert settings.governance_audit_path.read_text(encoding="utf-8").count("\n") == 1


def test_agt_policy_allows_the_grounding_tool(settings: Settings) -> None:
    """search_grounding is part of the capability contract, so the allowlist must admit it."""
    governance = GovernanceRuntime(settings)

    governance.authorize_tool(
        name="search_grounding",
        arguments={"query": "UAS at AUSA"},
        trace_id="trace-grounding",
        caller_agent_id="test-agent",
    )

    assert governance.verify_audit()


def test_capability_backend_is_classified_from_the_registered_tools() -> None:
    assert resolve_capability_backend(set(ENGAGEMENTS_TOOL_NAMES)) == "planner"
    # A `search` backend may serve BOTH structured records and a RAG corpus.
    assert (
        resolve_capability_backend({*ENGAGEMENTS_TOOL_NAMES, "search_grounding"})
        == "planner"
    )
    assert resolve_capability_backend({"search_grounding"}) == "grounding"
    assert resolve_capability_backend({"search_contacts"}) is None
    assert resolve_capability_backend(set()) is None


def test_model_guard_allows_only_read_only_skill_tools() -> None:
    assert SKILL_TOOL_NAMES <= MODEL_TOOL_NAMES
    assert SKILL_TOOL_NAMES == {"load_skill", "read_skill_resource"}
    assert "run_skill_script" not in MODEL_TOOL_NAMES


def test_agt_policy_blocks_ssn_in_tool_arguments(settings: Settings) -> None:
    governance = GovernanceRuntime(settings)
    ssn = "123-45-6789"

    with pytest.raises(GovernanceDenied, match="block-ssn"):
        governance.authorize_tool(
            name="search_contacts",
            arguments={"query": ssn},
            trace_id="trace-2",
            caller_agent_id="test-agent",
        )

    audit_text = settings.governance_audit_path.read_text(encoding="utf-8")
    audit_entry = json.loads(audit_text)
    assert ssn not in audit_text
    assert audit_entry["argument_keys"] == ["query"]
    assert len(audit_entry["arguments_sha256"]) == 64


def test_gateway_allowlist_fails_closed_before_policy(settings: Settings) -> None:
    governance = GovernanceRuntime(settings)

    with pytest.raises(GovernanceDenied, match="orchestrator-tool-allowlist"):
        governance.authorize_tool(
            name="execute_shell",
            arguments={"command": "whoami"},
            trace_id="trace-3",
            caller_agent_id="test-agent",
        )


async def test_agt_input_denial_surfaces_as_governance_error(
    settings: Settings,
) -> None:
    class ModelClient:
        called = False

        async def get_response(self, *args, **kwargs):
            self.called = True
            raise AssertionError("The model must not run after an input-policy denial.")

    governance = GovernanceRuntime(settings)
    model_client = ModelClient()

    async with Agent(
        client=model_client,
        name="test-agent",
        middleware=governance.middleware,
    ) as agent:
        with pytest.raises(GovernanceDenied, match="block-ssn"):
            await agent.run("My SSN is 123-45-6789.")

    assert not model_client.called


def test_policy_tool_call_limit_applies_per_trace(settings: Settings) -> None:
    governance = GovernanceRuntime(settings)

    for _ in range(10):
        governance.authorize_tool(
            name="search_contacts",
            arguments={"query": "cyber"},
            trace_id="trace-budget",
            caller_agent_id="test-agent",
        )

    with pytest.raises(GovernanceDenied, match="max-tool-calls"):
        governance.authorize_tool(
            name="search_contacts",
            arguments={"query": "cyber"},
            trace_id="trace-budget",
            caller_agent_id="test-agent",
        )

    governance.authorize_tool(
        name="search_contacts",
        arguments={"query": "cyber"},
        trace_id="different-trace",
        caller_agent_id="test-agent",
    )


async def test_agent_audit_hashes_provider_errors(settings: Settings) -> None:
    secret = "provider-secret-sentinel"

    class ModelClient:
        async def get_response(self, *args, **kwargs):
            raise RuntimeError(secret)

    governance = GovernanceRuntime(settings)
    async with Agent(
        client=ModelClient(),
        name="test-agent",
        middleware=governance.middleware,
    ) as agent:
        with pytest.raises(RuntimeError, match=secret):
            await agent.run("Plan a trip.")

    exported = json.dumps(governance.audit_log.export(), default=str)
    assert secret not in exported
    assert "error_sha256" in exported


def test_audit_log_rotates_at_configured_bound(settings: Settings) -> None:
    configured = Settings(
        **{
            **settings.__dict__,
            "governance_audit_max_entries": 3,
        }
    )
    governance = GovernanceRuntime(configured)

    for index in range(4):
        governance.audit_log.log(
            event_type="test",
            agent_did="test-agent",
            action=str(index),
        )

    exported = governance.audit_log.export()
    assert exported["entry_count"] <= 3
    assert any(
        entry["event_type"] == "audit_chain_rotated"
        for entry in exported["entries"]
    )
    assert governance.verify_audit()
