# Area-First, Optioned Engagement Planning — Design

## Status
Phases 0–2 implemented (schema/data, geo anchor + survey, leader selection). Phases 3–5 proposed.
See "Implementation Roadmap" for the shipped vs. pending breakdown.

## Purpose
Today the planner runs **one** direction: given a **leader** and an **event anchor**, it ranks *who*
to meet. This design adds the **inverse, area-first** direction and makes the whole planner
**optioned along multiple axes**:

1. **Geo anchor** — start from a **geographic area** (city / state / named region + a date window),
   with **no event required**.
2. **Topics-in-area** — survey *what topics are present* in that area for the caller.
3. **Leader selection** — recommend *which senior leader should go* (ranked, not an input).
4. **Duration** — recommend *how long* the trip should be, derived from the actual stops.
5. **Extension options** — *"extend by 1 day and you can also meet this **industry / academic /
   political** entity on this topic — here are the Army talking points."*

Because the answer depends on many competing factors, the planner **always returns options**, never a
single forced plan — consistent with the repo's *"advisor, not optimizer; the human decides"*
principle (`engagement-intelligence/ARCHITECTURE.md` §1, §6).

## Relationship to the existing repo
This is **additive** — it reuses the deterministic engine primitives and the server-side security
trim, and it keeps the existing event-anchored flow intact:

- Engine primitives (all reused): `haversineKm` / `etaMinutes`
  (`capabilities/engagements/mcp/engagements/src/planner/distance.ts`), `suggestionScore`
  (`.../planner/score.ts`), `planRoute` (`.../planner/route.ts`), `tripRoi` (`.../planner/roi.ts`),
  the five conflict detectors (`.../planner/conflicts.ts`), and the **already event-optional**
  `Anchor` (`.../planner/types.ts`) + `suggest()` (`.../planner/suggest.ts`, which handles the
  no-event case by sourcing nearby off-site contacts only).
- Security trim (reused unchanged): `buildFactSecurityFilter` in
  `capabilities/mcp-core/src/security.ts`; demo personas via the `x-demo-persona` header
  (`.../mcp/engagements/src/tools.ts`).
- Talking points (reused): `Topic.approvedMessageId` → `Message.intendedPoints`
  (`engagement-intelligence/seed/{topics,messages}.json`).

### Two current limitations this design removes
1. **Event-only anchoring.** `runSuggest` (`.../mcp/engagements/src/tools.ts`) always resolves an
   event (`resolveEvent` → `anchorFromEvent`) and errors *"No authorized anchor event matched"* when
   none is given. There is no geo/region anchor and no region→coordinate resolver.
2. **Duration is a fixed echo of the event window.** `build_itinerary` computes
   `days = daysBetween(event.start, event.end) + 1` — the anchor **event's** length. Off-site stops
   never extend it, and no duration is *recommended*.

## Goals
- Anchor planning on a **geographic area + window** with no event required.
- Return, for that area, a **topic survey**, **ranked leader options**, **recommended duration
  option(s)**, and **marginal "+N-day" extension options** — each with transparent, tunable factors.
- Attach the **approved Army talking points** to every recommended topic/stop (degrading gracefully
  when a topic has no approved message).
- Keep everything **security-trimmed server-side** and **advisory** (never a hard block; always
  options).
- Stay **offline-reliable** (no live geocode on the demo path — pre-resolved area centroids, per
  ARCHITECTURE.md §1).

## Non-Goals
- No route optimizer beyond the existing greedy nearest-neighbor (`planRoute`); a 2-opt pass remains
  future work.
- No change to the shared security model or the tenant/ACL/sensitivity trim.
- No live Microsoft Graph / calendar personalization — that is the separate
  [`personal-context-and-engagement-intelligence-design.md`](personal-context-and-engagement-intelligence-design.md)
  (the two compose: personal context re-ranks *within* the options this design produces, never
  widening access).
- No removal of the existing leader+event flow; area-first is an added path.

## Design Principles
1. **Advisor, not optimizer.** Every axis returns ranked **options** with visible factors; the human
   picks. Fit/duration/leader are **advisory**, never hard filters (mirrors `detectFit` = soft).
2. **Deterministic core, LLM at the edges.** Area resolution, topic aggregation, leader scoring,
   duration, and extension math are pure, unit-testable functions. The LLM only narrates and
   composes — never computes feasibility or authorization.
