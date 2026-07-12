# Personal Context MCP Server — Per-User Itinerary Personalization Design

## Status
Proposed for future implementation. Owner: TBD. Reviewers: TBD.

## Purpose
This document describes a future design for a **standalone, per-user Personal Context MCP
server** that gives the Strategic Engagements planner visibility into the **requesting user's own**
Microsoft 365 signals — calendar, email metadata, and Outlook/personal notes — so a proposed
**itinerary can be further personalized for that individual user**.

The server is a **separate deployable** from the main engagements solution. It authenticates
**each user with their own Entra ID identity (OBO)** and only ever reads data that user is
**personally authorized** to read. It does **not** publish into, or depend on, the shared
organizational engagement-intelligence store.

## Relationship to the existing repo
This design is the concrete build-out of two things the main architecture already anticipates:

- **`engagement-intelligence/ARCHITECTURE.md` §5.4 "Personal notes (stretch)"** — *"a separate MCP
  client that authenticates with Entra ID, decoupled from Keycloak (no cross-IdP brokering)… the
  notes store must be one the user is personally authorized to read."*
- **`engagement-intelligence/seed/schema.ts` — `Preferences`** — a **runtime** personalization input
  the orchestrator forwards to sub-agents to *rank and filter* candidates, which **"NEVER widens
  access — the security trim (§5.4) is separate and authoritative; preferences only re-order or
  narrow what the trim already allowed."**

The Personal Context server is the **source of a richer, user-scoped equivalent of `Preferences`**:
runtime signals that tune *that user's* menu and pre-briefs, consumed at request time, never written
back to shared intelligence.

## Problem Statement
The shared engagement-intelligence path deliberately returns organization-safe, tenant-trimmed
recall (who-to-meet, staleness, ROI). It has **no view of the individual user's own working
context** — what's already on their calendar, who they've recently been emailing, the personal notes
they keep on a contact. Without that, the itinerary is personalized only by explicit `Preferences`
toggles, not by the user's live context.

A dedicated, **private, per-user** server closes that gap **without** collapsing the privacy
boundary: personal M365 data stays user-scoped and is used only to personalize the requesting user's
own itinerary, in the moment.

## Goals
- Stand up a **separate MCP server** that exposes the requesting user's own M365 context as tools.
- Authenticate **per user via Entra ID / OBO**, fully decoupled from the main solution's Keycloak plane.
- Feed **runtime personalization** signals into the planner so *that user's* itinerary is tailored
  (ranking, scheduling around real commitments, richer pre-briefs).
- Keep raw personal data **private and user-scoped**; expose only minimal, purpose-built signals to
  the planner, at request time.
- Preserve consent, retention, and auditability for personal data.
- Be independently deployable and independently disable-able, with **zero** hard runtime dependency
  from the core demo (the planner degrades to shared-only results when the server is absent).

## Non-Goals
- **No projection into, or write path to, the shared engagement-intelligence store.** Personal
  context personalizes only the requesting user's own itinerary at runtime; it is never promoted into
  org-shared recall.
- No live Microsoft Graph synchronization committed in the current branch.
- No new shared data model; the shared `engagements` index and its security trim are unchanged.
- No coupling to Keycloak; this server uses its own Entra ID auth plane.
- No production-grade security infrastructure specified in full here.

## Design Principles
1. **Private by default.** Raw personal-context data stays in a user-scoped private store readable
   only by that user (via their own token) and tightly scoped services.
2. **Personalize at runtime, don't share.** Personal signals are consumed **in the request** to tune
   one user's itinerary; they are never persisted into shared intelligence.
3. **Separate deployable, separate auth plane.** Its own service, its own Entra ID / OBO auth, no
   cross-IdP brokering with Keycloak.
4. **Minimum necessary data.** The planner receives the smallest useful derived signal, not raw
   calendar/mail/notes content.
5. **Never widens access.** Personal context can only **re-rank, narrow, or annotate** what the
   shared security trim already authorized — exactly like `Preferences`. It can never surface a
   contact the shared trim withheld.
6. **User awareness and control.** Users opt in per source, can see what's used, and can disable it.
7. **Incremental adoption.** Works in phases, starting with manual/mocked ingestion before any live
   Graph calls.

## Scope Overview
Three conceptual layers, all **private and user-scoped**:

1. **Private Personal Context Store** — user-specific source events and derived facts, visible only
   to that user.
