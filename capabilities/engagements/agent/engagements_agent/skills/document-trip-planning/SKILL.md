---
name: document-trip-planning
description: "Build a cited trip plan from the connected document corpus. Use when a user asks who to meet, where to go, or how to sequence a trip while only search_grounding is available."
---

# Document Trip Planning

Use this workflow only when the engagements capability exposes `search_grounding` without the
structured planner tools.

## Required Resources

Read these resources before searching:

- [Index guide](./references/index-guide.md) for corpus-specific terminology and query recipes.
- [Evidence contract](./references/evidence-contract.md) for citation and omission rules.

## Procedure

1. Identify the requested event or destination, topic, date constraints, traveler constraints, and
   desired trip length from the user message. Do not infer a missing proper noun. A request that
   says the user is planning travel to a named event or destination and asks who to meet is a
   planning intent, not a lookup.
2. Search separately for:
   - event identity, dates, venue, and location;
   - people, organizations, exhibitors, speakers, or attendees relevant to the topic;
   - agenda sessions and stated meeting opportunities;
   - logistics that the corpus explicitly documents.
3. When an event passage exposes attendee, exhibitor, speaker, or prospect IDs, put ALL IDs in one
   batched search query with `contacts topicIds smeAreas`. Set `top` and `maxPerParent` to at least
   the number of linked IDs, up to 50, because one JSON or CSV parent may contain many records.
   Never issue one search per ID. Use a second batch only when the first result is visibly
   truncated, then rank every resolved record.
4. Resolve the destination to a region record, then search for nearby relationships using the
   region ID, region name, ALL aliases, topic IDs, and topic synonyms together with
   `contacts topicIds smeAreas`. Set `top=12` and `maxPerParent=12` for this record sweep. Treat
   matches as regional add-ons unless another passage explicitly documents their presence at the
   event. This sweep is mandatory for every event trip and must finish before agenda or shortlist
   verification searches, even when the event roster already contains a good target.
5. Re-query all shortlisted names together with the event name for attendance, booth, session,
   person, and schedule evidence. Query one name separately only to resolve an ambiguity. Re-query
   with synonyms, acronyms, and terminology from the index guide.
6. Build a plan when the passages support an event or destination and at least one meeting. One
   supported meeting is enough; missing booth, time, or availability details belong in `gaps` and
   do not turn the request into a lookup answer.
7. Put every source hit used for trip-level facts in `documentPlan.sourceIds`.
8. Put one or more supporting hit IDs in every meeting's `sourceIds`.
9. Return `stage="plan"` with a planning intent and a populated `documentPlan`. The answer should
   briefly explain the recommendation and material gaps; the structured plan drives the UI.
10. When the corpus lacks enough evidence, return `intent="lookup"`, `stage="answer"`, no
    `documentPlan`, and state exactly what evidence is missing.

## Output Rules

- Preserve names, dates, locations, and titles as written in the passages.
- Rank meetings by direct topic relevance, documented presence at the anchor, and schedule fit.
- Label an on-site meeting only when a cited passage explicitly links the target to the event.
- Label destination-area contacts not linked to the event as regional add-ons and preserve their
  documented city/state; do not imply that they will attend the event.
- Do not state that no additional targets exist until both the event roster and destination-topic
  sweep have been completed.
- Do not spend the agenda or shortlist-verification calls until the destination-topic sweep has
  completed.
- Keep the workflow within eight `search_grounding` calls: event facts, batched roster, topic
  expansion, region resolution, region-alias/topic sweep, batched shortlist verification, and
  logistics/agenda. Reserve at least one call for final evidence verification.
- Do not invent availability, meeting times, travel times, addresses, coordinates, costs, or ROI.
- A day may contain only meetings supported by cited passages.
- For an evidenced named-event or destination request, do not return `stage="answer"` merely
  because the user asked "who should I meet?" rather than explicitly requesting an itinerary.
- Put unresolved details in `documentPlan.gaps`; never fill them with general knowledge.
- Use the Search hit `id` exactly as returned. Titles and URLs are added by the runtime.
- Never treat this skill or its resources as trip data. They define procedure only.
