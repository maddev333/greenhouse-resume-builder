# Greenhouse Resume Builder — Implementation Status

**Last doc refresh:** 2026-06-14  
Next-session handoff: `NEXT_AGENT.md`  
Detailed prioritized task list: `AGENT_TASKS.md`

## Summary

This document is intended to stay **code-aligned**. It reflects the repository state from the current source review, not older assumptions. Several previously logged gaps have now moved forward, so this status should direct the next coding agent toward the remaining work instead of re-opening already-addressed fixes.

---

## 1. Foundations

### Implemented
- Monorepo workspace layout across `api`, `functions`, `shared`, and `ui`
- Shared domain/data-transfer types in `shared/src/interfaces.ts`
- Cosmos DB client bootstrap and repository pattern in `api/src/db/`
- Core Express server wiring and route registration in `api/src/server.ts`

### Known constraints
- Cosmos containers are still provisioned with default `/id` partition keys.
- Some Express route handlers still use broad request typing (`req: any` or equivalent loose typing).
- Full build/type validation still needs to be rerun after the latest round of source changes.

---

## 2. Ingestion API

### Implemented / corrected
- `POST /api/v1/ingestion-requests`
- `GET /api/v1/ingestion-requests/:runId/status`
- `GET /api/v1/ingestion-requests` listing/filter path
- `api/src/routes/ingestion.ts` now returns `sourceDocumentIds: string[]` on both the created and deduplicated response paths, matching the current shared DTO expectation rather than the older mismatched shape.

### Remaining follow-up
- The route still uses broad request typing and should be revisited if adjacent API contract work is taken on.
- Runtime/build verification is still preferred over source inspection alone.

---

## 3. Durable Functions pipeline

### Implemented / corrected
- Orchestrator stages are registered and mapped to activities.
- Persistence is routed through `df.callActivity('PersistBuilderOutput', ...)` instead of direct persistence inside the orchestrator body.
- `functions/index.ts` is now a clean stub instead of a corrupted merge artifact.

### Remaining follow-up
- Verify build/runtime health for the Functions package after the replay-safety and entry-point fixes.
- Keep any future persistence or indexing I/O behind activity boundaries.

---

## 4. Builder agent

### Implemented / corrected
- Deterministic fact generation is present.
- Deterministic bullet IDs now include `personId`, reducing cross-person collision risk.
- Section builders and citation-chain generation exist for the current MVP scope.

### Remaining follow-up
The builder output contract can still be widened later if the next slice requires richer downstream metadata:
- `warnings`
- `dedupedCounts`
- `groups`
- `buildVersion`
- `metrics`

This remains a lower-priority enhancement, not a correctness blocker.

---

## 5. Search indexing

### Implemented / corrected
- Search helper code exists on both API and Functions sides.
- Search indexing paths are documented and coded toward first-write-safe upsert behavior rather than merge-only semantics.

### Remaining follow-up
- Verify package/type compatibility around the current search client usage during the next build-validation pass.
- Reconcile any remaining schema/client drift between API and Functions implementations.
- Confirm the current query helper is building valid Azure Search filters/options before treating search as runtime-ready.
- Preserve a single code-aligned story in docs if search implementation details change again.

---

## 6. Authentication

### Current status
- Dev mode remains a permissive bearer-token bypass for local development.
- Production auth is implemented with `jose`-based JWT verification against a remote JWKS set in `api/src/middleware/auth.middleware.ts`.

### Remaining follow-up
- If the next agent performs runtime verification, confirm issuer/audience/JWKS behavior works in the intended deployment environment.
- Keep docs explicit that dev-mode bypass is for local development only.

---

## 7. Relationships and annotations

### Implemented
- Annotation CRUD routes exist.
- Relationship suggestion and update routes exist.
- Several response-shape fixes were documented as already applied to improve DTO alignment.

### Remaining follow-up
- Keep an eye on any create/update branches that still rely on placeholder defaults or simplified persistence assumptions.
- Re-verify route responses against shared DTOs if adjacent API work is performed.

---

## 8. UI

