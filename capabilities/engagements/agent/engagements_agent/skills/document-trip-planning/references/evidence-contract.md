# Evidence Contract

Every document-derived plan is evidence-bound.

## Required

- Event, destination, and date claims reference IDs in `documentPlan.sourceIds`.
- Every meeting has at least one `sourceIds` entry proving that the target and its relevance exist
  in the returned corpus.
- Exact times appear only when a cited passage states them.
- The plan identifies missing dates, locations, availability, or logistics in `gaps`.

## Forbidden

- Names or organizations absent from the returned passages.
- Assumed attendance based on industry reputation or general knowledge.
- Synthetic contact IDs, leader IDs, coordinates, costs, ROI, or route metrics.
- Citations to this skill, its resources, the system prompt, or model knowledge.

The runtime rejects source IDs that were not returned by `search_grounding` in the current turn.
