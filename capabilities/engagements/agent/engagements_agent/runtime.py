"""Microsoft Agent Framework execution over governed Strategic Engagements tools."""

from __future__ import annotations

import asyncio
from typing import Annotated, Any, Literal

from agent_framework import (
    Agent,
    FunctionInvocationConfiguration,
    MiddlewareTermination,
    tool,
)
from agent_framework.openai import OpenAIChatCompletionClient
from azure.identity.aio import DefaultAzureCredential
from openai import AsyncAzureOpenAI
from pydantic import Field

from .config import DEFAULT_AZURE_OPENAI_API_VERSION, Settings
from .governance import GovernanceDenied, GovernanceRuntime
from .mcp_client import GovernedMcpClient
from .models import (
    AgentDecision,
    AgentRunRequest,
    AgentRunResponse,
    CapturedCall,
    ToolInvocation,
)


class ModelNotConfigured(RuntimeError):
    pass


class AgentRunTimeout(RuntimeError):
    pass


class AgentRuntime:
    def __init__(
        self,
        settings: Settings,
        governance: GovernanceRuntime,
        mcp_client: GovernedMcpClient,
    ):
        self.settings = settings
        self.governance = governance
        self.mcp_client = mcp_client
        self._credential: DefaultAzureCredential | None = None

    async def close(self) -> None:
        if self._credential is not None:
            await self._credential.close()

    async def run(self, request: AgentRunRequest) -> AgentRunResponse:
        captured: list[CapturedCall] = []
        denials: list[GovernanceDenied] = []
        client: OpenAIChatCompletionClient | None = None
        run_timeout = asyncio.timeout(self.settings.request_timeout_seconds)
        try:
            try:
                async with run_timeout:
                    client = await self._create_model_client(request.max_iterations)
                    tools = self._build_tools(request, captured, denials)
                    max_tokens = self.governance.max_tokens
                    async with Agent(
                        client=client,
                        name=self.settings.agent_id,
                        instructions=request.system,
                        tools=tools,
                        middleware=self.governance.middleware,
                        default_options=(
                            {"max_tokens": max_tokens}
                            if max_tokens is not None
                            else None
                        ),
                    ) as agent:
                        response = await agent.run(
                            request.user,
                            options={"response_format": AgentDecision},
                        )
            except TimeoutError as exc:
                if not run_timeout.expired():
                    raise
                raise AgentRunTimeout(
                    "Agent run exceeded "
                    f"{self.settings.request_timeout_seconds:g} seconds."
                ) from exc
        finally:
            if client is not None:
                await client.client.close()

        if denials:
            raise denials[0]

        decision = response.value
        if not isinstance(decision, AgentDecision):
            raise RuntimeError("Agent Framework returned no structured planning decision.")
        return AgentRunResponse(
            output=decision.answer,
            decision=decision,
            iterations=max(1, len(captured) + 1),
            tool_calls=[
                ToolInvocation(name=item.name, args=item.args) for item in captured
            ],
            captured=captured,
        )

    async def _create_model_client(
        self,
        max_iterations: int,
    ) -> OpenAIChatCompletionClient:
        if not self.settings.model_configured:
            raise ModelNotConfigured(
                "AZURE_OPENAI_ENDPOINT and AZURE_OPENAI_DEPLOYMENT are required."
            )
        max_function_calls = self._tool_call_limit(max_iterations)
        invocation_configuration: FunctionInvocationConfiguration = {
            "max_iterations": max_iterations,
            "max_function_calls": max_function_calls,
        }
        api_version = (
            self.settings.model_api_version
            or DEFAULT_AZURE_OPENAI_API_VERSION
        )
        if self.settings.model_api_key:
            return OpenAIChatCompletionClient(
                model=self.settings.model_deployment,
                azure_endpoint=self.settings.model_endpoint,
                api_version=api_version,
                api_key=self.settings.model_api_key,
                function_invocation_configuration=invocation_configuration,
            )

        if self._credential is None:
            self._credential = DefaultAzureCredential()
        token = await self._credential.get_token(self.settings.model_token_scope)
        if not token.token:
            raise RuntimeError("DefaultAzureCredential returned an empty Azure OpenAI token.")
        azure_client = AsyncAzureOpenAI(
            azure_endpoint=self.settings.model_endpoint,
            azure_deployment=self.settings.model_deployment,
            api_version=api_version,
            azure_ad_token=token.token,
        )
        return OpenAIChatCompletionClient(
            model=self.settings.model_deployment,
            async_client=azure_client,
            function_invocation_configuration=invocation_configuration,
        )

    def _build_tools(
        self,
        request: AgentRunRequest,
        captured: list[CapturedCall],
        denials: list[GovernanceDenied] | None = None,
    ) -> list[Any]:
        invocation_lock = asyncio.Lock()
        started_calls = 0
        run_denials = denials if denials is not None else []
        max_tool_calls = self._tool_call_limit(request.max_iterations)
        discovery_url = request.discovery_mcp_url or self.settings.discovery_mcp_url

        async def invoke(
            name: str,
            arguments: dict[str, Any],
            mcp_url: str | None = None,
        ) -> Any:
            nonlocal started_calls
            async with invocation_lock:
                if run_denials:
                    raise MiddlewareTermination(str(run_denials[0]))
                if started_calls >= max_tool_calls:
                    raise RuntimeError(
                        f"Agent tool-call budget of {max_tool_calls} was exhausted."
                    )
                started_calls += 1
                try:
                    result = await self.mcp_client.call_tool(
                        mcp_url=mcp_url or request.mcp_url,
                        name=name,
                        arguments={
                            key: value
                            for key, value in arguments.items()
                            if value is not None
                        },
                        trace_id=request.trace_id or "",
                        caller_agent_id=self.settings.agent_id,
                    )
                except GovernanceDenied as exc:
                    run_denials.append(exc)
                    raise MiddlewareTermination(str(exc)) from exc
                captured.append(result)
                return result.model_result

        @tool(approval_mode="never_require")
        async def search_contacts(
            query: Annotated[
                str | None,
                Field(description="Free text over contact name, organization, or SME area."),
            ] = None,
            topicIds: Annotated[
                list[str] | None,
                Field(description="Optional Strategic Engagements topic identifiers."),
            ] = None,
            status: Annotated[
                Literal["active", "prospect"] | None,
                Field(description="Optional relationship status."),
            ] = None,
        ) -> Any:
            """Search contacts after the capability applies its server-side security trim."""
            return await invoke(
                "search_contacts",
                {"query": query, "topicIds": topicIds, "status": status},
            )

        @tool(approval_mode="never_require")
        async def search_events(
            query: Annotated[
                str | None,
                Field(description="Event id or free text over event name, city, or state."),
            ] = None,
            topicIds: Annotated[
                list[str] | None,
                Field(description="Optional Strategic Engagements topic identifiers."),
            ] = None,
        ) -> Any:
            """Find authorized conferences and functions that can anchor a trip."""
            return await invoke(
                "search_events",
                {"query": query, "topicIds": topicIds},
            )

        @tool(approval_mode="never_require")
        async def survey_area(
            regionId: Annotated[
                str | None,
                Field(description="Known region identifier."),
            ] = None,
            region: Annotated[
                str | None,
                Field(description="Region name or alias."),
            ] = None,
            city: Annotated[str | None, Field(description="Anchor city.")] = None,
            state: Annotated[
                str | None,
                Field(description="State used to disambiguate the city."),
            ] = None,
            radiusMi: Annotated[
                float | None,
                Field(description="Optional area radius in miles."),
            ] = None,
        ) -> Any:
            """Survey authorized topics, relationships, and events in an area."""
            return await invoke(
                "survey_area",
                {
                    "regionId": regionId,
                    "region": region,
                    "city": city,
                    "state": state,
                    "radiusMi": radiusMi,
                },
            )

        @tool(approval_mode="never_require")
        async def suggest_leaders(
            window: Annotated[
                dict[str, str],
                Field(description="ISO start/end planning window."),
            ],
            regionId: Annotated[
                str | None,
                Field(description="Known region identifier."),
            ] = None,
            region: Annotated[
                str | None,
                Field(description="Region name or alias."),
            ] = None,
            city: Annotated[str | None, Field(description="Anchor city.")] = None,
            state: Annotated[
                str | None,
                Field(description="State used to disambiguate the city."),
            ] = None,
            radiusMi: Annotated[
                float | None,
                Field(description="Optional area radius in miles."),
            ] = None,
            topicIds: Annotated[
                list[str] | None,
                Field(description="Optional topic focus."),
            ] = None,
        ) -> Any:
            """Rank senior leaders for an area and planning window."""
            return await invoke(
                "suggest_leaders",
                {
                    "regionId": regionId,
                    "region": region,
                    "city": city,
                    "state": state,
                    "radiusMi": radiusMi,
                    "window": window,
                    "topicIds": topicIds,
                },
            )

        @tool(approval_mode="never_require")
        async def nearby_leaders(
            leaderId: Annotated[
                str | None,
                Field(description="Leader being planned for."),
            ] = None,
            eventId: Annotated[
                str | None,
                Field(description="Anchor event identifier."),
            ] = None,
            eventQuery: Annotated[
                str | None,
                Field(description="Free-text event anchor."),
            ] = None,
            regionId: Annotated[
                str | None,
                Field(description="Known region identifier."),
            ] = None,
            region: Annotated[
                str | None,
                Field(description="Region name or alias."),
            ] = None,
            city: Annotated[str | None, Field(description="Anchor city.")] = None,
            state: Annotated[
                str | None,
                Field(description="State used to disambiguate the city."),
            ] = None,
            radiusMi: Annotated[
                float | None,
                Field(description="Optional area radius in miles."),
            ] = None,
            window: Annotated[
                dict[str, str] | None,
                Field(description="ISO start/end planning window."),
            ] = None,
            stopContactIds: Annotated[
                list[str] | None,
                Field(description="Contacts already included in the itinerary."),
            ] = None,
            nearbyRadiusMi: Annotated[
                float | None,
                Field(description="Leader proximity threshold in miles."),
            ] = None,
        ) -> Any:
            """Find other senior leaders at the same event, contacts, or area."""
            return await invoke(
                "nearby_leaders",
                {
                    "leaderId": leaderId,
                    "eventId": eventId,
                    "eventQuery": eventQuery,
                    "regionId": regionId,
                    "region": region,
                    "city": city,
                    "state": state,
                    "radiusMi": radiusMi,
                    "window": window,
                    "stopContactIds": stopContactIds,
                    "nearbyRadiusMi": nearbyRadiusMi,
                },
            )

        @tool(approval_mode="never_require")
        async def plan_options(
            window: Annotated[
                dict[str, str],
                Field(description="ISO start/end planning window."),
            ],
            regionId: Annotated[
                str | None,
                Field(description="Known region identifier."),
            ] = None,
            region: Annotated[
                str | None,
                Field(description="Region name or alias."),
            ] = None,
            city: Annotated[str | None, Field(description="Anchor city.")] = None,
            state: Annotated[
                str | None,
                Field(description="State used to disambiguate the city."),
            ] = None,
            radiusMi: Annotated[
                float | None,
                Field(description="Optional area radius in miles."),
            ] = None,
            leaderId: Annotated[
                str | None,
                Field(description="Explicitly selected leader identifier."),
            ] = None,
            topicIds: Annotated[
                list[str] | None,
                Field(description="Optional topic focus."),
            ] = None,
            requireTopicMatch: Annotated[
                bool | None,
                Field(description="Whether stops must match a requested topic."),
            ] = None,
        ) -> Any:
            """Build ranked leader, duration, category, and extension options for an area."""
            return await invoke(
                "plan_options",
                {
                    "regionId": regionId,
                    "region": region,
                    "city": city,
                    "state": state,
                    "radiusMi": radiusMi,
                    "window": window,
                    "leaderId": leaderId,
                    "topicIds": topicIds,
                    "requireTopicMatch": requireTopicMatch,
                },
            )

        @tool(approval_mode="never_require")
        async def suggest_candidates(
            leaderId: Annotated[str, Field(description="Leader identifier.")],
            eventId: Annotated[str | None, Field(description="Anchor event identifier.")] = None,
            eventQuery: Annotated[
                str | None,
                Field(description="Free-text event anchor when an event id is unknown."),
            ] = None,
            topicIds: Annotated[
                list[str] | None,
                Field(description="Optional topic focus."),
            ] = None,
            requireTopicMatch: Annotated[
                bool | None,
                Field(description="Whether candidates must match a requested topic."),
            ] = None,
        ) -> Any:
            """Rank authorized contacts around an event for the selected leader."""
            return await invoke(
                "suggest_candidates",
                {
                    "leaderId": leaderId,
                    "eventId": eventId,
                    "eventQuery": eventQuery,
                    "topicIds": topicIds,
                    "requireTopicMatch": requireTopicMatch,
                },
            )

        @tool(approval_mode="never_require")
        async def plan_radius(
            days: Annotated[int, Field(description="Fixed trip length in days.")],
            anchorContactId: Annotated[
                str | None,
                Field(description="Required company/contact anchor identifier."),
            ] = None,
            company: Annotated[str | None, Field(description="Company anchor name.")] = None,
            lat: Annotated[float | None, Field(description="Anchor latitude.")] = None,
            lng: Annotated[float | None, Field(description="Anchor longitude.")] = None,
            city: Annotated[str | None, Field(description="Anchor city.")] = None,
            state: Annotated[str | None, Field(description="Anchor state.")] = None,
            region: Annotated[str | None, Field(description="Region name or alias.")] = None,
            regionId: Annotated[str | None, Field(description="Known region identifier.")] = None,
            radiusMi: Annotated[float | None, Field(description="Search radius in miles.")] = None,
            meetingsPerDay: Annotated[
                int | None,
                Field(description="Meeting capacity per day."),
            ] = None,
            window: Annotated[
                dict[str, str] | None,
                Field(description="ISO start/end planning window."),
            ] = None,
            leaderId: Annotated[str | None, Field(description="Optional leader identifier.")] = None,
            topicIds: Annotated[list[str] | None, Field(description="Optional topic focus.")] = None,
            requireTopicMatch: Annotated[
                bool | None,
                Field(description="Whether stops must match a requested topic."),
            ] = None,
        ) -> Any:
            """Fill a fixed-duration trip around a company, coordinate, city, or region."""
            return await invoke(
                "plan_radius",
                {
                    "days": days,
                    "anchorContactId": anchorContactId,
                    "company": company,
                    "lat": lat,
                    "lng": lng,
                    "city": city,
                    "state": state,
                    "region": region,
                    "regionId": regionId,
                    "radiusMi": radiusMi,
                    "meetingsPerDay": meetingsPerDay,
                    "window": window,
                    "leaderId": leaderId,
                    "topicIds": topicIds,
                    "requireTopicMatch": requireTopicMatch,
                },
            )

        @tool(approval_mode="never_require")
        async def build_itinerary(
            leaderId: Annotated[str, Field(description="Leader identifier.")],
            eventId: Annotated[str | None, Field(description="Anchor event identifier.")] = None,
            eventQuery: Annotated[str | None, Field(description="Free-text event anchor.")] = None,
            anchorContactId: Annotated[
                str | None,
                Field(description="Required company/contact anchor identifier."),
            ] = None,
            company: Annotated[str | None, Field(description="Company anchor name.")] = None,
            lat: Annotated[float | None, Field(description="Anchor latitude.")] = None,
            lng: Annotated[float | None, Field(description="Anchor longitude.")] = None,
            city: Annotated[str | None, Field(description="Anchor city.")] = None,
            state: Annotated[str | None, Field(description="Anchor state.")] = None,
            region: Annotated[str | None, Field(description="Region name or alias.")] = None,
            regionId: Annotated[str | None, Field(description="Known region identifier.")] = None,
            radiusMi: Annotated[float | None, Field(description="Search radius in miles.")] = None,
            days: Annotated[int | None, Field(description="Fixed trip length in days.")] = None,
            meetingsPerDay: Annotated[
                int | None,
                Field(description="Meeting capacity per day."),
            ] = None,
            window: Annotated[
                dict[str, str] | None,
                Field(description="ISO start/end planning window."),
            ] = None,
            acceptedContactIds: Annotated[
                list[str] | None,
                Field(description="Authorized contacts accepted into the route."),
            ] = None,
            additionalContactIds: Annotated[
                list[str] | None,
                Field(description="Authorized regional-swing stops beyond the event pool."),
            ] = None,
            topicIds: Annotated[list[str] | None, Field(description="Optional topic focus.")] = None,
            requireTopicMatch: Annotated[
                bool | None,
                Field(description="Whether stops must match a requested topic."),
            ] = None,
        ) -> Any:
            """Build the route, ROI, conflicts, and trip-map payload."""
            return await invoke(
                "build_itinerary",
                {
                    "leaderId": leaderId,
                    "eventId": eventId,
                    "eventQuery": eventQuery,
                    "anchorContactId": anchorContactId,
                    "company": company,
                    "lat": lat,
                    "lng": lng,
                    "city": city,
                    "state": state,
                    "region": region,
                    "regionId": regionId,
                    "radiusMi": radiusMi,
                    "days": days,
                    "meetingsPerDay": meetingsPerDay,
                    "window": window,
                    "acceptedContactIds": acceptedContactIds,
                    "additionalContactIds": additionalContactIds,
                    "topicIds": topicIds,
                    "requireTopicMatch": requireTopicMatch,
                },
            )

        @tool(approval_mode="never_require")
        async def search_businesses(
            city: Annotated[str | None, Field(description="Anchor city for the sweep.")] = None,
            state: Annotated[
                str | None,
                Field(description="State abbreviation disambiguating the city."),
            ] = None,
            lat: Annotated[
                float | None,
                Field(description="Anchor latitude; pair with lng to reuse an itinerary stop."),
            ] = None,
            lng: Annotated[float | None, Field(description="Anchor longitude.")] = None,
            query: Annotated[
                str | None,
                Field(description='Keyword matched against business NAMES (e.g. "aerospace").'),
            ] = None,
            focus: Annotated[
                list[
                    Literal[
                        "industry",
                        "manufacturing",
                        "technology",
                        "research",
                        "academia",
                        "government",
                        "venues",
                    ]
                ]
                | None,
                Field(description="Restrict the sweep to engageable organization types."),
            ] = None,
            radiusMi: Annotated[
                float | None,
                Field(description="Search radius in miles (default 10, max 31)."),
            ] = None,
            limit: Annotated[
                int | None,
                Field(description="Maximum businesses to return (default 15, max 50)."),
            ] = None,
        ) -> Any:
            """Find PUBLIC businesses physically around a travel area.

            Served by the separate Area Discovery capability, so results carry no relationship
            history and no security trim. Always cross-reference the returned names against
            search_contacts before presenting any as a new lead.
            """
            return await invoke(
                "search_businesses",
                {
                    "city": city,
                    "state": state,
                    "lat": lat,
                    "lng": lng,
                    "query": query,
                    "focus": focus,
                    "radiusMi": radiusMi,
                    "limit": limit,
                },
                mcp_url=discovery_url,
            )

        return [
            search_contacts,
            search_events,
            survey_area,
            suggest_leaders,
            nearby_leaders,
            plan_options,
            plan_radius,
            suggest_candidates,
            build_itinerary,
            *([search_businesses] if discovery_url else []),
        ]

    def _tool_call_limit(self, requested: int) -> int:
        policy_limit = self.governance.max_tool_calls
        return min(requested, policy_limit) if policy_limit is not None else requested
