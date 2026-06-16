# AGENT_TASKS.md

## Objective
Provide an updated, prioritized coding-agent handoff for the current Greenhouse Resume Builder repository based on the code that actually exists today. The next implementation pass should focus on correcting mismatches, hardening the MVP path, and finishing the most important incomplete integrations.

## Current project state snapshot

### What is materially implemented
- Monorepo layout exists across `api`, `functions`, `shared`, and `ui`.
- Shared DTOs/types are present and already referenced by multiple packages.
- The main Durable Functions pipeline exists in `functions/src/pipeline/orchestrator.ts`.
- Section extraction activities exist for experience, skills, education, summary, dedup, relationships, and version diffing.
- Builder artifact generation exists in `functions/src/activities/builder-agent.ts` and now uses deterministic content-based IDs.
- Functions-side Cosmos persistence helpers exist in `functions/src/persistence/index.ts`.
- API-side Cosmos repositories and route scaffolding exist under `api/src/db/repo` and `api/src/routes`.
- Search setup and query helpers exist in `api/src/search/index.ts`, and search indexing hooks exist in `functions/src/persistence/index.ts`.
- The UI and typed API client exist in `ui/src/app.tsx` and `ui/src/api.ts`.
- Root workspaces appear to be configured via the top-level `package.json`.

### What is implemented but still risky or incomplete
- The Durable orchestrator currently performs direct imports/calls to persistence code and contains ordinary `console` logging; it needs a replay-safety and activity-boundary review.
- The orchestrator references activity names such as `StoreUploadsAndExtract`, `FetchAndSnapshotWebSources`, and `UpdateExtractionRunStatus`; these need to be confirmed as actually registered and triggerable.
- Builder IDs are now deterministic, but artifact timestamps are still generated at runtime, and bullet identity ignores `personId` despite accepting it as a parameter.
- Functions persistence is present but container creation, partitioning, query shape, and point-read assumptions need explicit validation.
- Search integration exists in two places (`api/src/search/index.ts` and `functions/src/persistence/index.ts`) and likely diverges in schema, client construction, and upsert behavior.
- Search document upserts currently use merge semantics and may fail for first-write scenarios if the document does not already exist.
- Auth middleware exists, but the production path is still a lightweight/manual JWT parser rather than a robust signature-verifying implementation.
- API/UI surfaces exist, but the end-to-end happy path still needs a verification pass against the actual backend contracts.
- Repo docs still overstate completion in several places and are not fully trustworthy as status documents.

### What looks contradictory in the current repo
- `README.md` and `IMPLEMENTATION_STATUS.md` describe several areas as complete that still appear scaffolded, partially implemented, or internally inconsistent.
- `IMPLEMENTATION_STATUS.md` contains conflicting statements within the same document about retry policies, idempotency, search completeness, and activity maturity.
- The architecture docs are useful as intent, but the codebase should now be treated as the primary truth source.

---

## Guidance for the coding agent
1. **Use the current codebase as the source of truth.** Update docs to reflect code, not the reverse.
2. **Do not redesign the architecture first.** Finish and harden the existing MVP slice.
3. **Preserve working scaffolding where possible.** Prefer targeted fixes over broad rewrites.
4. **Close vertical gaps.** When fixing a workflow, align `shared` types, Functions, API, UI, and docs together.
5. **Prioritize correctness over breadth.** Determinism, replay-safety, and runnable flows matter more than new features.

---

## Priority 0 — Reconcile repository truth

### Task 0.1 — Rewrite status docs to match the actual codebase
**Why**
The repo currently has a credibility problem: the status docs and README overclaim maturity in several places. This will misdirect the next coding pass unless corrected immediately.

**Files to review/update**
- `README.md`
- `IMPLEMENTATION_STATUS.md`
- `mvp_architecture.md`
- `mvp_implementation_plan.md`
- `mvp_search_indexes.md`

**Actions**
- Reclassify each major subsystem as one of:
  - implemented
  - partially implemented
  - scaffolded
  - not verified
- Remove contradictory claims around:
  - search readiness
  - orchestration hardening
  - auth completeness
  - API/UI end-to-end readiness
  - persistence maturity
- Add a short “verified current state” summary tied to specific code locations.

**Acceptance criteria**
- A new engineer can read the docs and not be misled about what actually works.
- README and implementation docs no longer conflict on major subsystem status.

---

## Priority 1 — Make the Durable Functions path correct and replay-safe

### Task 1.1 — Review the orchestrator for Durable Functions correctness
**Why**
The ingestion pipeline exists, but the current orchestrator should be treated as functionally promising rather than fully hardened. Durable Functions has strict replay/determinism expectations, and this path is the backbone of the product.

**Primary file**
- `functions/src/pipeline/orchestrator.ts`

