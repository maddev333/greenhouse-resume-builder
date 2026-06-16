# MVP Ontology: Resume Facts, Sections, Entities, and Relationships

## 1. Why an ontology?
Agents need a stable vocabulary so extracted facts can be:
- versioned and diffed
- rendered into bullet text consistently
- searched across all resumes
- used for relationship inference
- used for temporal pattern detection and future-event prediction

## 2. Core classes
- **Person**
- **SourceDocument**
- **ExtractionRun**
- **FactVersion** (versioned extracted fact)
- **BulletMapping** (rendered bullet text with citations)
- **Annotation** (comment anchored to FactVersion)
- **Relationship** (edge between persons)
- **TemporalEvent** (observed dated candidate activity)
- **EventPattern** (recurring or sequential pattern derived from observed events)
- **EventPrediction** (future event hypothesis with confidence and evidence)
- **RecruiterAlert** (notification/review item derived from a prediction or risk)
- **ResumeSection** (UI grouping; also used to route section agents)

## 3. Sections (MVP minimum)
Recommend starting with these section agents:
- `summary`
- `experience` (employment)
- `skills`
- `education`

## 4. FactKey patterns (typed, namespace-style)
Choose fact keys that map to stable structure in agents.

### Employment
- `employment.employer_name`
- `employment.title`
- `employment.start_date`
- `employment.end_date`
- `employment.location` (optional)

### Education
- `education.school_name`
- `education.degree`
- `education.field_of_study` (optional)
- `education.graduation_date` (optional)

### Skills
- `skills.skill_name`
- `skills.proficiency` (optional)

### Summary bullets (if you treat bullet as a fact)
- `summary.bullet` (optional; alternative is to store structured facts and assemble bulletText)

### Temporal events
Use temporal keys when a source describes a dated activity that may contribute to patterns.

Conference and speaking:
- `event.conference.name`
- `event.conference.presentation_title`
- `event.conference.role` (speaker, panelist, keynote, organizer, attendee)
- `event.conference.date`
- `event.conference.location`
- `event.conference.organizer`

Publications and media:
- `event.publication.title`
- `event.publication.publisher`
- `event.publication.date`
- `event.media_appearance.outlet`
- `event.media_appearance.date`

Credentials and milestones:
- `event.certification.name`
- `event.certification.issued_date`
- `event.certification.expires_date`
- `event.award.name`
- `event.award.date`
- `event.role_change.effective_date`

Temporal normalization:
- `event.normalized_event_key`
- `event.recurrence_key`
- `event.temporal_granularity`

## 5. Relationship types
Inferred (MVP) edges:
- `shared_employer`
- `worked_together` (optional; infer using date overlap at same employer)

Suggested by agents; recruiter-confirmable:
- `referenced_by` (optional for web sources, if you implement person co-mention logic)

Explicit recruiter overrides (allowed types):
- `mentor_of`
- `peer_of`
- `referred_by`
- `collaborated_with`

## 6. Temporal pattern types

Observed temporal events are allowed to produce predicted events, but predictions must not be stored as facts.

Pattern types:
- `recurring_event`: same event or event series repeats over time
- `sequence`: one event tends to follow another
- `seasonality`: activity tends to happen in a month/quarter window
- `gap`: expected event has not appeared in the expected window

Cadence values:
- `annual`
- `semiannual`
- `quarterly`
- `monthly`
- `irregular`
- `unknown`

Prediction statuses:
- `suggested`
- `notified`
- `accepted`
- `dismissed`
- `expired`
- `confirmed_by_evidence`

Confidence guidance:
- more observations increases confidence
- tighter date windows increase confidence
- recent observations increase confidence
- direct source evidence increases confidence
- stale evidence, skipped cycles, or weak event-name matching reduce confidence

Example:
```text
Observed:
  2022-09: Presented at ContosoConf
  2023-09: Presented at ContosoConf
  2024-10: Presented at ContosoConf

Pattern:
  eventType: conference_presentation
  cadence: annual
  monthWindow: September-October

Prediction:
  "Likely to present at ContosoConf next fall"
  predictedWindow: 2025-09-01 to 2025-10-31
  confidenceBand: medium/high depending on source quality and recency
```

## 7. Evidence model (for citations + inference)
Each FactVersion stores:
- `extractionRunId`
- `sourceDocumentIds[]` (evidence references)

BulletMapping stores:
- `citationFactVersionIds[]`
- `citationSourceDocumentIds[]`

Relationship stores:
- `evidenceFactVersionIds[]`
- `evidenceSourceDocumentIds[]`

TemporalEvent stores:
- `sourceFactVersionIds[]`
- `sourceDocumentIds[]`

EventPrediction stores:
- `eventPatternId`
- `evidenceTemporalEventIds[]`
- `evidenceFactVersionIds[]`
- `evidenceSourceDocumentIds[]`
- `rationale`

## 8. Diff identity rules (so normalization is stable)
For diffs, normalize values to a canonical form.
- employerName normalization:
  - trim, lowercase, remove punctuation variants
- dates normalization:
  - store year/month when possible
- strings normalization:
  - whitespace collapse
- event key normalization:
  - lowercase event name
  - remove year-specific suffixes when building recurrence keys
  - normalize conference abbreviations and common aliases where known

Then compute changes using stable comparison keys.
