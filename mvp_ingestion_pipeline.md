# MVP Ingestion & Agentic Extraction Pipeline

## 1. Pipeline overview
The ingestion pipeline is async, versioned, evidence-grounded, and human-reviewable.

### Entry point
`POST /api/v1/ingestion-requests` (web API)
- stores an `ExtractionRun`
- creates `SourceDocument` entries
- kicks off Durable orchestration with `runId`

## 2. Durable Functions orchestrator
**Orchestrator:** `IngestCandidateOrchestrator(runId)`

The orchestrator should only coordinate activities. All side effects belong in activities:
- model calls
- HTTP fetches
- Blob Storage writes
- Document Intelligence calls
- Cosmos DB writes
- Azure AI Search indexing

## 3. Agentic workflow diagram

```text
Ingestion request
      |
      v
+-----------------------------+
| ExtractionRun + SourceDocs   |
+-------------+---------------+
              |
              v
+-------------------------------------------------------------+
| Durable Orchestrator                                        |
|                                                             |
|  SourceTriageAgent                                          |
|    - classify URL/upload/source type                        |
|    - detect duplicate or unsupported sources                |
|    - choose extraction route                                |
|                                                             |
|  AcquisitionAgents                                          |
|    - FetchAndSnapshotWebSources                             |
|    - StoreUploadsAndExtract                                 |
|    - Document Intelligence extraction                       |
|                                                             |
|  NormalizeText                                              |
|    - clean text                                             |
|    - detect section-like blocks                             |
|                                                             |
|  Parallel EvidenceExtractionAgents                          |
|    - ExperienceAgent                                        |
|    - SkillsAgent                                            |
|    - EducationAgent                                         |
|    - SummaryAgent                                           |
|                                                             |
|  CitationGuardAgent                                         |
|    - verify evidence coverage                               |
|    - flag unsupported facts/bullets                         |
|                                                             |
|  ConflictQualityAgent                                       |
|    - compare with prior facts                               |
|    - flag contradictions and low confidence                 |
|                                                             |
|  PersonResolverAgent                                        |
|    - match existing Person                                  |
|    - return review candidates if ambiguous                  |
|                                                             |
|  ResumeBuilderAgent                                         |
|    - create cited bullets                                   |
|    - preserve bullet signatures for diffs                   |
|                                                             |
|  RelationshipAgent                                          |
|    - suggest evidence-backed relationships                  |
|                                                             |
|  TemporalEventAgent                                         |
|    - extract dated events from facts/sources                 |
|                                                             |
|  TemporalPatternAgent                                       |
|    - detect recurrence/seasonality/sequences                |
|                                                             |
|  EventPredictionAgent                                       |
|    - predict likely future events with confidence           |
|                                                             |
|  RecruiterAlertAgent                                        |
|    - create actionable recruiter notifications              |
|                                                             |
|  PersistBuilderOutput + UpdateSearchIndexes                 |
+-------------------------------------------------------------+
              |
              v
+-----------------------------+        +----------------------+
| Cosmos DB                   |        | Azure AI Search      |
| - facts                     |        | - facts/bullets      |
| - bullets                   |        | - relationships      |
| - annotations               |        | - annotations        |
| - relationships             |        +----------------------+
| - temporal events           |
| - event predictions         |
| - recruiter alerts          |
+-----------------------------+
```

## 4. Activities and richer-agent responsibilities

1. `SourceTriageAgent` *(target new activity)*
   - input: `runId`, source document metadata, content hashes
   - output:
     - source processing plan
     - duplicate/unsupported-source warnings
     - route: web, upload, document intelligence, or manual review

2. `FetchAndSnapshotWebSources`
   - input: web URLs from `SourceDocuments`
   - output:
     - snapshot blob path
     - cleaned raw text
     - source evidence references

3. `StoreUploadsAndExtract`
   - input: upload source documents
   - output:
     - raw blob path
     - Document Intelligence text/layout
     - extracted artifacts

4. `NormalizeText`
   - standardize whitespace
   - identify section-like blocks
   - produce source-aware text chunks for agents

5. `EvidenceExtractionAgents`
   - parallel activities per section:
     - `ExperienceAgent`
     - `SkillsAgent`
     - `EducationAgent`
     - `SummaryAgent`
   - each agent returns:
     - structured facts in ontology terms
     - normalized values
     - confidence scores
     - evidence references
     - temporal metadata when a fact is dated or interval-based
     - warnings/review tasks

6. `CitationGuardAgent` *(target new activity)*
   - verifies every persisted fact and generated bullet has source support where possible
   - produces warnings for unsupported or weakly supported claims

7. `ConflictQualityAgent` *(target new activity)*
   - compares current facts with prior latest facts
   - flags contradictory employers, titles, dates, education, or skills
   - creates review tasks for recruiter attention

8. `PersonResolverAgent`
   - system person-entity matching based on:
     - normalized name variants
     - employment patterns
     - similarity to existing People entities
     - source metadata
   - if ambiguous, recruiter selects an existing Person
   - output: final `personId` or review candidates

9. `ResumeBuilderAgent`
   - creates `FactVersions`
   - creates `BulletMappings`
   - preserves citations per bullet
   - includes builder warnings/metrics in the richer target state