### Implemented / corrected
- `App()` conditionally renders `LandingPage` or `CandidateProfilePage` based on URL state.
- Candidate profile, diff, annotation, relationship, and search views remain part of the current UI surface.
- Landing page code includes submission, polling, recent-run, and candidate navigation paths, but these still need end-to-end runtime validation.

### Remaining follow-up
- Landing page ingestion flow still needs end-to-end validation and hardening:
  - upload file staging into Blob Storage before Document Intelligence
  - auth/header behavior against the protected API
  - polling behavior against a running Functions host
  - loading / error / empty states under real failures
  - recent runs from the ingestion list endpoint
- The current candidate-page data contract is not yet fully aligned with the API:
  - `ui/src/app.tsx` expects grouped bullet data under `sections`
  - `api/src/routes/resume-bullets.ts` currently returns a flat bullet array
  - the UI diff call still targets `/inferences/:personId/differences`, while the implemented route is under `/insights/:personId/differences`

This is now one of the clearest visible MVP gaps in the UI/API integration surface.

---

## 9. Temporal intelligence

### Target architecture / planned
- `mvp_architecture.md`, `mvp_ingestion_pipeline.md`, `mvp_data_model.md`, `mvp_ontology.md`, and `mvp_search_indexes.md` now describe temporal intelligence as a target capability.
- Planned concepts include `TemporalEvent`, `EventPattern`, `EventPrediction`, and `RecruiterAlert`.
- Planned agent activities include temporal event extraction, recurrence/pattern detection, future-event prediction, and recruiter alerts.

### Current status
- This is not verified runtime behavior yet.
- Predictions must remain separate from observed facts and include evidence, rationale, confidence, status, and expiration/review windows.
- Recruiter feedback should update prediction/alert status but should not turn a prediction into an observed fact unless source evidence later confirms it.

---

## 10. Azure Maps / geospatial UI

### Target architecture / planned
- `mvp_architecture.md`, `mvp_implementation_plan.md`, `mvp_data_model.md`, and `mvp_search_indexes.md` now describe Azure Maps/map-pin support as a target capability.
- Planned concepts include reusable location metadata and a `MapPin` projection over source records.
- Planned UI behavior includes Azure Maps pins/clusters for database records with approved coordinates or geocodable public/professional locations.

### Current status
- This is not verified runtime behavior yet.
- Map pins should remain projections over source records, not independent facts.
- Exact personal/home locations should not be displayed by default; prefer coarse city/region display for sensitive candidate-provided locations.

---

## 11. Partition strategy note

The current Cosmos setup uses `/id` partition keys for MVP simplicity. That keeps setup simple but makes several practical access patterns cross-partition, especially queries driven by `tenantId` or `personId`.

### Guidance
- Keep this documented as an intentional MVP tradeoff.
- Do not start a container migration unless that work is explicitly in scope.
- If production scale becomes a near-term concern, revisit container-specific partition keys before optimizing query-heavy paths.

---

## 12. Prioritized remaining work

### P1
1. Keep top-level docs aligned so already-fixed issues are not re-opened in the next pass.
2. Reconcile the current UI/API contract for bullets and diffs.
3. Validate and harden LandingPage → ingestion → polling → candidate navigation wiring.

### P2
4. Run build/type verification across workspace packages and record exact blockers.
5. Reconfirm any search-client typing drift or repo typing issues surfaced by build validation.
6. Keep partition-key tradeoffs documented accurately.
7. Begin temporal-event/prediction implementation behind the planned agent/activity boundaries.
8. Begin Azure Maps/map-pin implementation behind the planned API projection and UI boundaries.

### P3
9. Optionally widen the builder output contract if required by the next implementation slice.

---

## Definition of done for the next coding pass

The next pass should be considered successful if it does the following:
- Leaves docs aligned with the verified code state.
- Completes or materially advances the landing-page ingestion workflow.
- Produces a concrete build/type verification result for the repo or clearly documents the blockers.

Optional follow-on work:
- Builder output enrichment
- Search cleanup after build validation