3. **Reuse the primitives.** New capabilities are thin compositions of existing distance/score/
   route/roi/conflict functions.
4. **Security-trimmed first.** Topic survey, leader options, and candidates are all computed over the
   caller's **already-trimmed** authorized set.
5. **Show your math.** Each option exposes its factors (proximity, topic fit, availability, budget,
   marginal ROI) the way `ScoreFactors` does today.

## Schema Additions

### 1. `Contact.sector` (new) — the industry/academic/political label
`Contact.type` today is only `company | individual | org` (`engagement-intelligence/seed/schema.ts`),
which can't express "industry vs academic vs political." Add a structured, optional enum:

```ts
export type Sector =
  | 'industry'      // defense primes, startups, commercial vendors
  | 'academic'      // universities, labs, FFRDCs, think tanks
  | 'political'     // legislative / policy / elected offices & staff
  | 'government'    // other federal/state/local government
  | 'nonprofit'     // associations, NGOs, foundations
  | 'international'; // foreign gov / multinational / allied partners

export interface Contact extends BaseEntity {
  // …existing fields…
  sector?: Sector;  // NEW — drives the "meet this <sector> entity" option label + optional filter
}
```

- **Backfill** the ~23 seed contacts with a `sector` value (see Open Questions on defaults).
- Exposed as a **filterable trim/behavior facet** in the AI Search envelope (ARCHITECTURE.md §16.3),
  so a caller can optionally narrow "show me academic partners on zero-trust."

### 2. Area gazetteer (new, seed-time) — offline geo anchoring
To keep the demo offline (ARCHITECTURE.md §1, "pre-geocoded once at seed time"), add a small
`regions.json` mapping named areas + cities/states to a pre-resolved centroid + default radius:

```ts
export interface Region extends BaseEntity {
  id: string;                 // e.g. "R-NCR"
  name: string;               // "National Capital Region"
  aliases?: string[];         // ["NCR", "DC metro", "Washington DC"]
  centroid: GeoPoint;         // pre-resolved lat/lng
  defaultRadiusKm: number;    // e.g. 120
}
```

A city/state anchor with no matching region resolves to that city's `GeoPoint` (already present on
contacts/events) + a default radius.

### 3. (Data) Approved messages for T3 & T4
T3 (innovation) and T4 (STEM) have `approvedMessageId: null`, so the talking-points slot is empty for
them. Either add approved `Message`s or let the option degrade to *"no approved message — coordinate
with `{Topic.ownerOrg}`."* (Open Question.)

## New / Changed Capabilities

### A. Geo anchor (area-first)
- **New:** `anchorFromArea(area, window)` alongside `anchorFromEvent`, producing the existing
  event-optional `Anchor { location, window, topicIds? }`.
- **Area resolution:** `resolveArea(input)` → `{ centroid, radiusKm, window }` from a region id/alias,
  or a city/state, using the gazetteer (no live geocode).
- **Event auto-absorption:** when an area anchor is used, any **authorized events within
  radius+window** are pulled in as sub-anchors, so on-site **attendees** and exhibitor **prospects**
  are recovered (otherwise an event-less anchor yields only nearby off-site contacts — see
  `suggest.ts`). This makes "just an area" as rich as "an event."
- **Tool:** extend `suggest_candidates` (and `build_itinerary`) to accept **either** an `area`
  (region/city + optional `radiusKm` + `window`) **or** the existing `eventId`/`eventQuery`.
  `leaderId` becomes **optional** here (see Leader selection).

### B. Topics-in-area (the "what's here" survey)
- **New:** `topicsInArea({ centroid, radiusKm, window, contacts, events, ctx })` → for each topic
  present among the caller's **authorized** contacts/events in range:
  `{ topicId, name, domain, contactCount, prospectCount, sumStrategicValue, staleCount,
     hasApprovedMessage, ownerOrg }`, ranked by opportunity (Σ strategic value × staleness).
- **Tool:** `survey_area` → returns the **topic menu** for the area ("here's what you'd go for").
- Fully security-trimmed: only authorized records are counted.

