"""FastAPI boundary consumed by the TypeScript orchestration gateway."""

from __future__ import annotations

from contextlib import asynccontextmanager
from uuid import uuid4

from fastapi import FastAPI, HTTPException

from .config import Settings
from .governance import GovernanceDenied, GovernanceRuntime, ORCHESTRATOR_TOOL_NAMES
from .mcp_client import GovernedMcpClient, McpCallError
from .models import (
    AgentRunRequest,
    AgentRunResponse,
    HealthResponse,
    ToolCallRequest,
    ToolListRequest,
    ToolListResponse,
)
from .runtime import AgentRuntime, AgentRunTimeout, ModelNotConfigured


def create_app(
    *,
    settings: Settings | None = None,
    governance: GovernanceRuntime | None = None,
    mcp_client: GovernedMcpClient | None = None,
    runtime: AgentRuntime | None = None,
) -> FastAPI:
    configured_settings = settings or Settings.from_env()
    configured_governance = governance or GovernanceRuntime(configured_settings)
    configured_mcp = mcp_client or GovernedMcpClient(
        configured_governance,
        configured_settings.request_timeout_seconds,
    )
    configured_runtime = runtime or AgentRuntime(
        configured_settings,
        configured_governance,
        configured_mcp,
    )

    @asynccontextmanager
    async def lifespan(_: FastAPI):
        yield
        await configured_runtime.close()
        await configured_mcp.close()

    app = FastAPI(
        title="Strategic Engagements Agent Runtime",
        version="0.1.0",
        lifespan=lifespan,
    )

    @app.get("/health", response_model=HealthResponse)
    async def health() -> HealthResponse:
        return HealthResponse(
            ok=True,
            service="engagements-python-agent",
            framework="Microsoft Agent Framework",
            governance_enabled=configured_settings.governance_enabled,
            policy_count=len(configured_governance.evaluator.policies),
            audit_integrity=configured_governance.verify_audit(),
            model_configured=configured_settings.model_configured,
        )

    @app.post("/tools/list", response_model=ToolListResponse)
    async def list_tools(request: ToolListRequest) -> ToolListResponse:
        try:
            tools = await configured_mcp.list_tools(
                mcp_url=request.mcp_url,
                persona=request.persona,
            )
            available = {item.name for item in tools}
            missing = sorted(ORCHESTRATOR_TOOL_NAMES - available)
            if missing:
                raise HTTPException(
                    status_code=502,
                    detail=f"Engagements MCP is missing required tools: {', '.join(missing)}",
                )
            return ToolListResponse(
                tools=[item for item in tools if item.name in ORCHESTRATOR_TOOL_NAMES]
            )
        except McpCallError as exc:
            raise HTTPException(status_code=502, detail=str(exc)) from exc

    @app.post("/tools/call")
    async def call_tool(request: ToolCallRequest):
        try:
            return await configured_mcp.call_tool(
                mcp_url=request.mcp_url,
                persona=request.persona,
                name=request.name,
                arguments=request.args,
                trace_id=request.trace_id or str(uuid4()),
                caller_agent_id="typescript-orchestrator",
            )
        except GovernanceDenied as exc:
            raise HTTPException(status_code=403, detail=str(exc)) from exc
        except McpCallError as exc:
            raise HTTPException(status_code=502, detail=str(exc)) from exc

    @app.post("/run", response_model=AgentRunResponse)
    async def run_agent(request: AgentRunRequest) -> AgentRunResponse:
        if request.trace_id is None:
            request.trace_id = str(uuid4())
        try:
            return await configured_runtime.run(request)
        except GovernanceDenied as exc:
            raise HTTPException(status_code=403, detail=str(exc)) from exc
        except AgentRunTimeout as exc:
            raise HTTPException(status_code=504, detail=str(exc)) from exc
        except ModelNotConfigured as exc:
            raise HTTPException(status_code=503, detail=str(exc)) from exc
        except McpCallError as exc:
            raise HTTPException(status_code=502, detail=str(exc)) from exc

    return app


app = create_app()
