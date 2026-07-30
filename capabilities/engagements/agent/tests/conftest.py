from pathlib import Path

import pytest

from engagements_agent.config import REPO_ROOT, Settings


@pytest.fixture
def settings(tmp_path: Path) -> Settings:
    return Settings(
        host="127.0.0.1",
        port=3030,
        agent_id="test-engagements-agent",
        governance_enabled=True,
        governance_policy_dir=REPO_ROOT / "governance",
        governance_audit_path=tmp_path / "audit.jsonl",
        model_endpoint=None,
        model_deployment=None,
        model_api_version=None,
        model_api_key=None,
        model_token_scope="https://cognitiveservices.azure.com/.default",
        request_timeout_seconds=5,
        discovery_mcp_url="http://discovery.test/mcp",
    )
