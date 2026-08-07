"""Runtime configuration loaded from the repository environment."""

from __future__ import annotations

import os
import re
from dataclasses import dataclass
from pathlib import Path

from dotenv import load_dotenv

REPO_ROOT = Path(__file__).resolve().parents[4]
DEFAULT_AZURE_OPENAI_API_VERSION = "2024-10-21"
DEFAULT_SKILL_PATH = Path(__file__).resolve().parent / "skills"
load_dotenv(REPO_ROOT / ".env")
for _blank_secret in ("AZURE_OPENAI_API_KEY", "OPENAI_API_KEY"):
    if os.getenv(_blank_secret) == "":
        os.environ.pop(_blank_secret, None)


def _env_bool(name: str, default: bool) -> bool:
    value = os.getenv(name)
    if value is None:
        return default
    return value.strip().lower() in {"1", "true", "yes", "on"}


def _env_int(name: str, default: int, minimum: int) -> int:
    value = int(os.getenv(name, str(default)))
    if value < minimum:
        raise ValueError(f"{name} must be at least {minimum}.")
    return value


def _repo_path(value: str) -> Path:
    path = Path(value)
    return (path if path.is_absolute() else REPO_ROOT / path).resolve()


def _env_paths(name: str, default: tuple[Path, ...]) -> tuple[Path, ...]:
    value = os.getenv(name)
    if value is None:
        return default
    return tuple(
        _repo_path(item.strip())
        for item in re.split(r"[,;]", value)
        if item.strip()
    )


@dataclass(frozen=True)
class Settings:
    host: str
    port: int
    agent_id: str
    governance_enabled: bool
    governance_policy_dir: Path
    governance_audit_path: Path | None
    model_endpoint: str | None
    model_deployment: str | None
    model_api_version: str | None
    model_api_key: str | None
    model_token_scope: str
    request_timeout_seconds: float
    skill_paths: tuple[Path, ...] = (DEFAULT_SKILL_PATH,)
    discovery_mcp_url: str | None = None
    governance_audit_max_entries: int = 10_000

    @classmethod
    def from_env(cls) -> "Settings":
        policy_path = _repo_path(
            os.getenv("AGT_POLICY_PATH")
            or os.getenv("GOVERNANCE_POLICY_PATH")
            or str(REPO_ROOT / "governance" / "policy.yaml")
        )
        audit_value = (
            os.getenv("AGT_AUDIT_PATH")
            or os.getenv("GOVERNANCE_AUDIT_PATH")
            or ""
        ).strip()
        return cls(
            host=os.getenv("ENGAGEMENTS_PYTHON_AGENT_HOST", "127.0.0.1"),
            port=int(os.getenv("ENGAGEMENTS_PYTHON_AGENT_PORT", "3030")),
            agent_id=os.getenv("AGENT_ID", "engagements-orchestrator"),
            governance_enabled=_env_bool("AGT_ENABLED", True),
            governance_policy_dir=policy_path.parent,
            governance_audit_path=_repo_path(audit_value) if audit_value else None,
            model_endpoint=os.getenv("AZURE_OPENAI_ENDPOINT") or None,
            model_deployment=os.getenv("AZURE_OPENAI_DEPLOYMENT") or None,
            model_api_version=(
                os.getenv("AZURE_OPENAI_API_VERSION")
                or DEFAULT_AZURE_OPENAI_API_VERSION
            ),
            model_api_key=os.getenv("AZURE_OPENAI_API_KEY") or None,
            model_token_scope=os.getenv(
                "AZURE_OPENAI_TOKEN_SCOPE",
                "https://cognitiveservices.azure.com/.default",
            ),
            request_timeout_seconds=float(os.getenv("AGENT_REQUEST_TIMEOUT_SECONDS", "45")),
            skill_paths=_env_paths(
                "ENGAGEMENTS_SKILL_PATHS",
                (DEFAULT_SKILL_PATH,),
            ),
            discovery_mcp_url=(
                os.getenv("DISCOVERY_MCP_URL", "http://localhost:3011/mcp").strip() or None
            ),
            governance_audit_max_entries=_env_int(
                "AGT_AUDIT_MAX_ENTRIES",
                10_000,
                2,
            ),
        )

    @property
    def model_configured(self) -> bool:
        return bool(self.model_endpoint and self.model_deployment)

    @property
    def discovery_configured(self) -> bool:
        return bool(self.discovery_mcp_url)
