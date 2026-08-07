from pathlib import Path

from engagements_agent.config import (
    DEFAULT_AZURE_OPENAI_API_VERSION,
    DEFAULT_SKILL_PATH,
    REPO_ROOT,
    Settings,
)


def test_relative_governance_paths_are_repo_relative(
    monkeypatch,
    tmp_path: Path,
) -> None:
    monkeypatch.chdir(tmp_path)
    monkeypatch.setenv("AGT_POLICY_PATH", "governance/policy.yaml")
    monkeypatch.setenv("AGT_AUDIT_PATH", ".local/audit.jsonl")

    settings = Settings.from_env()

    assert settings.governance_policy_dir == REPO_ROOT / "governance"
    assert settings.governance_audit_path == REPO_ROOT / ".local" / "audit.jsonl"


def test_azure_openai_api_version_has_a_safe_default(monkeypatch) -> None:
    monkeypatch.delenv("AZURE_OPENAI_API_VERSION", raising=False)

    settings = Settings.from_env()

    assert settings.model_api_version == DEFAULT_AZURE_OPENAI_API_VERSION


def test_skill_paths_default_to_packaged_skills_and_accept_a_list(monkeypatch) -> None:
    monkeypatch.delenv("ENGAGEMENTS_SKILL_PATHS", raising=False)
    assert Settings.from_env().skill_paths == (DEFAULT_SKILL_PATH,)

    monkeypatch.setenv(
        "ENGAGEMENTS_SKILL_PATHS",
        "capabilities/engagements/agent/engagements_agent/skills;custom/skills",
    )

    assert Settings.from_env().skill_paths == (
        DEFAULT_SKILL_PATH,
        REPO_ROOT / "custom" / "skills",
    )
