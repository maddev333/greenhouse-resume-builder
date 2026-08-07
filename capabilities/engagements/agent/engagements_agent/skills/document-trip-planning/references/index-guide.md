# Index Guide

Update this file when the corpus naming conventions or source inventory changes. It is procedural
guidance, not evidence; every trip fact still has to come from `search_grounding` hits.

## Source Inventory

The expected corpus may include event programs, exhibitor directories, speaker biographies,
attendee or organization profiles, agenda documents, venue guides, and approved engagement briefs.

Structured JSON documents may encode joins rather than repeat names. In the current corpus:

- event records can expose `attendingContactIds` and `exhibitorProspectIds`;
- contact records expose `id`, `topicIds`, `smeAreas`, `location`, `status`, and `source`;
- topic records map `topicIds` to names and related terminology.

Resolve those IDs with follow-up searches. An event roster link proves event presence; a matching
topic or nearby location alone does not.

## Query Recipe

Search each evidence class independently rather than asking one broad question:

1. `EVENT NAME dates venue city`
2. `EVENT NAME attendingContactIds exhibitorProspectIds speakers attendees`
3. ALL exact roster IDs returned by step 2 in one query plus `contacts topicIds smeAreas`
4. `EVENT DESTINATION regions aliases` to resolve the region record
5. `REGION ID REGION NAME ALL REGION ALIASES TOPIC ID contacts topicIds smeAreas`
6. `EVENT NAME agenda TOPIC session booth speaker meeting time`
7. All shortlisted names in one query with the event name; query one name separately only when
   needed to resolve an ambiguity

For steps 3 and 5, set `maxPerParent` high enough to retrieve several record chunks from the same
JSON or CSV parent. Keep the default of one for prose-document and agenda searches, where source
diversity is more useful.

Include both acronyms and expanded terms. For UAS, useful query variants include `UAS`, `drone`,
`unmanned aircraft systems`, `autonomy`, and `counter-UAS` when they match the user's topic.

For event trips, return two clearly separated classes when the evidence supports them:

1. **On-site targets** whose IDs or names are explicitly linked to the event.
2. **Regional add-ons** whose topic and destination-area location are documented but whose event
   attendance is not.

For the National Capital Region, include the indexed aliases `NCR`, `DC`, `DC metro`, `Washington`,
`Washington DC`, and `DMV` in the regional contact query. Do not hard-code candidate names; retrieve
them from the matching contact passages.

Before combining records, check event years and dates for conflicts. Preserve a conflict as a gap
rather than assuming two differently dated records refer to the same event occurrence.

Do not apply an OData filter unless this guide is updated with a filterable field and an exact
allowed value from the deployed index schema.
