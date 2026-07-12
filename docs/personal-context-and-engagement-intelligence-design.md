# Personal Context, M365 Integration, and Engagement Intelligence Design

## Status
Proposed for future implementation.

## Purpose
This document describes a future design for adding a private personal-context layer, Microsoft 365 integration, and a controlled projection pipeline into shared engagement intelligence. The goal is to improve relevance and timeliness of engagement insights while preserving clear privacy boundaries, user control, and tenant-safe defaults.

## Problem Statement
The current engagement intelligence direction focuses on shared, organization-relevant signals and capability mapping. A future implementation needs to also support:

- private user context that should not be directly exposed to shared systems,
- Microsoft 365 data that may improve personalization and engagement awareness,
- selective projection of high-value facts into shared engagement intelligence,
- governance controls for consent, retention, visibility, and auditability.

Without a dedicated design, future implementation risks over-collecting personal data, blurring private/shared boundaries, and making authorization and consent difficult to reason about.

## Goals
- Introduce a private personal-context domain owned by the individual user.
- Define safe boundaries for Microsoft 365 data ingestion and normalization.
- Project only explicitly allowed, minimum-necessary signals into shared engagement intelligence.
- Preserve explainability, consent, and auditability for every projected signal.
- Provide an incremental roadmap that can be implemented without blocking current MVP work.

## Non-Goals
- Implementing live Microsoft Graph synchronization in the current branch.
- Defining production-ready security infrastructure in full detail.
- Replacing existing shared engagement intelligence data models.
- Designing every downstream UX surface.

## Design Principles
1. **Private by default**: raw personal-context data remains in a user-scoped private store.
2. **Projection over sharing**: shared systems receive derived signals, not unrestricted source data.
3. **Minimum necessary data**: only the smallest useful fact should cross the private/shared boundary.
4. **User awareness and control**: users can understand, enable, disable, and review projected data.
5. **Policy-enforced architecture**: projection is governed by explicit rules, not ad hoc application code.
6. **Incremental adoption**: the architecture should work in phases, starting with manual or batch workflows.

## Scope Overview
The future design introduces four conceptual layers:

1. **Private Personal Context Layer**
   - Stores user-specific context and source-derived signals.
   - Visible only to the individual user and tightly scoped system services.
2. **M365 Connector Layer**
   - Pulls approved Microsoft 365 source data through bounded connectors.
   - Normalizes source records into internal private-context events or facts.
3. **Projection and Policy Layer**
   - Evaluates what derived signals may be promoted from private context into shared intelligence.
   - Applies consent, policy, confidence, and minimization rules.
4. **Shared Engagement Intelligence Layer**
   - Stores engagement-relevant, organization-safe signals for team and workflow use.
   - Never depends on unrestricted access to raw private source records.

## High-Level Architecture

```text
Microsoft 365 Sources
  └─> Connector Adapters
        └─> Private Normalization Pipeline
              └─> Private Personal Context Store
                    └─> Projection Policy Engine
                          └─> Shared Engagement Intelligence Store
                                └─> Search / Recommendations / Workflows / Reporting
```

## Private Personal Context Layer

### Responsibilities
- Store raw or near-raw user-specific context from approved sources.
- Build user-level derived facts such as inferred priorities, recent topics, relationship hints, schedule pressure, or follow-up risk.
- Maintain provenance linking every fact to source system, event time, ingestion time, and transformation path.
- Enforce strict access controls so this layer is not queryable as a shared organizational dataset.

### Example Private Data Categories
Potential future categories include:
- calendar-derived working context,
- meeting participation and cadence metadata,
- email interaction metadata,
- task/reminder metadata,
- user-authored notes or preferences,
- inferred focus areas or engagement priorities,
- relationship strength or recency estimates.

### Storage Expectations
The private layer should support:
- user-scoped partitioning,
- encrypted storage,
- retention windows by data type,
- provenance and audit metadata,
- soft deletion and revocation handling,
- recomputation of derived facts when policy changes.

### Recommended Modeling Approach
Model this layer as a combination of:
- **source events**: normalized records from connectors,
- **derived facts**: higher-level interpretations with confidence scores,
- **user preferences and consent records**: explicit configuration and opt-in state,
- **projection decisions**: records of what was or was not shared and why.

## Microsoft 365 Integration Boundaries

### Candidate M365 Sources
Future connector scope may include:
- Outlook calendar,
- Outlook mail metadata,
- Microsoft To Do / Planner task metadata,
- contacts or directory-enriched relationship context,
- Teams meeting or participation metadata.

### Boundary Rules
To keep the design safe and implementable, the connectors should follow these rules:
- ingest only approved scopes and entities,
- prefer metadata over full content where possible,
- avoid storing message bodies or attachments unless a later policy explicitly allows it,
- normalize external records into stable internal schemas before any downstream use,
- preserve source identifiers and timestamps for auditability,
- support selective disablement per source type.

### Connector Contract
Each connector should produce normalized private events with:
- source type,
- source object id,
- tenant id,
- user id,
- timestamps,
- classification tags,
- sensitivity label if available,
- extraction confidence,
- raw-to-normalized provenance.

### Sync Modes
The architecture should support phased sync patterns:
- **manual import** for early experiments,
- **scheduled batch sync** for low-risk rollout,
- **event-driven incremental sync** once governance and operational maturity are proven.

## Projection into Shared Engagement Intelligence

### Why Projection Is Needed
Many user-relevant signals are useful for engagement workflows, but raw private data should not be broadly visible. Projection creates a safety boundary by turning personal context into derived, bounded, policy-approved shared facts.

### Projection Model
A projection should be:
- derived from one or more private facts,
- minimal and engagement-relevant,
- tagged with confidence and freshness,
- classified for allowed audience and usage,
- revocable if source consent changes or the underlying fact expires.