**Actions**
- Verify that all referenced activities are actually registered with the same names the orchestrator calls.
- Confirm the orchestrator is not performing work that should live in activities.
- Remove or refactor patterns that are risky in orchestrators, including:
  - direct persistence calls/imports inside the orchestrator
  - non-replay-safe logging patterns
  - dynamic imports used as runtime side effects
- Confirm whether `Promise.all([...df.callActivity(...)])` is appropriate in the current Durable Functions model, or replace with the framework’s preferred fan-out/fan-in pattern.
- Validate error handling and decide which failures are fatal versus best-effort.
- Confirm run status transitions are always written on success and failure paths.

**Acceptance criteria**
- The orchestration flow follows Durable Functions replay/determinism rules.
- Every called activity name maps to a real registered function.
- Success/failure status handling is explicit and consistent.

### Task 1.2 — Move all external side effects behind activities where needed
**Why**
The orchestrator currently appears to reach into persistence and indexing logic directly. Even if parts happen to work, this makes correctness and replay behavior harder to reason about.

**Actions**
- Audit persistence, indexing, and relationship inference side effects currently triggered from the orchestrator.
- Move any non-orchestrator-safe I/O behind dedicated activities.
- Use clear contracts for:
  - persist build results
  - update extraction run status
  - sync search documents
  - infer and persist relationships

**Acceptance criteria**
- Orchestrator code coordinates steps only.
- External I/O and mutation live in activities with explicit inputs/outputs.

---

## Priority 2 — Validate persistence contracts and idempotency

### Task 2.1 — Audit Cosmos entity identity, partitioning, and point-read behavior
**Why**
Persistence code exists on both the API and Functions sides, but the repo still needs a clean, explicit contract for IDs, partition keys, and query expectations.

**Primary files**
- `functions/src/persistence/index.ts`
- `api/src/db/cosmos-client.ts`
- `api/src/db/repo/*.ts`

**Actions**
- Document the intended ID and partition key for each entity type:
  - Person
  - SourceDocument
  - ExtractionRun
  - FactVersion
  - BulletMapping
  - Annotation
  - Relationship
- Verify that container creation matches the point-read patterns being used.
- Confirm whether the current use of `partitionKey: id` is deliberate and consistent across packages.
- Check whether query-heavy access patterns need different partition strategies or explicit acknowledgment as MVP tradeoffs.
- Reconcile any mismatch between API repo assumptions and Functions persistence assumptions.

**Acceptance criteria**
- Each entity has a documented, consistent identity and partition strategy.
- API and Functions layers agree on how data is written and read.
- Reruns/retries do not create uncontrolled duplicates.

### Task 2.2 — Confirm builder/persistence idempotency on rerun
**Why**
Deterministic IDs were introduced in the builder, but rerun safety depends on the full write path, not just ID generation.

**Primary files**
- `functions/src/activities/builder-agent.ts`
- `functions/src/persistence/index.ts`
- related repo/query code in `api/src/db/repo`

**Actions**
- Validate that deterministic fact and bullet IDs are sufficient for upsert behavior.
- Review whether `latestForBullet` semantics remain correct across reruns.
- Confirm whether repeated runs should overwrite, supersede, or coexist with earlier artifacts.
- Review created/extracted timestamps and decide whether they should be activity-generated, persistence-generated, or model-driven.

**Acceptance criteria**
- Replaying or rerunning the same logical input does not produce accidental duplication.
- Latest/current artifact semantics are explicit and correct.

---

## Priority 3 — Finish builder-output correctness and provenance

### Task 3.1 — Tighten builder artifact semantics
**Why**
The builder is farther along than the old AGENT_TASKS implied, but it still needs a quality pass on identity, ordering, traceability, and output semantics.

**Primary file**
- `functions/src/activities/builder-agent.ts`

**Actions**
- Review deterministic ID helpers for facts and bullets.
- Confirm whether bullet IDs should incorporate `personId` and/or `extractionRunId` to avoid cross-person collisions.
- Standardize ordering of generated facts and bullets so equivalent inputs yield stable output ordering.
- Validate provenance fields:
  - `citationFactVersionIds`
  - `citationSourceDocumentIds`
  - `factKey`
  - `normalizedValue`
- Confirm summary fact and bullet generation behavior is consistent with other sections.

**Acceptance criteria**
- Equivalent normalized inputs produce stable IDs and stable ordering.
- Every bullet can be traced back to supporting fact IDs and source document IDs.
- Artifact semantics are documented and consistent across sections.

---

## Priority 4 — Unify and repair Azure AI Search behavior

### Task 4.1 — Reconcile search schema, client usage, and sync behavior
**Why**
Search is no longer “missing,” but it is still not reliable enough to be treated as done. The implementation is split across API and Functions code and likely diverges.

**Primary files**
- `api/src/search/index.ts`
- `functions/src/persistence/index.ts`
- `mvp_search_indexes.md`

**Actions**
- Compare the API-side index definition to the Functions-side search document shape.
- Confirm field names, types, and capabilities line up for:
  - facts
  - bullets
  - summary records
  - any annotation/relationship plans that docs still mention