2. **M365 Connector Layer** — bounded, consent-gated Graph connectors that normalize approved source
   data into private-context events/facts.
3. **Runtime Personalization Surface (MCP tools)** — the tools the planner calls at request time to
   fetch that user's minimal personalization signals. **This replaces any "projection into shared
   intelligence" pathway** — signals flow to the planner in-request, not into a shared store.

## High-Level Architecture

```text
                       ┌───────────────────────────────────────────────────────────┐
                       │  MAIN ENGAGEMENTS SOLUTION (unchanged)                      │
Microsoft 365 Sources  │  Keycloak-authed UI → orchestrator → shared security trim  │
  └─> Connector        │  → Azure AI Search `engagements` (tenant/ACL/sensitivity)  │
      Adapters (OBO)    └───────────────────────────┬───────────────────────────────┘
        └─> Private Normalization                   │  at request time, the planner asks the
              └─> Private Personal Context Store     │  user's Personal Context server for
                    └─> Runtime Personalization ─────┘  minimal personalization signals
                          Surface (MCP tools)           (re-rank / schedule-fit / annotate)
                                  ▲
                        per-user Entra ID / OBO token (separate deployable, separate auth plane)
```

Key property: the arrow into the planner is a **read at request time**, scoped to the caller's own
token. There is **no arrow from the private store into the shared index.**

## Private Personal Context Store

### Responsibilities
- Store raw or near-raw user-specific context from approved M365 sources.
- Build user-level derived facts: inferred focus topics, recent-contact recency, schedule pressure,
  follow-up risk, personal notes on a contact.
- Maintain provenance linking every fact to source system, event time, ingestion time, and transform.
- Enforce strict **user-scoped** access — this store is **not** queryable as a shared org dataset and
  is a **separate store** from the shared `engagements` index (never just another `source`/`kind`
  inside it).

### Example Private Data Categories
- calendar-derived working context (busy windows, existing trips/locations),
- meeting participation / cadence metadata,
- email interaction metadata (recency, counterpart — not bodies),
- task/reminder metadata,
- user-authored notes or preferences,
- inferred focus areas / engagement priorities,
- relationship strength or recency estimates.

### Storage Expectations
- user-scoped partitioning and encrypted storage,
- retention windows by data type,
- provenance and audit metadata,
- soft deletion and revocation handling,
- recomputation of derived facts when policy or consent changes.

### Recommended Modeling Approach
- **source events** — normalized records from connectors,
- **derived facts** — higher-level interpretations with confidence scores,
- **user preferences and consent records** — explicit opt-in state,
- **usage records** — an audit trail of what personal signal was surfaced to the planner, when, and
  for which itinerary request (the private-side analog of an audit log; **not** a shared publish log).

## Microsoft 365 Integration Boundaries

### Candidate M365 Sources
Outlook calendar; Outlook mail metadata; Microsoft To Do / Planner task metadata; contacts /
directory-enriched relationship context; Teams meeting or participation metadata.

### Boundary Rules
- ingest only approved scopes and entities for the **requesting user** (OBO),
- prefer metadata over full content; avoid storing message bodies or attachments unless a later
  policy explicitly allows it,
- normalize external records into stable internal schemas before any downstream use,
- preserve source identifiers and timestamps for auditability,
- support selective disablement per source type.

