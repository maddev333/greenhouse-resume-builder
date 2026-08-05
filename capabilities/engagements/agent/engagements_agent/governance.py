"""Microsoft Agent Governance Toolkit policy, capability, and audit integration."""

from __future__ import annotations

import hashlib
import json
import threading
import time
from collections.abc import Awaitable, Callable
from pathlib import Path
from typing import Any

from agent_framework import AgentMiddleware, MiddlewareTermination
from agent_os.integrations.maf_adapter import (
    AuditTrailMiddleware,
    CapabilityGuardMiddleware,
    GovernancePolicyMiddleware,
)
from agent_os.policies import PolicyEvaluator
from agentmesh.governance import AuditLog

from .config import Settings

ENGAGEMENTS_TOOL_NAMES = frozenset(
    {
        "search_contacts",
        "search_events",
        "survey_area",
        "suggest_leaders",
        "nearby_leaders",
        "plan_options",
        "plan_radius",
        "suggest_candidates",
        "build_itinerary",
    }
)

#: Tools served by the standalone Area Discovery capability, not the engagements capability. Kept in a
#: separate set so `/tools/list` never demands them from the engagements MCP, while `authorize_tool`
#: and the capability guard still govern them exactly like every other tool.
DISCOVERY_TOOL_NAMES = frozenset({"search_businesses"})

ORCHESTRATOR_TOOL_NAMES = ENGAGEMENTS_TOOL_NAMES | DISCOVERY_TOOL_NAMES

MODEL_TOOL_NAMES = ORCHESTRATOR_TOOL_NAMES

_MAX_TRACKED_TRACES = 10_000


class GovernanceDenied(RuntimeError):
    def __init__(self, rule: str | None, reason: str):
        self.rule = rule
        self.reason = reason
        super().__init__(f"Denied by governance{f' rule {rule!r}' if rule else ''}: {reason}")


class _GovernanceTerminationMiddleware(AgentMiddleware):
    async def process(
        self,
        context: Any,
        call_next: Callable[[], Awaitable[None]],
    ) -> None:
        try:
            await call_next()
        except MiddlewareTermination as exc:
            metadata = getattr(context, "metadata", None)
            decision = (
                metadata.get("governance_decision")
                if isinstance(metadata, dict)
                else None
            )
            rule = getattr(decision, "matched_rule", None)
            reason = getattr(decision, "reason", None) or str(exc)
            raise GovernanceDenied(rule, reason) from exc


class _BoundedAuditLog:
    def __init__(self, max_entries: int):
        self._max_entries = max_entries
        self._entry_count = 0
        self._segment = 1
        self._log = AuditLog()
        self._lock = threading.Lock()

    def log(self, *args: Any, **kwargs: Any) -> Any:
        with self._lock:
            if self._entry_count >= self._max_entries:
                previous_root = self._log.export()["merkle_root"]
                self._segment += 1
                self._log = AuditLog()
                self._entry_count = 0
                self._log.log(
                    event_type="audit_chain_rotated",
                    agent_did="governance-runtime",
                    action="rotate",
                    data={
                        "previous_merkle_root": previous_root,
                        "segment": self._segment,
                    },
                    outcome="success",
                )
                self._entry_count += 1

            sanitized_kwargs = dict(kwargs)
            data = sanitized_kwargs.get("data")
            if isinstance(data, dict):
                sanitized_kwargs["data"] = _sanitize_audit_data(data)
            entry = self._log.log(*args, **sanitized_kwargs)
            self._entry_count += 1
            return entry

    def verify_integrity(self) -> tuple[bool, str | None]:
        with self._lock:
            return self._log.verify_integrity()

    def export(self) -> dict[str, Any]:
        with self._lock:
            return self._log.export()


