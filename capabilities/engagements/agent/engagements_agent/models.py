"""HTTP contracts shared with the TypeScript orchestration gateway."""

from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator


def _to_camel(value: str) -> str:
    head, *tail = value.split("_")
    return head + "".join(part.capitalize() for part in tail)


class ApiModel(BaseModel):
    model_config = ConfigDict(
        alias_generator=_to_camel,
        populate_by_name=True,
        serialize_by_alias=True,
    )


class ToolContextRequest(ApiModel):
    mcp_url: str
    trace_id: str | None = None
    #: Area Discovery capability endpoint. Falls back to the runtime's DISCOVERY_MCP_URL setting.
    discovery_mcp_url: str | None = None


class ToolListRequest(ToolContextRequest):
    pass


class ToolDescriptor(ApiModel):
    name: str
    description: str = ""
    input_schema: dict[str, Any] = Field(default_factory=dict)


class ToolListResponse(ApiModel):
    tools: list[ToolDescriptor]
    #: Which surface the engagements MCP registered: the deterministic planner (RETRIEVAL_BACKEND
    #: memory/search) or a document-corpus RAG only (RETRIEVAL_BACKEND=grounding).
    backend: Literal["planner", "grounding"] = "planner"


class ToolCallRequest(ToolContextRequest):
    name: str
    args: dict[str, Any] = Field(default_factory=dict)


class CapturedCall(ApiModel):
    name: str
    args: dict[str, Any]
    result: Any
    text: str
    model_result: Any


class ToolInvocation(ApiModel):
    name: str
    args: dict[str, Any]


class AgentRunRequest(ToolContextRequest):
    system: str
    user: str
    max_iterations: int = Field(default=8, ge=1, le=20)


class DocumentPlanMeeting(ApiModel):
    target: str = Field(min_length=1, max_length=200)
    organization: str | None = Field(default=None, max_length=200)
    purpose: str = Field(min_length=1, max_length=500)
    location: str | None = Field(default=None, max_length=300)
    time: str | None = Field(default=None, max_length=100)
    source_ids: list[str] = Field(min_length=1)


class DocumentPlanDay(ApiModel):
    day: int = Field(ge=1)
    date: str | None = Field(default=None, max_length=40)
    location: str | None = Field(default=None, max_length=300)
    meetings: list[DocumentPlanMeeting] = Field(min_length=1)
    notes: list[str] = Field(default_factory=list)


class DocumentTripPlan(ApiModel):
    title: str = Field(min_length=1, max_length=300)
    event: str | None = Field(default=None, max_length=300)
    destination: str | None = Field(default=None, max_length=300)
    start_date: str | None = Field(default=None, max_length=40)
    end_date: str | None = Field(default=None, max_length=40)
    summary: str = Field(min_length=1, max_length=2_000)
    days: list[DocumentPlanDay] = Field(min_length=1)
    source_ids: list[str] = Field(min_length=1)
    gaps: list[str] = Field(default_factory=list)


class AgentDecision(ApiModel):
    intent: Literal["area", "event", "radius", "lookup"] = Field(
        description="Framework-selected workflow intent."
    )
    stage: Literal["clarify", "options", "plan", "answer"] = Field(
        description="Grounded response stage for the host UI."
    )
    clarify: Literal["category", "leader"] | None = Field(
        default=None,
        description="Material choice the user must make at the clarify stage.",
    )
    category: Literal[
        "congressional",
        "academia",
        "industry",
        "army-internal",
    ] | None = Field(
        default=None,
        description="Explicitly selected engagement category, if any.",
    )
    leader_id: str | None = Field(
        default=None,
        description="Explicitly selected or tool-grounded leader id, if any.",
    )
    recommended_option_index: int | None = Field(
        default=None,
        ge=0,
        description="Zero-based recommended itinerary index at the options stage.",
    )
    answer: str = Field(
        min_length=1,
        description="Concise grounded response for the executive assistant.",
    )
    document_plan: DocumentTripPlan | None = Field(
        default=None,
        description="Document-grounded itinerary proposed from search_grounding passages.",
    )

    @model_validator(mode="after")
    def validate_stage_fields(self) -> "AgentDecision":
        if self.stage == "clarify" and self.clarify is None:
            raise ValueError("clarify is required at the clarify stage.")
        if self.stage != "clarify" and self.clarify is not None:
            raise ValueError("clarify is only valid at the clarify stage.")
        if self.stage == "options" and self.recommended_option_index is None:
            raise ValueError(
                "recommended_option_index is required at the options stage."
            )
        if self.stage != "options" and self.recommended_option_index is not None:
            raise ValueError(
                "recommended_option_index is only valid at the options stage."
            )
        if self.stage == "answer" and self.intent != "lookup":
            raise ValueError("Only lookup intent can return the answer stage.")
        if self.document_plan is not None and self.stage != "plan":
            raise ValueError("documentPlan is only valid at the plan stage.")
        if self.document_plan is not None and self.intent == "lookup":
            raise ValueError("documentPlan requires a planning intent.")
        return self


class AgentRunResponse(ApiModel):
    output: str | None
    decision: AgentDecision
    iterations: int
    tool_calls: list[ToolInvocation]
    captured: list[CapturedCall]


class HealthResponse(ApiModel):
    ok: bool
    service: str
    framework: str
    governance_enabled: bool
    policy_count: int
    audit_integrity: bool
    model_configured: bool