### Examples of Projected Shared Signals
Allowed future projections may include:
- an engagement requires follow-up soon,
- a contact relationship appears recently active,
- a topic or account has increased user attention,
- a meeting cluster indicates active pre-sales or delivery coordination,
- a user is likely the best current point of contact for a capability or account.

These are intentionally framed as derived business signals, not exposure of full calendar/email/task details.

### Projection Rules
A signal may cross into shared intelligence only if all conditions hold:
1. the source type is enabled by policy,
2. the user has granted required consent,
3. the derived signal matches an allowed projection template,
4. the resulting shared fact contains no disallowed raw content,
5. retention and audience rules are attached,
6. the signal meets minimum confidence and freshness thresholds.

### Shared Record Shape
Projected records in shared intelligence should include:
- projection id,
- signal type,
- subject entity or engagement id,
- projected summary value,
- confidence score,
- freshness window / expiration,
- allowed audience classification,
- provenance reference to a private projection-decision record,
- revocation status.

Shared systems should not need direct access to the private source record to consume the projection.

## Policy, Privacy, and Governance

### Consent Model
Consent should be explicit, source-aware, and revocable. At minimum:
- users opt in to each connector category,
- users can view which projection categories are enabled,
- revocation stops future projection and triggers cleanup or expiry workflows,
- administrative policy can further narrow what is allowed.

### Data Classification
Each data element should be classified at ingestion and at projection time:
- private raw,
- private derived,
- shared derived,
- restricted / disallowed.

This classification should be machine-readable and enforced by services, not documented informally only.

### Retention and Deletion
- Raw private source data should have the shortest viable retention.
- Derived private facts should expire or be recomputed on a defined schedule.
- Shared projections should carry explicit expiration and revocation rules.
- Deletion requests or consent changes should propagate through dependent derived artifacts.

### Auditability
The system should record:
- what source data was ingested,
- what derivations were computed,
- what projections were allowed or denied,
- what policy/consent state applied at decision time,
- when revocation or expiry removed a shared signal.

## Security and Access Control
- Private personal-context stores must be user-scoped and service-mediated.
- Shared engagement intelligence stores must never expose raw personal records.
- Projection services should run with narrowly scoped permissions.
- Administrative access should be audited and exceptional.
- Service-to-service contracts should avoid broad read access across layers.

## Suggested Domain Components

### 1. Personal Context Service
Owns private facts, provenance, consent state, and user-facing controls.

### 2. M365 Connector Service
Handles Microsoft Graph integration, source sync scheduling, normalization, and connector health.

### 3. Projection Policy Engine
Evaluates whether private facts can become shared engagement signals.

### 4. Shared Engagement Intelligence Service
Consumes approved projections and exposes them for search, ranking, workflows, and reporting.

### 5. Governance and Audit Service
Captures audit events, retention workflows, policy versions, and revocation processing.

## Data Flow Walkthrough
1. A connector imports approved M365 metadata for a user.
2. The normalization pipeline converts source records into private events.
3. The personal context service derives higher-level private facts.
4. The projection engine evaluates allowed projection templates against facts, consent, and policy.
5. Approved projections are written into shared engagement intelligence with expiration and provenance.
6. Shared workflows consume only the projected records.
7. If consent changes or facts expire, the projection is revoked or allowed to age out.

## Implementation Roadmap

### Phase 0 - Documentation and Model Alignment
- finalize the private/shared terminology,
- define initial projection templates,
- define source classification and consent vocabulary,
- align shared engagement intelligence schema extension points.

### Phase 1 - Private Context Foundation
- introduce personal-context schemas and storage boundaries,
- add provenance, consent, and retention metadata models,
- support manual or mocked ingestion for end-to-end experiments,
- implement a basic projection-decision log.

### Phase 2 - Initial M365 Connectors
- add low-risk connectors using metadata-first ingestion,
- start with calendar and task signals before richer mail scenarios,
- implement scheduled sync and normalization pipelines,
- validate tenant scoping and operational observability.

### Phase 3 - Projection Engine and Shared Signal Publishing
- implement policy-based projection templates,
- publish a first set of engagement-safe shared signals,
- add expiration, revocation, and confidence handling,
- expose provenance summaries for explainability.

### Phase 4 - Product Integration
- surface projected signals in engagement workflows,
- allow users to review and manage consent and projections,
- tune ranking and recommendation models using shared derived signals,
- add reporting on projection usage, freshness, and revocation.

### Phase 5 - Hardening and Governance Expansion
- formalize policy management and exceptions,
- add more granular admin and audit workflows,
- refine retention automation,
- expand supported M365 sources if justified by value and risk review.

## Open Design Questions
- Which M365 source should be first for best value-to-risk ratio?
- What projection templates are safe enough for early rollout?
- Should shared projections be entity-centric, engagement-centric, or both?
- What user experience best explains why a projected signal exists?
- How should revocation behave for historical analytics derived from shared projections?
- What minimum provenance details are needed for explainability without exposing raw private context?

## Recommended Next Steps
1. Confirm the preferred document location and documentation convention for future design specs.
2. Review this design alongside `engagement-intelligence/ARCHITECTURE.md` to align terminology.
3. Define 3-5 concrete projection templates for a first implementation slice.
4. Identify the minimum Microsoft Graph scopes required for a metadata-first pilot.
5. Add a follow-up design for consent UX and operational policy management.

## Summary
This design adds a clear architectural boundary between private personal context and shared engagement intelligence. Microsoft 365 data is treated as a bounded private input, and only policy-approved, minimal derived signals are projected into shared systems. This enables future personalization and engagement awareness without collapsing privacy, governance, and shared-data boundaries into a single model.