class GovernanceRuntime:
    """Own the official AGT evaluator, MAF middleware, and hash-chained audit log."""

    def __init__(self, settings: Settings):
        self.settings = settings
        self.evaluator = PolicyEvaluator()
        self.audit_log = _BoundedAuditLog(settings.governance_audit_max_entries)
        self._audit_file_lock = threading.Lock()
        self._trace_budget_lock = threading.Lock()
        self._trace_budgets: dict[str, tuple[int, float]] = {}
        self._trace_budget_ttl_seconds = max(
            300.0,
            settings.request_timeout_seconds * 4,
        )

        if settings.governance_enabled:
            if not settings.governance_policy_dir.is_dir():
                raise RuntimeError(
                    f"Governance policy directory does not exist: {settings.governance_policy_dir}"
                )
            self.evaluator.load_policies(settings.governance_policy_dir)
            if not self.evaluator.policies:
                raise RuntimeError(
                    f"Governance is enabled but no YAML policies were found in "
                    f"{settings.governance_policy_dir}"
                )

    @property
    def max_tokens(self) -> int | None:
        return self._minimum_policy_default("max_tokens")

    @property
    def max_tool_calls(self) -> int | None:
        return self._minimum_policy_default("max_tool_calls")

    @property
    def middleware(self) -> list[Any]:
        if not self.settings.governance_enabled:
            return []
        return [
            _GovernanceTerminationMiddleware(),
            AuditTrailMiddleware(
                audit_log=self.audit_log,
                agent_did=self.settings.agent_id,
            ),
            GovernancePolicyMiddleware(
                evaluator=self.evaluator,
                audit_log=None,
            ),
            CapabilityGuardMiddleware(
                allowed_tools=sorted(MODEL_TOOL_NAMES),
                denied_tools=[],
                audit_log=None,
            ),
        ]

    def authorize_tool(
        self,
        *,
        name: str,
        arguments: dict[str, Any],
        trace_id: str,
        caller_agent_id: str,
    ) -> None:
        if name not in ORCHESTRATOR_TOOL_NAMES:
            self._record_decision(
                name=name,
                arguments=arguments,
                trace_id=trace_id,
                caller_agent_id=caller_agent_id,
                allowed=False,
                rule="orchestrator-tool-allowlist",
                reason="Tool is not part of the Strategic Engagements capability contract.",
            )
            raise GovernanceDenied(
                "orchestrator-tool-allowlist",
                f"Tool {name!r} is not allowed.",
            )

        if not self.settings.governance_enabled:
            return

        decision = self.evaluator.evaluate(
            {
                "tool_name": name,
                "message": json.dumps(arguments, sort_keys=True, default=str),
                "agent_id": caller_agent_id,
                "trace_id": trace_id,
            }
        )
        if not decision.allowed:
            self._record_decision(
                name=name,
                arguments=arguments,
                trace_id=trace_id,
                caller_agent_id=caller_agent_id,
                allowed=False,
                rule=decision.matched_rule,
                reason=decision.reason,
            )
            raise GovernanceDenied(decision.matched_rule, decision.reason)
        budget_denial = self._reserve_tool_call(trace_id)
        if budget_denial is not None:
            rule, reason = budget_denial
            self._record_decision(
                name=name,
                arguments=arguments,
                trace_id=trace_id,
                caller_agent_id=caller_agent_id,
                allowed=False,
                rule=rule,
                reason=reason,
            )
            raise GovernanceDenied(rule, reason)
        self._record_decision(
            name=name,
            arguments=arguments,
            trace_id=trace_id,
            caller_agent_id=caller_agent_id,
            allowed=True,
            rule=decision.matched_rule,
            reason=decision.reason,
        )

    def record_tool_result(
        self,
        *,
        name: str,
        arguments: dict[str, Any],
        trace_id: str,
        caller_agent_id: str,
        succeeded: bool,
        error: str | None = None,
    ) -> None:
        outcome = "success" if succeeded else "error"
        audit_arguments = _audit_arguments(arguments)
        self.audit_log.log(
            event_type="tool_completed" if succeeded else "tool_failed",
            agent_did=caller_agent_id,
            action=name,
            resource=name,
            data={
                **audit_arguments,
                "trace_id": trace_id,
                **({"error_sha256": _sha256(error)} if error else {}),
            },
            outcome=outcome,
        )
        self._append_durable(
            {
                "event_type": "tool_completed" if succeeded else "tool_failed",
                "agent_id": caller_agent_id,
                "tool_name": name,
                **audit_arguments,
                "trace_id": trace_id,
                "outcome": outcome,
                "error_sha256": _sha256(error) if error else None,
            }
        )

    def verify_audit(self) -> bool:
        ok, _ = self.audit_log.verify_integrity()
        return bool(ok)

    def _record_decision(
        self,
        *,
        name: str,
        arguments: dict[str, Any],
        trace_id: str,
        caller_agent_id: str,
        allowed: bool,
        rule: str | None,
        reason: str,
    ) -> None:
        event_type = "policy_evaluation" if allowed else "tool_blocked"
        outcome = "success" if allowed else "denied"
        audit_arguments = _audit_arguments(arguments)
        data = {
            **audit_arguments,
            "trace_id": trace_id,
            "matched_rule": rule,
            "reason": reason,
        }
        self.audit_log.log(
            event_type=event_type,
            agent_did=caller_agent_id,
            action="allow" if allowed else "deny",
            resource=name,
            data=data,
            outcome=outcome,
        )
        self._append_durable(
            {
                "event_type": event_type,
                "agent_id": caller_agent_id,
                "tool_name": name,
                **audit_arguments,
                "trace_id": trace_id,
                "allowed": allowed,
                "matched_rule": rule,
                "reason": reason,
            }
        )

    def _append_durable(self, entry: dict[str, Any]) -> None:
        path = self.settings.governance_audit_path
        if path is None:
            return
        path.parent.mkdir(parents=True, exist_ok=True)
        with self._audit_file_lock:
            with Path(path).open("a", encoding="utf-8") as stream:
                stream.write(json.dumps(entry, sort_keys=True, default=str) + "\n")

    def _minimum_policy_default(self, name: str) -> int | None:
        if not self.settings.governance_enabled:
            return None
        values = [
            value
            for policy in self.evaluator.policies
            if isinstance((value := getattr(policy.defaults, name, None)), int)
            and value > 0
        ]
        return min(values) if values else None

    def _reserve_tool_call(self, trace_id: str) -> tuple[str, str] | None:
        limit = self.max_tool_calls
        if limit is None:
            return None
        if not trace_id:
            return (
                "trace-id-required",
                "A trace id is required to enforce the tool-call budget.",
            )

        now = time.monotonic()
        with self._trace_budget_lock:
            state = self._trace_budgets.get(trace_id)
            if state is None and len(self._trace_budgets) >= _MAX_TRACKED_TRACES:
                cutoff = now - self._trace_budget_ttl_seconds
                self._trace_budgets = {
                    key: value
                    for key, value in self._trace_budgets.items()
                    if value[1] >= cutoff
                }
                if len(self._trace_budgets) >= _MAX_TRACKED_TRACES:
                    return (
                        "trace-budget-capacity",
                        "Governance trace-budget capacity is exhausted; retry later.",
                    )

            count = state[0] if state is not None else 0
            if count >= limit:
                self._trace_budgets[trace_id] = (count, now)
                return (
                    "max-tool-calls",
                    f"Policy tool-call limit of {limit} was exhausted for this trace.",
                )
            self._trace_budgets[trace_id] = (count + 1, now)
        return None


def _audit_arguments(arguments: dict[str, Any]) -> dict[str, Any]:
    canonical = json.dumps(
        arguments,
        sort_keys=True,
        separators=(",", ":"),
        default=str,
    )
    return {
        "argument_keys": sorted(arguments),
        "arguments_sha256": _sha256(canonical),
    }


def _sha256(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def _sanitize_audit_data(data: dict[str, Any]) -> dict[str, Any]:
    sensitive_fields = {
        "arguments",
        "error",
        "message_preview",
        "result_preview",
    }
    sanitized: dict[str, Any] = {}
    for key, value in data.items():
        if key in sensitive_fields:
            serialized = json.dumps(
                value,
                sort_keys=True,
                separators=(",", ":"),
                default=str,
            )
            sanitized[f"{key}_sha256"] = _sha256(serialized)
        else:
            sanitized[key] = value
    return sanitized
