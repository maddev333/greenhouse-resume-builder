# Azure AI Search Index Design (MVP)

> Current source-reviewed caveat: the implemented search code appears centered on a single `resume-facts` index. Annotation and relationship indexes below should be treated as target design, not verified current runtime state, until a build/runtime pass confirms otherwise.

## 1. Index goals

- Fast retrieval of:
  - facts and bullet text for resume sections
  - recruiter annotations for search
  - relationship edges for both-way browsing
  - observed temporal events and predicted future events
  - recruiter alerts for likely upcoming candidate activity
  - map/filter projections for records with location metadata

## 2. Index 1: `resume-facts`

### Documents

Current code direction appears to mix fact-style and bullet-style fields in the same index document. Treat the following as the intended unified shape that still needs validation against the active SDK/client code.

### Fields (suggested)

- `id` (key): bulletId (or factVersionId)
- `tenantId` (filterable)
- `personId` (filterable)
- `sectionId` (filterable)
- `factKeys[]` (searchable/filterable as needed)
- `factValueText` (searchable)
- `bulletText` (searchable)
- `citationSourceDocumentIds[]` (filterable as keyword strings)
- `citationFactVersionIds[]` (filterable keyword strings)
- `extractionRunId` (filterable)
- `extractedAt` (sortable)
- `confidence` (optional)
- `eventDate`, `startDate`, `endDate` (optional sortable temporal fields)
- `temporalGranularity` (optional filterable)
- `locationText`, `city`, `region`, `country` (optional searchable/filterable)
- `latitude`, `longitude` (optional numeric fields for map pin projection)
- `locationPrecision`, `locationConfidence` (optional)

### Query patterns

- hybrid query over `bulletText` + `factValueText`
- filter by `tenantId`, and optionally `personId` when viewing a candidate
- filter/sort by temporal fields when viewing recent or historical candidate activity
- project records with coordinates or normalized location fields into Azure Maps pins

## 3. Index 2: `resume-annotations`

### Documents

Target design only at this stage: each document represents one annotation.

Fields:

- `id` (key): annotationId
- `tenantId` (filterable)
- `personId` (filterable)
- `targetFactVersionId` (filterable)
- `commentText` (searchable)
- `createdAt` (sortable)
- `createdByUserId` (optional)

Query patterns:

- hybrid query on `commentText`
- filter by `personId` when recruiter is viewing candidate

## 4. Index 3: `resume-relationships`

### Documents

Target design only at this stage: each document represents one relationship edge (prefer latest status only for MVP).

Fields:

- `id` (key): relationshipId
- `tenantId` (filterable)
- `fromPersonId` (filterable)
- `toPersonId` (filterable)
- `relationshipType` (filterable/searchable)
- `status` (filterable: suggested/confirmed/rejected)
- `confidence` (optional)
- `relationshipText` (searchable synthesized string, e.g. “Shared employer: Acme (evidence: …)”)
- `evidenceFactVersionIds[]` (optional, for UI jump)

Query patterns:

- both-way for a person: filter `fromPersonId eq P or toPersonId eq P`
- show suggestion cards: only `status=suggested`

## 5. Index 4: `resume-temporal-events`

### Documents

Target design only at this stage: each document represents one observed temporal event.

Fields:

- `id` (key): temporalEventId
- `tenantId` (filterable)
- `personId` (filterable)
- `eventType` (filterable/searchable)
- `eventName` (searchable/filterable)
- `eventTitle` (searchable)
- `eventDate` (sortable/filterable)
- `startDate`, `endDate` (sortable/filterable)
- `temporalGranularity` (filterable)
- `location` (searchable/filterable)
- `latitude`, `longitude` (optional numeric fields)
- `locationPrecision` (filterable)
- `locationConfidence` (sortable)
- `organizer` (searchable/filterable)
- `normalizedEventKey` (filterable)
- `recurrenceKey` (filterable)
- `confidence` (sortable)
- `sourceDocumentIds[]` (filterable keyword strings)
- `sourceFactVersionIds[]` (filterable keyword strings)

Query patterns:

- events for a candidate timeline: filter `personId eq P`, sort by date
- conference history: filter by `eventType eq 'conference_presentation'`
- recurrence candidates: group/search by `recurrenceKey`

## 6. Index 5: `resume-event-predictions`

### Documents

Target design only at this stage: each document represents one predicted future event.

Fields:

- `id` (key): eventPredictionId
- `tenantId` (filterable)
- `personId` (filterable)
- `eventPatternId` (filterable)
- `predictedEventType` (filterable/searchable)
- `predictedEventName` (searchable/filterable)
- `predictedWindowStart`, `predictedWindowEnd` (sortable/filterable)
- `confidence` (sortable)
- `confidenceBand` (filterable)
- `status` (filterable)
- `rationale` (searchable)
- `evidenceTemporalEventIds[]` (filterable keyword strings)
- `evidenceFactVersionIds[]` (filterable keyword strings)
- `evidenceSourceDocumentIds[]` (filterable keyword strings)
- `generatedAt` (sortable)
- `expiresAt` (sortable/filterable)

Query patterns:

- recruiter alert queue: filter `status eq 'suggested' or status eq 'notified'`, sort by confidence and predicted window
- upcoming likely conferences: filter `predictedEventType eq 'conference_presentation'`
- candidate-specific predictions: filter `personId eq P`

## 7. Map pin projection

Azure Maps does not need a dedicated source-of-truth table. The API/geospatial MCP layer can project map pins from PostgreSQL JSONB records, artifact metadata, and/or Azure AI Search records that include location metadata.

Suggested `MapPin` shape:

- `id`
- `tenantId`
- `personId`
- `sourceType`
- `sourceId`
- `label`
- `summary`
- `latitude`, `longitude`
- `locationPrecision`
- `locationConfidence`
- `eventDate` or date window
- `evidenceFactVersionIds[]`
- `evidenceSourceDocumentIds[]`

Query patterns:

- candidate map: `personId eq P`
- event map: filter by `eventType`, date window, and confidence
- relationship map: filter by relationship type and source evidence
- global recruiter map: tenant-scoped pins with clustering in the UI

## 8. Tokenization and normalization

- Ensure consistent normalization for:
  - employer names
  - dates
  - person names
  - event names and conference aliases
  - recurrence keys
  - city/region/country names
  - location precision levels
- Use consistent bulletText formatting to improve hybrid search relevance.

---

# Future: vector search

MVP can remain keyword-only. For better semantic retrieval:

- generate embeddings for bulletText/commentText
- generate embeddings for event rationale and event descriptions
- add vector fields and hybrid query.
