import json

import pytest
from agent_framework import Agent

from engagements_agent.config import Settings
from engagements_agent.governance import GovernanceDenied, GovernanceRuntime


def test_agt_policy_allows_planning_tool(settings: Settings) -> None:
    governance = GovernanceRuntime(settings)

    governance.authorize_tool(
        name="search_contacts",
        arguments={"query": "UAS"},
        trace_id="trace-1",
        persona="EA_G8",
        caller_agent_id="test-agent",
    )

    assert governance.verify_audit()
    assert governance.max_tokens == 8192
    assert governance.max_tool_calls == 10
    assert settings.governance_audit_path is not None
    assert settings.governance_audit_path.read_text(encoding="utf-8").count("\n") == 1


def test_agt_policy_blocks_ssn_in_tool_arguments(settings: Settings) -> None:
    governance = GovernanceRuntime(settings)
    ssn = "123-45-6789"

    with pytest.raises(GovernanceDenied, match="block-ssn"):
        governance.authorize_tool(
            name="search_contacts",
            arguments={"query": ssn},
            trace_id="trace-2",
            persona="EA_G8",
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
            persona="EA_G8",
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
            persona="EA_G8",
            caller_agent_id="test-agent",
        )

    with pytest.raises(GovernanceDenied, match="max-tool-calls"):
        governance.authorize_tool(
            name="search_contacts",
            arguments={"query": "cyber"},
            trace_id="trace-budget",
            persona="EA_G8",
            caller_agent_id="test-agent",
        )

    governance.authorize_tool(
        name="search_contacts",
        arguments={"query": "cyber"},
        trace_id="different-trace",
        persona="EA_G8",
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