- Fix any SDK usage errors or invalid option shapes in search client setup.
- Decide whether search sync belongs in API, Functions, or a dedicated indexing layer, and simplify toward one source of truth.
- Replace any unsafe first-write merge semantics with an upsert pattern that works for new documents.
- Verify filter/query construction in API search helpers.

**Acceptance criteria**
- Search document shape matches the configured index schema.
- First-time indexing works.
- Search responsibilities are no longer split ambiguously across multiple implementations.

---

## Priority 5 — Verify the actual MVP happy path across API and UI

### Task 5.1 — Audit the API surface against real shared contracts
**Why**
The API has meaningful scaffolding and likely several real endpoints, but it still needs a deliberate compatibility pass with `shared` types and the current UI.

**Primary files**
- `api/src/routes/ingestion.ts`
- `api/src/routes/resume-bullets.ts`
- `api/src/routes/annotations.ts`
- `api/src/routes/relationships.ts`
- `api/src/server.ts`
- `shared/src/interfaces.ts`

**Actions**
- Verify that documented endpoints actually exist and return the expected shapes.
- Reconcile route payloads/responses with shared DTOs.
- Confirm the ingestion kickoff path, status path, facts path, bullet path, diff path, annotation path, and relationship path all align.
- Remove dead placeholders or explicitly mark them as non-MVP.

**Acceptance criteria**
- API responses match shared contracts or the contracts are updated to match reality.
- The UI can call the documented endpoints without ad hoc shape fixes.

### Task 5.2 — Verify the UI uses the real backend flow
**Why**
The UI exists, but the next coding pass should confirm that it is exercising the real pipeline rather than only rendering isolated scaffolding.

**Primary files**
- `ui/src/app.tsx`
- `ui/src/api.ts`

**Actions**
- Map every UI data dependency to an actual backend route.
- Confirm the UI supports the core MVP path:
  - start ingestion
  - view run status
  - view facts/bullets/diffs
  - manage annotations
  - review relationship suggestions
- Add or tighten loading, empty, and failure states where missing.

**Acceptance criteria**
- A single user can exercise one coherent MVP workflow through the UI.
- UI state transitions reflect real backend responses and failures.

---

## Priority 6 — Fix auth and developer-operability gaps

### Task 6.1 — Replace the fragile production auth path with a real JWT validation approach
**Why**
The middleware has the right intent, but the current production implementation is still lightweight and risky.

**Primary file**
- `api/src/middleware/auth.middleware.ts`

**Actions**
- Replace manual payload parsing with robust JWT signature verification against JWKS.
- Validate issuer, audience, expiration, and tenant/user claims using a supported library and explicit rules.
- Keep dev-mode bypass behavior, but clearly isolate it from production behavior.
- Update docs with exact required env vars.

**Acceptance criteria**
- Production auth performs actual signature verification.
- Required claims and env vars are documented and enforced clearly.

### Task 6.2 — Verify local startup and package-script reliability
**Why**
The repo appears more runnable than before, but docs and scripts still need a trustworthiness pass.

**Primary files**
- root `package.json`
- `api/package.json`
- `functions/package.json`
- `ui/package.json`
- `shared/package.json`
- `README.md`

**Actions**
- Verify install/build/dev scripts for each package.
- Confirm the local startup order and dependency expectations.
- Document what requires cloud services versus what gracefully no-ops in local dev.
- Fix stale commands and misleading setup guidance.

**Acceptance criteria**
- Another engineer can follow the README and start the main services with minimal guesswork.
- Cloud-service prerequisites and optional no-op paths are clearly documented.

---

## Recommended execution order
1. Fix documentation truthfulness.
2. Harden the Durable orchestrator and activity boundaries.
3. Validate Cosmos identity/partition/idempotency contracts.
4. Tighten builder artifact semantics and provenance.
5. Reconcile and repair Azure AI Search integration.
6. Verify API/UI happy-path compatibility.
7. Replace fragile production auth and clean up developer setup docs.

---

## Non-goals for the next pass
Do not prioritize these until the above is complete:
- Re-architecting the monorepo or replacing Durable Functions.
- Adding broad new product features beyond the current MVP slice.
- Advanced scaling/performance work before correctness is proven.
- Full enterprise-grade authorization/security trimming beyond current MVP needs.
- Large UI redesigns unrelated to the existing workflow.

---

## Definition of done for the next coding pass
This handoff should be considered executed successfully when:
- Repo docs accurately describe verified implementation status.
- The orchestrator follows Durable Functions correctness rules and only coordinates activities.
- Persistence contracts are explicit and consistent across API and Functions.
- Builder artifacts are deterministic, stable, and traceable.
- Search indexing/query behavior is unified and reliable.
- API and UI together support one demonstrable MVP happy path.
- Production auth is no longer based on manual JWT parsing.
- Local setup guidance is trustworthy.