### C. Leader selection (recommend who should go)
- **New:** `suggestLeaders({ area, topicIds, window, leaders, contacts })` → ranks the caller's leader
  roster by a transparent `leaderFitScore` = weighted sum of:
  | Factor | Source | Intent |
  | ------ | ------ | ------ |
  | topic / SME match | `leader.smeAreas ∩ Topic.smeAreas`, `leader.domain == topic.domain` | right expertise |
  | proximity | `haversineKm(leader.homeBase, centroid)` (inverted) | less travel |
  | availability overlap | `leader.availability` vs `window` | can actually go |
  | budget headroom | `leader.daysAwayBudget` vs estimated duration | fits their budget |
  | level appropriateness | `leader.level` vs the area's top contacts' `level` | seniority match |
- Returns **ranked leader options** with per-factor breakdown (show-your-math). **Advisory** — a
  domain/level mismatch is a soft badge (reuse `fitFlags`/`detectFit`), never an exclusion.
- **Tool:** `suggest_leaders`. When `leaderId` is omitted from `suggest_candidates`, the top-ranked
  leader is used as the default *and* the alternatives are returned as options.

### D. Duration recommendation (how long)
- **Replace** `days = event-window` with a **stop-derived** estimate:
  `estimateDuration(route, onSiteEventDays, dwellPerStopMins)` — on-site/conference days +
  off-site legs (`route.totalTravelMins`) + per-stop dwell, bucketed to whole days.
- Present **tiered duration options**, each fully costed via `tripRoi` + checked via
  `detectAvailabilityBudget`:
  - **Core** — on-site + top-N nearest high-value off-site stops (smallest viable trip).
  - **Extended** — Core + additional stops that need +1/+2 days.
- Each option: `{ days, stops[], roi, conflicts[], overBudget }`.

### E. Extension options ("+1 day unlocks…")
- **New:** `extensionOptions(basePlan, { window, radiusKm, contacts, events, ctx })` — marginal
  analysis: for each additional day (and/or wider reachable radius), compute the **newly feasible**
  stops (diff vs the base set), ranked by **marginal ROI** = added Σ score − added cost.
- Each extension option carries, per unlocked stop:
  `{ extraDays, contact: { name, sector }, topic, talkingPoints, marginalRoi, conflicts[] }`
  where `talkingPoints` = `Topic.approvedMessageId` → `Message.intendedPoints`, or the graceful
  "coordinate with `{ownerOrg}`" fallback.
- This is exactly the requested surface: *"extend 1 day → meet this **industry/academic/political**
  entity on this topic; here are the approved talking points."*

## The Optioned Result — `PlanOptions`
A single envelope the agent renders as menus along each axis (the model narrates; it does **not**
compute these):

```ts
interface PlanOptions {
  area: { name; centroid; radiusKm; window };
  areaSurvey: TopicInArea[];        // B — what's here
  leaderOptions: LeaderOption[];     // C — who should go (ranked, with factors)
  durationOptions: DurationOption[]; // D — core vs extended (days, ROI, conflicts)
  extensionOptions: ExtensionOption[]; // E — marginal "+N day" unlocks w/ talking points
  filter: string;                    // the security $filter that ran (audit)
  redactedCount: number;             // trimmed-out count (fail-closed transparency)
}
```

Every list is **ranked and non-empty-by-design where possible**, so the caller always chooses among
options rather than accepting a single plan.

## Worked Example
> *"I want to send someone to the National Capital Region in the third week of October — what are my
> options?"*

1. **Resolve area** → `R-NCR` centroid + 120 km, window `2025-10-13…2025-10-19`; auto-absorb any
   in-area authorized events.
2. **`survey_area`** → topics present: **T1 DIB resilience** (5 contacts, high value, several stale,
   ✅ approved message), **T3 innovation** (prospects present, ⚠️ no approved message), …
3. **`suggest_leaders`** → **MG Whitfield (L1)** ranks #1 (DC home base ≈ 0 km, industrial-base SME,
   available, budget 10d); **LTG Cole (L5)** #2 (DC, strategy). Both returned as options.
4. **Duration** → **Core = 2 days** (2 on-site + 1 nearby stale prime), ROI shown; **Extended = 3
   days**.
5. **Extension** → *"**+1 day** → meet **Meridian Robotics (industry)** on **T1**; talking points:
   'Multi-year contracting stability is coming; prioritize munitions onshoring; no program-dollar
   commitments.'"*