### Connector Contract
Each connector produces normalized private events carrying: source type, source object id,
**tenant id** (inherited from the user's token), **user id (owner)**, timestamps, classification
tags, sensitivity label if available, extraction confidence, and raw→normalized provenance. Every
record is stamped with the owning user id and tenant id; a record with no owner is **rejected
(fail-closed)**.

### Sync Modes
- **manual import** for early experiments,
- **scheduled batch sync** for low-risk rollout,
- **event-driven incremental sync** once governance and operational maturity are proven.

## Runtime Personalization for the Planner

### How the planner consumes personal context
At request time the orchestrator (or the contacts/planner sub-agent) calls the Personal Context MCP
server **with the user's own token**. The server returns a compact, purpose-built payload —
conceptually a **richer, user-scoped `Preferences`** — that the planner uses to:

- **re-rank** candidates the shared trim already returned (boost a contact the user has been actively
  emailing; surface a topic their calendar shows growing attention to),
- **fit scheduling** to the user's real availability and existing trips ("you're already going
  there" gets stronger when it's genuinely on *their* calendar),
- **enrich the pre-brief** for a stop with the user's own notes/history on that contact.

### The hard invariant — never widens access
Mirroring `Preferences` (`schema.ts`) and ARCHITECTURE.md §5.4: personal context **only re-orders,
narrows, or annotates** results the shared, server-side security trim already authorized for this
caller. It can **never** cause a contact, event, or field to appear that the shared `$filter`
withheld. The trim remains the sole authority for *what may be seen*; personal context influences
only *how it's ordered and framed* for this user.

### Personalization payload shape (illustrative)
- personalization id + generated-at timestamp,
- signal type (e.g. `active-recent-contact`, `calendar-conflict`, `focus-topic`, `personal-note`),
- subject entity or engagement id (matching an id the planner already holds),
- minimal derived value (a score, a busy window, or short note text the user authored),
- confidence score + freshness window,
- provenance reference to a private source event.

This payload lives only for the duration of the request; it is not written to shared storage.

## Policy, Privacy, and Governance

### Consent Model
Explicit, source-aware, revocable. Users opt in per connector category, can view what's enabled, and
revocation stops future ingestion/personalization and triggers cleanup or expiry. Administrative
policy can further narrow what is allowed.

### Data Classification
Classify each element at ingestion and at use: `private-raw`, `private-derived`,
`shared-with-planner-at-runtime` (transient), `restricted/disallowed`. Machine-readable and enforced
by services. Note there is deliberately **no** `shared-persisted` class — nothing is written to the
org store.

### Retention and Deletion
Reuse the labeling discipline the main architecture already uses for the shared index
(ARCHITECTURE.md §16.3–16.4 — `retentionClass`, `validFrom`/`validUntil`, `IsDeleted`, recompute on
reindex), applied **to the private store**:
- raw private source data gets the shortest viable retention,
- derived private facts expire or recompute on a schedule,
- deletion requests / consent changes propagate through dependent derived facts.

### Auditability
Record what source data was ingested, what derivations were computed, **what personal signal was
surfaced to the planner and for which request**, what consent/policy applied, and when
revocation/expiry removed a signal.

## Security and Access Control
- **Separate deployable, separate auth plane.** Its own service and its own **Entra ID / OBO** auth,
  decoupled from Keycloak. Reuse the existing OBO plumbing pattern (`getOboToken`,
  historically `api/src/services/entra-token.ts`) — the user's token brokers Graph and the private
  store on their behalf.
- **User-scoped, service-mediated.** The private store is only reachable with the owning user's
  token; there is no service path that reads another user's context.
- **Fail-closed tenancy.** Every record inherits `tenantId` from the user's token; a missing owner or
  tenant is rejected.
- **No shared exposure.** The shared engagement-intelligence store never reads the private store, and
  the private store never writes to it.
- **Deterministic gating.** Any logic that *gates* what is surfaced (consent checks, access, tenancy)
  is deterministic — consistent with the repo rule "deterministic core, LLM only at the edges."
  LLM/heuristic inference may compute *derived facts*, but must not be the authority for access.

## Suggested Domain Components

### 1. Personal Context Service
Owns private facts, provenance, consent state, retention, and user-facing controls. Exposes the MCP
tools the planner calls at runtime.

### 2. M365 Connector Service
Handles Microsoft Graph integration (OBO), source sync scheduling, normalization, and connector
health.

### 3. Planner Personalization Adapter
The thin seam the orchestrator/sub-agents call to fetch the runtime personalization payload with the
user's token and merge it into ranking/scheduling/pre-brief — **the `Preferences`-style consumption
point**, never widening access.

### 4. Governance and Audit Service
Captures audit events, retention workflows, consent/policy versions, and revocation processing for
the private store.

> Note vs. the earlier draft: there is intentionally **no** "Projection Policy Engine" or "Shared
> Engagement Intelligence Service" here — personal context is consumed at runtime, not projected into
> a shared store.

## Data Flow Walkthrough
1. A connector imports approved M365 metadata **for the requesting user** (OBO).
2. The normalization pipeline converts source records into private events.
3. The Personal Context service derives higher-level private facts (user-scoped).
4. The user asks the planner for an itinerary; the shared path returns tenant/ACL-trimmed candidates.
5. The Planner Personalization Adapter calls the Personal Context server **with the user's token** and
   receives a minimal personalization payload.
6. The planner **re-ranks / schedule-fits / annotates** the already-authorized results for this user.
7. Nothing is written back to shared intelligence; if consent changes or facts expire, future
   personalization simply reflects the new state.

## Implementation Roadmap

### Phase 0 — Documentation and model alignment
- finalize private-store terminology and the personalization-payload contract,
- align on the source classification + consent vocabulary,
- confirm the seam where the planner consumes personalization (map to `Preferences`).

### Phase 1 — Private context foundation (standalone server)
- scaffold the separate MCP server with Entra ID / OBO auth,
- introduce personal-context schemas and user-scoped storage boundaries,
- add provenance, consent, and retention metadata models,
- support manual/mocked ingestion for end-to-end experiments.

### Phase 2 — Initial M365 connectors (metadata-first)
- add low-risk connectors, starting with **calendar** and **task** signals before richer mail,
- implement scheduled sync and normalization; validate per-user tenant scoping and observability.

### Phase 3 — Runtime personalization integration
- implement the Planner Personalization Adapter and the personalization-payload tools,
- wire re-rank / schedule-fit / pre-brief enrichment into the planner, enforcing "never widens
  access,"
- add confidence + freshness handling and provenance for explainability.

### Phase 4 — Product integration
- surface personalized ordering and pre-brief annotations in the chat itinerary,
- let users review/manage consent and see which personal signals influenced a result,
- add reporting on personalization usage, freshness, and revocation.

### Phase 5 — Hardening and governance expansion
- formalize consent/policy management and exceptions,
- add granular admin and audit workflows and retention automation,
- expand supported M365 sources if justified by value/risk review.

## Alignment with Existing Architecture
| This design | Existing repo concept | Notes |
| ----------- | --------------------- | ----- |
| Separate, Entra/OBO-authed Personal Context MCP server | ARCHITECTURE.md §5.4 "Personal notes (stretch)" — separate Entra-ID MCP client decoupled from Keycloak; §14 future work | Build on the OBO seam (`getOboToken`); no Keycloak brokering |
| Runtime personalization payload | `seed/schema.ts` `Preferences` (runtime rank/filter input) | Richer, user-scoped `Preferences`; **never widens access** (same invariant) |
| "Never widens access" | §5.4 security trim is authoritative; `Preferences` only re-orders/narrows | Personal context influences ordering/framing only |
| Retention / revocation via labels | §16.3 `retentionClass`/`validFrom`/`validUntil`/`IsDeleted`; §16.4 recompute-on-reindex | Apply the same labeling discipline to the **private** store |
| Deterministic access gating | §1 "deterministic core, LLM only at the edges" | LLM may derive facts; must not gate access |
| **No** shared projection | — | Explicit divergence from the earlier draft; personal context is consumed at runtime, not published to shared intelligence |

## Open Design Questions
- Which M365 source is first for best value-to-risk ratio — calendar (schedule-fit) or mail-recency
  (re-rank)?
- What personalization signal types are safe and useful enough for a first slice?
- Where should the private store live (per-user partition technology) and how is it keyed to the
  Entra object id?
- What is the minimum provenance needed to explain "why was this stop ranked higher for me?" without
  exposing raw calendar/mail content?
- How should the planner degrade when the Personal Context server is disabled or a user hasn't
  consented (must be a clean shared-only fallback)?

## Recommended Next Steps
1. Confirm the standalone server's home (separate repo/package vs. a sibling capability folder) and
   its deploy target.
2. Define the runtime **personalization-payload contract** and the exact planner seam that consumes
   it (extend/parallel `Preferences`).
3. Identify the minimum Microsoft Graph scopes for a **metadata-first calendar** pilot.
4. Specify the consent UX and the "why did I see this?" explainability surface.
5. Review alongside `engagement-intelligence/ARCHITECTURE.md` §5.4 / §16 to keep terminology aligned.

## Summary
This design adds a **separate, per-user Personal Context MCP server** that lets the engagement planner
see the **requesting user's own** calendar/email/notes and personalize **that user's** itinerary at
request time. Personal data stays private and user-scoped behind its own Entra ID / OBO auth plane;
signals are consumed in-request to re-rank, schedule-fit, and enrich pre-briefs, and **never** widen
access or get projected into the shared organizational engagement-intelligence store.
