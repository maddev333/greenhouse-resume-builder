# MVP Data Model (PostgreSQL JSONB): Versioned Facts, Citations, Annotations, Relationships, Temporal Predictions

## 1. Design principles

- **Version every extracted fact** so citations are possible.
- **BulletMappings are first-class** so “citation per bullet” is deterministic.
- **Annotations are simple**: comment text anchored to a FactVersion.
- Relationships are edges with statuses and evidence.
- **Temporal observations are separate from predictions** so the system never confuses "observed fact" with "likely future event."
- Predicted events must include confidence, evidence, rationale, status, and expiration/review windows.
- Location-bearing records can include reusable location metadata; Azure Maps pins are projections over those records, not independent facts.
- Every record includes `tenantId` for future doc-level auth.

## 2. PostgreSQL JSONB document tables

The current MVP implementation stores each entity as `{ id TEXT PRIMARY KEY, data JSONB NOT NULL }` and provisions tables/indexes on startup.

Current implemented tables:

1. `persons`
2. `source_documents`
3. `extraction_runs`
4. `fact_versions`
5. `bullet_mappings`
6. `annotations`
7. `relationships`

Target metadata/control-plane tables from `TOBE_ARCHITECTURE.md`:

1. `artifact_manifests`
2. `artifact_lineage`
3. `index_jobs`
4. `mcp_jobs`
5. `tenant_cells` if this repo owns local cell routing

Target temporal tables/entities:

1. `temporal_events`
2. `event_patterns`
3. `event_predictions`
4. `recruiter_alerts`

> Note: Do not treat JSONB tables as the petabyte-scale data store. Large raw/derived content should move to immutable Blob/ADLS-style artifacts referenced by manifests and lineage records.

## 3. Entity schemas (field-level)

### 3.1 People

- `id` (pk) = `personId`
- `tenantId`
- `canonicalName`
- `aliases[]`
- `dedupStatus`: `system_matched | recruiter_selected | needs_review`
- `systemMatchScore` (optional)
- `createdAt`, `updatedAt`

### 3.2 SourceDocuments

- `id` = `sourceDocumentId`
- `tenantId`
- `personId` (optional; if stored per candidate run, you can also omit and link by ExtractionRun)
- `sourceType`: `web | upload`
- For web:
  - `uri`
  - `capturedAt`
  - `contentHash`
- For upload:
  - `blobPath`
  - `mimeType`
  - `uploadedAt`
- `extractionRunId`
- `createdAt`

### 3.3 ExtractionRuns

- `id` = `runId`
- `tenantId`
- `requestedByUserId`
- `status`: `queued | in_progress | completed | failed`
- `sourceDocumentIds[]`
- `createdAt`, `completedAt`, `failedReason`

### 3.4 FactVersions

- `id` = `factVersionId`
- `tenantId`
- `personId`
- `extractionRunId`
- `sectionId` (e.g., `experience`, `skills`, `education`, `summary`)
- `factKey` (ontology key, e.g., `employment.employer_name`)
- `factValue` (string or JSON)
- `normalizedValue` (string)
- `extractedAt`
- `confidence` (optional for MVP)
- `status`: `extracted | inferred | edited`
- `sourceDocumentIds[]` (evidence)
- Temporal metadata for dated facts:
  - `eventDate` (optional ISO date for point-in-time facts)
  - `startDate`, `endDate` (optional ISO dates for intervals)
  - `temporalGranularity`: `day | month | year | range | unknown`
  - `observedAt` (when the source was captured or fact was observed)
- Location metadata for location-bearing facts:
  - `locationText` (raw or display location)
  - `city`, `region`, `country` (optional normalized fields)
  - `latitude`, `longitude` (optional)
  - `locationPrecision`: `exact | venue | city | region | country | unknown`
  - `locationConfidence` (0-1)
  - `locationSource`: `extracted | geocoded | recruiter_entered | imported`

**Internal supporting metadata (optional)**

- `latestForKey` (bool) for fast “latest fact” lookup

### 3.5 BulletMappings

- `id` = `bulletId` (or composite stable id)
- `tenantId`
- `personId`
- `sectionId`
- `bulletText` (what is rendered)
- `bulletSignature` (stable identity used for diffing; e.g., hash of the underlying structured fact set)
- `citationFactVersionIds[]`
- `citationSourceDocumentIds[]`
- `latestForBullet` (bool)
- `createdAt`

### 3.6 Annotations (simple)

- `id` = `annotationId`
- `tenantId`
- `personId`
- `targetType`: `factVersion`
- `targetFactVersionId`
- `commentText`
- `createdByUserId`
- `createdAt`
- `status`: `open | resolved` (optional)

### 3.7 Relationships

- `id` = `relationshipId`
- `tenantId`
- `fromPersonId`
- `toPersonId`
- `relationshipType`
- `status`: `suggested | confirmed | rejected`
- `inferredByAgent` (bool)
- `confidence` (optional for inferred)
- `evidenceFactVersionIds[]`
- `evidenceSourceDocumentIds[]`
- `confirmedByUserId`, `confirmedAt`
- `rejectedByUserId`, `rejectedAt`

### 3.8 TemporalEvents