## Alignment with Existing Architecture
| This design | Reuses / relates to |
| ----------- | ------------------- |
| Geo anchor | event-optional `Anchor` + `suggest()` no-event path (`planner/{types,suggest}.ts`); offline seed-time geo (ARCHITECTURE.md §1) |
| Topics-in-area | `Contact.topicIds` / `Event.topicIds`, `haversineKm`, security trim (`mcp-core/security.ts`) |
| Leader selection | `Leader.{smeAreas,domain,homeBase,availability,daysAwayBudget,level}`; `fitFlags`/`detectFit` as soft badges |
| Duration | `planRoute`, `tripRoi`, `detectAvailabilityBudget` (replaces the event-window `days`) |
| Extension options | `suggestionScore` deltas + `tripRoi` marginal; `Topic.approvedMessageId`→`Message.intendedPoints` |
| `PlanOptions` (always options) | "advisor, not optimizer" (ARCHITECTURE.md §1, §6); the existing candidate "menu" pattern, generalized to more axes |
| `sector` facet | AI Search filterable envelope (ARCHITECTURE.md §16.3) |
| Composes with personal context | `personal-context-and-engagement-intelligence-design.md` re-ranks within these options, never widening access |

## Implementation Roadmap
- **Phase 0 — Schema & data:** ✅ **Done.** Added `Contact.sector` (+ backfilled all 23 seed contacts)
  and the `regions.json` gazetteer. (The event-window `days` → stop-derived duration fix is deferred to
  Phase 3; T3/T4 approved messages already exist in seed.)
- **Phase 1 — Geo anchor + survey:** ✅ **Done.** `resolveArea`, `anchorFromArea`, `topicsInArea`, and
  the `survey_area` tool. (Extending `suggest_candidates` to accept an `area` is deferred to Phase 3.)
- **Phase 2 — Leader selection:** ✅ **Done.** `suggestLeaders` + the `suggest_leaders` tool (returns a
  ranked, always-optioned menu). (Making `leaderId` optional on `suggest_candidates` is deferred to Phase 3.)
- **Phase 3 — Duration & extension options:** `estimateDuration`, tiered `durationOptions`,
  `extensionOptions`, and the unified `PlanOptions` result (e.g. a `plan_options` tool). Also folds in the
  deferred `days`-duration fix and the `area`/optional-`leaderId` inputs on `suggest_candidates`.
- **Phase 4 — Agent & UI:** teach the orchestrator to surface the new menus (area survey → leader
  options → duration → extensions) and render talking points inline; map still renders the chosen
  option.
- **Phase 5 — Hardening:** tune leader/extension weights (`weights.ts`), add tests mirroring the
  existing `*.test.ts` suites, optional 2-opt route pass.

## Open Design Questions
- **Leader factor weights** — what's the default priority (proximity vs SME match vs seniority)? Start
  from equal weights in `weights.ts` and tune?
- **Extension granularity** — whole-day increments only, and cap tiers at +2 days?
- **Area sourcing** — should an area anchor auto-absorb *all* in-radius events as sub-anchors, or only
  the top-K by topic relevance?
- **Sector backfill** — confirm the default `sector` for each seed contact (e.g. CSIS→academic,
  TechCorp Defense→industry, Capital Defense Angels→industry/nonprofit?).
- **T3/T4 talking points** — add approved messages now, or ship the graceful "coordinate with owner"
  fallback?
- **Duration model** — fixed dwell-per-stop, or per-`sector`/`level` dwell?

## Recommended Next Steps
1. Approve the `sector` enum + `regions.json` shapes and land them in `shared`/seed.
2. Prototype `topicsInArea` and `suggestLeaders` (pure functions + tests) — they unlock the demo value
   with no cloud dependency.
3. Replace the event-window `days` computation with the stop-derived estimator.
4. Define the `PlanOptions` contract and the agent's menu-rendering order.
5. Review alongside `engagement-intelligence/ARCHITECTURE.md` §6 (planner) and §16 (labeling).

## Summary
This design inverts and generalizes the planner: anchor on a **geographic area**, survey the **topics**
there, recommend **which leader** should go and **for how long**, and always present **options** —
including marginal **"+1 day"** extensions that unlock a specific **industry/academic/political** entity
on a topic, complete with the **approved Army talking points**. It is additive, reuses the existing
deterministic primitives and server-side security trim, and stays advisory: the engine lays out the
trade-offs; the human decides.