10. `RelationshipAgent`
    - MVP inference:
      - `shared_employer`
      - `worked_together` when supported by overlapping employer/date evidence
    - output:
      - `Relationship` edges with `status=suggested`
      - evidence FactVersions and SourceDocuments

11. `TemporalEventAgent` *(target new activity)*
    - extracts observed dated events from section findings and source text
    - examples:
       - conference presentations
       - publications
       - certifications
       - awards
       - role changes
       - education milestones
    - output:
       - `TemporalEvent` records
       - normalized recurrence keys
       - evidence FactVersions and SourceDocuments

12. `TemporalPatternAgent` *(target new activity)*
    - groups TemporalEvents by person and recurrence key
    - detects recurring patterns such as annual conference presentations
    - computes:
       - cadence
       - observed date window
       - occurrence count
       - regularity score
       - recency score
       - confidence
    - output:
       - `EventPattern` records

13. `EventPredictionAgent` *(target new activity)*
    - predicts likely future events from EventPatterns
    - outputs:
       - predicted event name/type
       - predicted date window
       - confidence score and confidence band
       - rationale
       - evidence links
       - expiration/review window

14. `RecruiterAlertAgent` *(target new activity)*
    - creates recruiter-facing alerts only when predictions are actionable
    - suggested MVP behavior:
       - alert for medium/high confidence predictions
       - keep low confidence predictions searchable but not proactively alerted
       - avoid repeating alerts that a recruiter dismissed

15. `PersistBuilderOutput`
    - writes facts, bullets, warnings/review-task outputs as applicable
    - keeps all persistence outside the orchestrator replay boundary

16. `UpdateSearchIndexes`
    - upserts facts/bullets
    - upserts annotations when changed
    - upserts relationships for entity/edge search
    - upserts temporal events and event predictions

## 5. Agent output shape
Every richer agent should return a schema-compatible payload:

```text
AgentResult
  agentName
  runId
  status: succeeded | partial | failed
  findings[]
    sectionId
    factKey
    factValue
    normalizedValue
    confidence
    evidenceRefs[]
    temporal
      eventDate
      startDate
      endDate
      temporalGranularity
  warnings[]
  reviewTasks[]
  metrics
```

Temporal prediction output:
```text
EventPrediction
  predictedEventType
  predictedEventName
  predictedWindowStart
  predictedWindowEnd
  confidence
  confidenceBand: low | medium | high
  rationale
  evidenceTemporalEventIds[]
  evidenceFactVersionIds[]
  evidenceSourceDocumentIds[]
  status: suggested | notified | accepted | dismissed | expired | confirmed_by_evidence
```

## 6. Diff strategy
MVP recommended: **bullet-level diffs**.

For each `personId + sectionId`:
- get previous latest bullet set
- compare by `bulletSignature`
- classify bullets as:
  - added
  - removed
  - changed (bulletText or citations changed)

## 7. Evidence & citations
- Each `FactVersion` references `sourceDocumentIds[]`.
- BulletMappings store:
  - `citationFactVersionIds[]`
  - `citationSourceDocumentIds[]`
- Inferred relationships should store:
  - `evidenceFactVersionIds[]`
  - `evidenceSourceDocumentIds[]`
- Explicit recruiter-created relationships should store audit metadata and should not be overwritten by future inference.
- TemporalEvents store observed dated activity.
- EventPredictions store likely future activity and must not be treated as observed facts.

Resume UI uses BulletMappings to render each bullet plus citations.

## 8. Temporal prediction strategy

MVP recommended: **pattern-based prediction with transparent confidence**, not black-box forecasting.

For each `personId + recurrenceKey`:
- collect observed `TemporalEvents`
- require at least two observations before creating a recurring pattern
- estimate cadence:
  - annual if events appear roughly once per year
  - seasonality if events cluster in the same month/quarter
  - irregular if cadence is weak
- compute confidence from:
  - occurrence count
  - date-window consistency
  - recency
  - source quality/evidence strength
  - event-name normalization strength
- create predictions only when confidence crosses a configured threshold
- generate recruiter alerts only for actionable medium/high predictions

Example:
```text
Observed events:
  2022: Presented at ContosoConf
  2023: Presented at ContosoConf
  2024: Presented at ContosoConf

Detected pattern:
  annual conference presentation
  typical window: September-October

Prediction:
  Candidate may present at ContosoConf in fall 2025
  confidence: 0.72
  rationale: observed three recent annual presentations at the same conference series
```

## 9. Failure handling
- Every activity can update or contribute to `ExtractionRun.status`.
- Durable Functions retry transient failures.
- Agent validation failures should be visible as warnings/review tasks.
- Persist failures should be logged for observability.
- Model-agent failures should not silently turn into trusted facts.
- Prediction failures should not block fact/bullet persistence; they should create warnings or be retried separately.

---

# Web vs upload extraction notes
- Uploads use Document Intelligence.
- Public web sources:
  - use snapshot capture + text cleaning pipeline
  - optionally re-run Document Intelligence if you convert snapshots into document-like input
- MVP can still run with deterministic heuristic agents, but richer agents should use the same activity contracts.