- `id` = `temporalEventId`
- `tenantId`
- `personId`
- `eventType`: `conference_presentation | publication | certification | award | role_change | education_milestone | media_appearance | other`
- `eventName` (e.g., `ContosoConf`)
- `eventTitle` (optional, e.g., talk/session title)
- `eventDate` (optional ISO date)
- `startDate`, `endDate` (optional ISO dates for ranges)
- `temporalGranularity`: `day | month | year | range | unknown`
- `location` (optional)
- `latitude`, `longitude` (optional)
- `locationPrecision`: `exact | venue | city | region | country | unknown`
- `locationConfidence` (0-1)
- `organizer` (optional)
- `normalizedEventKey` (stable key for recurrence matching, e.g., normalized event name + type)
- `recurrenceKey` (optional broader grouping key, e.g., annual conference series)
- `sourceFactVersionIds[]`
- `sourceDocumentIds[]`
- `confidence`
- `status`: `observed | corrected | rejected`
- `createdAt`, `updatedAt`

### 3.9 EventPatterns

- `id` = `eventPatternId`
- `tenantId`
- `personId`
- `patternType`: `recurring_event | sequence | seasonality | gap`
- `eventType`
- `eventName`
- `normalizedEventKey`
- `cadence`: `annual | semiannual | quarterly | monthly | irregular | unknown`
- `monthWindow` (optional, e.g., `{ earliestMonth: 9, latestMonth: 10 }`)
- `observedTemporalEventIds[]`
- `firstObservedDate`, `lastObservedDate`
- `occurrenceCount`
- `regularityScore` (0-1)
- `recencyScore` (0-1)
- `confidence` (0-1)
- `status`: `active | weak | stale | dismissed`
- `createdAt`, `updatedAt`

### 3.10 EventPredictions

- `id` = `eventPredictionId`
- `tenantId`
- `personId`
- `eventPatternId`
- `predictedEventType`
- `predictedEventName`
- `predictedWindowStart`, `predictedWindowEnd`
- `confidence` (0-1)
- `confidenceBand`: `low | medium | high`
- `rationale` (human-readable explanation)
- `evidenceTemporalEventIds[]`
- `evidenceFactVersionIds[]`
- `evidenceSourceDocumentIds[]`
- `generatedByAgent`
- `generatedAt`
- `expiresAt`
- `status`: `suggested | notified | accepted | dismissed | expired | confirmed_by_evidence`
- Recruiter feedback:
  - `reviewedByUserId`
  - `reviewedAt`
  - `reviewNote`

### 3.11 RecruiterAlerts

- `id` = `alertId`
- `tenantId`
- `personId`
- `targetType`: `eventPrediction | relationship | reviewTask`
- `targetId`
- `alertType`: `predicted_event | low_confidence_fact | relationship_suggestion | conflict`
- `priority`: `low | medium | high`
- `message`
- `confidence` (optional)
- `createdAt`
- `dueAt` (optional)
- `status`: `unread | read | snoozed | dismissed | actioned`
- `snoozedUntil` (optional)

### 3.12 MapPin projection

Map pins may be generated at query time or stored as a read model later. They should not become a competing source of truth.

- `id` = stable projection ID
- `tenantId`
- `personId` (optional for non-person-specific source records)
- `sourceType`: `factVersion | temporalEvent | relationship | sourceDocument | eventPrediction`
- `sourceId`
- `label`
- `summary`
- `latitude`, `longitude`
- `locationPrecision`: `exact | venue | city | region | country | unknown`
- `locationConfidence` (0-1)
- `eventDate`, `startDate`, `endDate` (optional)
- `evidenceFactVersionIds[]`
- `evidenceSourceDocumentIds[]`
- `createdAt`

Privacy guidance:

- exact personal/home addresses should not be displayed by default
- prefer city/region precision for sensitive candidate-provided locations
- every pin should link back to the source record and evidence

## 4. Diff computation (MVP: bullet-level diffs only)

- Diffs are computed and rendered using **BulletMappings**.
- For each `personId + sectionId`:
  1. Load the previous run’s latest bullet set and the current run’s latest bullet set.
  2. Compare bullets by `bulletSignature`.
  3. Classify bullets as:
     - `added` (signature present only in new set)
     - `removed` (signature present only in old set)
     - `changed` (signature present in both, but `bulletText` and/or citation sets differ)
  4. For `changed`, show:
     - previous `bulletText` vs current `bulletText` (if different)
     - citation change summary (e.g., which `citationFactVersionIds[]` changed)

> Note: FactVersions are versioned to support citations and annotations, but MVP UI diffs are not fact-level or span-level.

## 5. Temporal pattern and prediction computation

Temporal prediction is derived from observed events and must stay separate from facts.

Example:

1. Extract observed events:
   - `Presented at ContosoConf 2022`
   - `Presented at ContosoConf 2023`
   - `Presented at ContosoConf 2024`
2. Group by `personId + normalizedEventKey`.
3. Detect cadence:
   - annual if event dates repeat approximately once per year
   - month window based on observed dates
4. Score confidence:
   - higher with more observations
   - higher with consistent cadence/date window
   - higher with recent events
   - higher with strong source evidence
   - lower with skipped years, weak name matching, or stale evidence
5. Create an `EventPrediction`:
   - `predictedEventName = ContosoConf`
   - `predictedWindowStart = next expected season start`
   - `predictedWindowEnd = next expected season end`
   - `confidenceBand = low | medium | high`
   - `rationale` cites the observed history
6. Create a `RecruiterAlert` only when the prediction is actionable and above the configured threshold.

Suggested MVP confidence bands:

- `high`: `confidence >= 0.75`
- `medium`: `0.45 <= confidence < 0.75`
- `low`: `confidence < 0.45`

Suggested MVP alert threshold:

- alert recruiters for `medium` or `high` predictions only
- keep `low` predictions searchable but do not alert unless explicitly requested

---

## 6. Notes on dedup

MVP dedup policy:

- System person-entity resolution proposes matches.
- If confidence is ambiguous, recruiter selects an existing Person.
- Facts always land under the final `personId` chosen.
