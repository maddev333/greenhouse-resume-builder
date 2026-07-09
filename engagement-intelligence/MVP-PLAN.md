# Strategic Engagements Travel Planner — MVP Demo Plan

> **Status:** DRAFT for review. This document is meant to be edited to match customer
> expectations before we produce the architecture. Sections marked **[CONFIRM]** are open
> questions for the customer; **[ASSUMPTION]** marks a placeholder we chose to keep moving.
>
> **Direction (locked):** The **travel planner is the centerpiece** — it leans on geocoding, the
> one capability in the codebase that is actually live. The pre-brief / message-consistency loop we
> designed earlier survives as a **per-stop supporting feature** inside an itinerary, not the star.

---

## 1. Vision (one sentence)

A strategic engagements travel planner that maximizes senior-leader **mission impact per travel
day** — when a leader is already traveling, it **proactively surfaces nearby events and high-value
contacts** and turns single-purpose trips into feasible **sweeps** ("two birds, one stone") on a live
map, with **per-stop pre-briefs** so every meeting stays on message.

---

## 2. Problem / Current State

Engagement data lives in disconnected Microsoft 365 surfaces, and the scarcest resource — senior-leader
travel time — is allocated blind:

| Surface today         | What it holds                        | Pain                                 |
| --------------------- | ------------------------------------ | ------------------------------------ |
| SharePoint lists      | Contacts + interaction/EXSUM records | No cross-linking, no roll-ups        |
| SharePoint Kanban     | Engagement pipeline stages           | Manual, no conflict/attention logic  |
| PowerPoint "calendar" | Events/functions laid out visually   | Not a real calendar; no availability |
| Outlook calendars     | Actual meetings                      | Siloed per person; not tied to CRM   |

Consequences, framed around travel:

- **Travel is the scarcest senior-leader resource, allocated without a feasibility or ROI check.**
- **Single-purpose trips waste it** — a leader flies cross-country for one meeting while nearby
  high-value, stale contacts go untouched.
- **No one sees the map** — staleness + strategic value + geography are never combined, so we can't
  answer the leadership question: _are we spending travel/attention in a way that moves the mission?_
- Downstream, leaders still walk into individual stops **under-briefed** and the enterprise sends
  **inconsistent messages** — handled by the supporting per-stop layer.

---

## 3. Users & Personas

- **Engagement admin / trip planner** — builds trips, batches stops, resolves conflicts; owns the
  planner. The primary demo actor.
- **Senior leader (principal)** — the scarce, high-value traveler whose time/attention is allocated;
  consumes per-stop pre-briefs. **[CONFIRM]** which echelons/roles are in scope.
- **Comms / strategic-messaging staff** — owns the canonical per-topic "message" (supporting layer).
- **Aide / action officer** — prepares materials, protocol, reviews flags. **[CONFIRM]** exact roles.

---

## 4. Use Cases

### 4.1 PRIMARY — Strategic engagements travel planner

The customer's ⭐ question, made literal: **_Are we allocating senior-leader travel/attention in a
way that moves the mission?_**

The organizing unit is the **Trip**: a leader travels to a region for a date window; **events are
travel anchors** (a reason the leader is already there); the planner **batches** nearby high-value,
stale, well-matched contacts into that trip, then checks **feasibility** and **ROI**.

**Money moment — proactive "you're already going there":** the system sees a leader is headed to
**AUSA in DC, Oct 12–15** and **nudges**: _"You're traveling to DC that week — there's a defense
startup luncheon nearby, and 4 stale, skill-matched, high-value contacts within 50 mi are available.
Stay two extra days and you hit all of them — two birds, one stone. Want me to set up the itinerary?"_
Accept → the planner **batches** the stops, orders and checks them, and the itinerary **densifies on a
map + timeline inside the chat host's engagements widget (Trip tab)** while a live **trip-ROI** score
climbs (1-purpose trip → multi-touch sweep at ~$0 extra airfare). The **extend-the-stay** trade is
quantified against the leader's **days-away budget**.

**Second pattern — "conference-as-magnet":** a large event (e.g., **AUSA Annual** — ~44k attendees,
750+ exhibitors) is a dense gathering of the people we care about. When a leader attends, the planner
surfaces three things at once: (a) **existing contacts also attending** — engage them **on-site at
~zero marginal travel** (they came to you); (b) **new companies / exhibitors** whose profile matches a
**topic of interest** — an **intro** ("initiate", not "re-engage"); and (c) **nearby off-site
companies** worth a short local hop. The output is an **on-site engagement plan** (venue time-slots)
plus optional off-site stops.

The earlier use cases survive as the trip's **justification logic**:

- **Attention allocation ⭐** — **trip-ROI** = Σ(staleness × strategic value × topic-relevance) −
  travel/time/days cost — is the headline metric.
- **Relationship freshness / staleness** — a map heat-signal of cold, high-value relationships; when
  planning a trip, surface stale contacts _near_ the anchor to re-engage.
- **Who to invite** — events are anchors; rank contacts to pull into the trip / event by staleness ×
  strategic value × topic-relevance.
- **Who to drop** — low-value, low-freshness contacts are deprioritized in batching suggestions.

**Conflicts the planner detects (trip feasibility) — all five in MVP:**

| Conflict                                                                                                      | How detected                                     | Recommendation examples                                        |
| ------------------------------------------------------------------------------------------------------------ | ------------------------------------------------ | -------------------------------------------------------------- |
| **Travel infeasible** — can't transit between back-to-back stops in time                                     | geocode both, distance → ETA vs. gap             | re-order stops; drop to a separate sweep; re-anchor to a nearby event window |
| **Opportunity cost / low trip-ROI** — flying far for one low-value stop while a nearby cluster goes unstaffed | low trip-ROI (§5.1): score < travel/time/days cost | batch nearby stale contacts; **fill open conference slots** with attending contacts before flying elsewhere |
| **Fit** — wrong skill/SME/level (e.g., non-technical leader to a technical contact)                          | compare leader SME/level vs. contact requirement | **soft flag** — always allowed; suggest a better-matched leader (human decides) |
| **Double-booking** — overlapping time windows                                                                | date-range overlap                               | shift the stop; reassign                                       |
| **Availability / days-away budget** — outside the leader's window/PTO, or over travel-days budget            | window + budget check                            | pick a feasible slot; split into two trips                    |

**All conflicts are advisory** — the planner flags and recommends; the human always decides. In
particular, **fit never blocks** a suggestion (soft flag everywhere): a mismatched pairing is still
shown, just badged with the recommendation.

### 4.2 SECONDARY (supporting) — Per-stop pre-briefs & message consistency

Each **stop** on an itinerary gets a **pre-brief**: who the contact is, interaction history,
outstanding asks, the topic's **centrally-approved talking points**, and suggested points — with
citations back to source EXSUMs.

The **closed loop** we designed earlier survives here: after a stop, the admin uploads the meeting's
after-action notes (PDF); **Document Intelligence** extracts them; they feed both a
**message-consistency check** (did we convey the intended message? is the enterprise aligned on this
topic?) and the **next** stop's pre-brief.

Delivery: **in-app preview by default**; **optional** real send via Graph `sendMail` to a demo mailbox
(now a stretch, since pre-briefs are no longer the centerpiece — see §10/§11).

---

## 5. Solution Concept — a Trip-centric planner over a CRM spine

```
                         ┌───────────────────────────────┐
                         │            THE TRIP            │
                         │  leader · region · date window │
                         │   stops · legs · ROI · cost    │
                         └───────────────┬───────────────┘
        anchor                           │  batch                        feasibility
   ┌────────────────┐           ┌────────┴────────┐              ┌────────────────────┐
   │  EVENT anchor  │           │ nearby STALE,   │              │ 5-conflict advisor │
   │ (AUSA, lunch)  │           │ high-value,     │              │   + trip-ROI score │
   │ already there  │           │ matched contacts│              │  + days-away budget│
   └────────────────┘           └─────────────────┘              └────────────────────┘
                    ▼  all pinned, clustered, and routed on a live MAP  ▼
   ┌──────────────────────────────────────────────────────────────────────────────────┐
   │                       CRM DATA SPINE (shared, pre-geocoded)                        │
   │   Leaders · Contacts · Engagements/EXSUMs · Events · Message/Talking-points        │
   └──────────────────────────────────────────────────────────────────────────────────┘
                                          ▲
                        SUPPORTING LAYER: per-stop pre-brief & message consistency
                        (summary · Document Intelligence after-action ingest · drift)
```

The planner and the pre-brief layer read/write the **same** contacts, engagements, and events — so a
per-stop pre-brief reflects the trip, and the trip reflects relationship history.

### 5.1 Batching & feasibility (net-new geo logic — the heart of the demo)

The entry point is **proactive**: when a leader's travel or event attendance is known, the planner
auto-runs this flow and **surfaces nearby opportunities as a nudge** before the admin lifts a finger.

```
   ANCHOR = known trip / event attendance / meeting   (auto-detected, or admin picks)
            │
            ▼
   geocode contacts/events  ──►  distance from anchor (haversine)  ──►  rank by:
            │                                          availability + staleness × strategic value ×
            ▼                                          topic-relevance   (fit = soft flag, not filter)
   candidate STOPS  ──►  greedy route ordering (nearest-neighbor)  ──►  legs + ETAs
            │                                                            (mode heuristic; optional
            ▼                                                             Azure Maps Route Matrix)
   5-CONFLICT check + TRIP-ROI  ──►  itinerary on map + timeline  ──►  human accepts / edits
```

**Scoring (transparent, tunable — the planner shows its math):**

- **Suggestion score** (which contacts to surface) = `staleness × strategicValue × topicRelevance`,
  where _topicRelevance_ matches the contact's SME/sector to the trip's purpose / anchor **Topic**.
- **Trip-ROI** = Σ(suggestion score of accepted stops) − (travel + time + extra days-away) cost.
- **Candidate sources** — existing contacts **attending** the anchor event (travel ≈ 0), existing
  contacts **nearby** the venue, and topic-matched **prospects** (new companies / exhibitors). Each is
  tagged `re-engage | initiate` and `on-site | off-site`.

### 5.2 The per-stop closed loop (supporting layer — retained from prior plan)

Every meeting is anchored to a **Topic** and a **specific intended Message that must be conveyed**.

```
   Topic + intended MESSAGE (what must be conveyed)
            │
            ▼
   ┌──────────────┐   built from prior     ┌────────────────────┐
   │  PRE-BRIEF   │◀───────────────────────│ after-action notes  │
   │ (per stop)   │                        │  (history/context)  │
   └──────┬───────┘                        └─────────▲──────────┘
          │  meeting happens                         │ Document Intelligence
          ▼                                          │ ingests the PDF
   ┌──────────────┐   after-action notes   ┌─────────┴──────────┐
   │  THE STOP    │───────────────────────▶│ AFTER-ACTION /      │
   └──────────────┘   (PDF / feedback)     │ FEEDBACK CAPTURE    │
                                           └─────────┬──────────┘
                                                     ▼
                          ┌────────────────────────────────────────┐
                          │ MESSAGE-CONSISTENCY CHECK               │
                          │ Did we convey the intended message?     │
                          │ Is the enterprise aligned on this topic?│
                          └───────────────────┬────────────────────┘
                                              ▼  feeds the NEXT stop's pre-brief (loop closes)
```

---

## 6. Core Data Model (demo scope)

> Naming is deliberately generic so it fits the customer's terms after editing. In the recruiting
> analogy we explored: **Leader ≈ recruiter**, **Contact ≈ target**.

**Planner core (net-new):**

- **Trip**: `id, leaderId, purpose, region, window{start,end}, homeBase{city,lat,lng}, anchorEventId?, stopIds[], legIds[], estCost, roiScore, status(draft|proposed|approved|complete)`
- **Stop**: `id, tripId, refType(engagement|event), refId, location{city,lat,lng}, arrive, depart, dwellMins, preBriefId?`
- **Leg**: `id, tripId, fromStopId, toStopId, mode(air|ground), distanceKm, estTravelMins, cost`

**CRM spine:**

- **Leader** (Pool A): `id, name, role/echelon, smeAreas[], level, homeBase{city,lat,lng}, availability[{start,end}], daysAwayBudget`
- **Contact** (Pool B): `id, name, type(individual|company|org), org, sector/smeAreas[], level, location{city,lat,lng}, relationshipOwners[], strategicValue, lastInteractionDate, status(active|prospect), source` — **prospects** (new companies) have no `lastInteractionDate` (never engaged); score them by topic-fit × estimated value (the **initiate** path).
- **Event**: `id, name, type(conference|convention|function), location{city,lat,lng}, start, end, targetAttendeeProfile, attendingContactIds[], exhibitorProspectIds[], topicIds[]` (topics present) — a **travel anchor** and an **attendee/exhibitor magnet** (contacts & prospects present).
- **Engagement / Meeting**: `id, contactId, leaderIds[], topicId, intendedMessageId, date/window, location, status(scheduled|held|followup), tripId?, anchorEventId?, preBriefId?, afterActionNoteIds[], messageConveyedScore?, commitments[], outcomes`

**Supporting (per-stop pre-brief / message loop):**

- **Topic**: `id, name, description, ownerOrg` — the subject each meeting is anchored to.
- **Message / Talking Points**: `id, topicId, version, intendedPoints[], effectiveDates, approvedBy, status(draft|approved)` — the **centrally-approved, per-topic** message that **must be conveyed**; every meeting on the topic inherits it (no per-meeting authoring).
- **AfterActionNote** (ingested via Document Intelligence): `id, engagementId, sourceDocId, extractedSummary, actualMessagePoints[], commitments[], sentiment/feedback`.
- **Pre-Brief** (generated; preview or emailed): `stopId/engagementId, recipientLeaderIds[], channel(preview|email), emailSubject?, emailBody?, generatedAt, sentAt?, contactSummary, interactionHistory[], outstandingAsks[], intendedMessage, suggestedTalkingPoints[], flags[], citations[]`.

**Geocoding note:** every `location{lat,lng}` is populated by the **live** Azure Maps geocoder
(`geocode` / `project_map_pins`) at **seed time** and cached, so the demo runs offline and reliably.

**Scoring inputs:** _staleness_ from `Contact.lastInteractionDate`; _strategic value_ from
`Contact.strategicValue`; _topic-relevance_ from `Contact.smeAreas/sector` matched to the trip's
purpose / anchor **Topic**. These three combine into the suggestion score and trip-ROI (§5.1). For
contacts **attending** the anchor event, **travel cost ≈ 0** (they came to you), which sharply raises
engage-at-event ROI; **prospects** substitute an _untapped_ signal for staleness (never engaged +
high topic-fit = high **initiate** opportunity).

**Governance (decided):** the intended message is a **central, comms-approved library — one per
topic**; `Engagement.intendedMessageId` snapshots the approved version in effect at meeting time, so
drift is measured against exactly what was current.

**[CONFIRM]** real EXSUM/after-action format, leader home bases + days-away budgets, and that an
approved per-topic talking-points library exists (and who approves it).

### 6.1 Data-source seam (adapters)

The planner and pre-brief engines never talk to a data source directly — they consume the normalized
records above. Sources plug in behind one adapter interface, so mock and real data are interchangeable:

- **MockAdapter** — scripted, **pre-geocoded** JSON scenarios (Day-1 scaffold; unblocks the team).
- **PdfDocIntelAdapter** — real after-action PDF → **Document Intelligence** → extraction → records.
- **SharePointListAdapter** — Graph read of a list → column mapping → records _(stretch)_.
- **CalendarAdapter** — upcoming-meeting / event feed: **Outlook via Graph** (real) or a seeded feed
  (demo). Feeds both trip anchors and pre-brief triggers.

Delivery is symmetric: a **pre-brief renderer** turns records into a preview or an email; **optional**
real send via Graph `sendMail` to a demo mailbox (requires an Entra app registration with Mail.Send).

---

## 7. Feature Breakdown

### Layer 1 — Travel planner (primary)

- **Nearby-opportunities nudge (proactive)** — when a leader's travel/event attendance is known, the
  planner surfaces nearby **events** and **stale, high-value, matched contacts**, quantifies an
  **extend-the-stay** trade ("stay +2 days → +3 high-value touches"), and offers a one-click **"Build
  itinerary."** This is the demo's entry point. Delivered as a **tool result in the chat thread** —
  the host's model narrates and the **engagements widget (Trip tab)** renders the nudge; **the chat UI
  is the interface**, not a stretch.
- **Conference roster** (+ light prospecting) — for an **event anchor**, list existing **contacts
  attending** (engage **on-site**, ~zero travel) and build an **on-site slot plan** across the event
  days; **secondarily**, surface a few topic-matched **exhibitor prospects** (new companies) as a
  one-line **"want intros?"** add-on.
- **Map surface** — home bases, contacts (colored by staleness × strategic value), event anchors, and
  drawn **trip legs**. _(Reuses the existing `MapView` + `project_map_pins`.)_
- **Trip builder** — pick a leader + an **anchor** (event or seed meeting) + window → the planner
  **suggests a batch** of nearby, matched, stale, high-value contacts to add as stops.
- **Distance + route ordering** — haversine distance from lat/lng; **greedy nearest-neighbor** stop
  ordering (advisory); a mode heuristic (ground under ~X mi, else air). **Optional** Azure Maps
  **Route Matrix** upgrade for real drive-times (same account/key).
- **5-conflict feasibility advisor** — inline badges + a side panel of **recommendations** (travel,
  ROI, fit, double-book, availability/budget).
- **Trip-ROI score** — Σ(staleness × strategic value × topic-relevance) − travel/time/days cost;
  **days-away budget** check. The planner **shows the math**.
- **Staleness / attention** scoring and **who-to-invite** ranking for the anchor event.

### Layer 2 — Per-stop pre-brief & message consistency (supporting)

- **Per-stop pre-brief** — for a selected stop, assemble contact background + interaction history +
  the topic's **approved talking points** + outstanding asks, with citations. _(Reuses the summary
  engine.)_ Preview in-app; **optional** real email via Graph `sendMail`.
- **After-action ingest** — upload a meeting's notes/feedback (PDF); **Document Intelligence**
  extracts and structures them into the engagement record.
- **Message-consistency checker** — compare each meeting's after-action against the topic's
  centrally-approved message, and across leaders/meetings on that topic; flag drift.
- **Enterprise "same message" view** — where are we consistent vs. drifting?

---

## 8. Demo Scenario (scripted, synthetic, pre-geocoded data)

> Fully synthetic, **pre-geocoded** seed so the demo runs offline and reliably. See §10.
> **The full engineered cast (leaders, contacts, events, coordinates) and the beat-by-beat
> choreography live in [`DEMO-DATASET.md`](./DEMO-DATASET.md).**

Setup: _AUSA Annual is in Washington, DC, Oct 12–15 (anchor event); a defense startup luncheon is
later that month. 6 leaders (mixed SME/level, different home bases, days-away budgets) and ~20
contacts nationwide with skill profiles, strategic value, and last-interaction dates._

Flow — the planner (primary):

1. **Proactive nudge → build plan:** the system sees a leader attending **AUSA (DC)** — ~44k
   attendees, 750+ exhibitors — and surfaces a card: _"You're at AUSA Oct 12–15. **6 of your contacts
   are attending** (5 stale, high-value) — engage them **on-site, no travel**. **3 new companies** on
   your **DIB-resilience** topic are **exhibiting** — want intros? A startup luncheon is nearby, and 4
   more contacts are within 50 mi. Build a plan?"_ Accept → the planner builds an **on-site slot plan**
   (attendee meetings + prospect intros at the venue) **plus** optional nearby off-site stops; the
   itinerary **densifies** on the map + timeline and **trip-ROI jumps** with almost no added travel
   (attendees came to you), the **extend-stay** cost shown against the leader's **days-away budget**.
2. **Travel + double-book:** the admin drags a 5th contact in **Austin** into the same window →
   **travel-infeasible + double-book** flags → recommendation: _"can't transit in time — move to a
   separate West-coast sweep."_
3. **Fit:** the admin assigns a **non-technical** leader to a **cyber** contact → **fit** flag →
   swap-in suggestion for a matched leader.
4. **Opportunity cost / ROI:** sending someone cross-country for one low-value meeting → nudge:
   _"AUSA is in DC that week — batch these 3 nearby stale, high-value cyber contacts instead."_
5. **Who-to-invite:** rank contacts for the **startup luncheon** by staleness × strategic value ×
   topic-relevance.

Then, supporting (per-stop pre-brief / loop):

6. Click a stop → **per-stop pre-brief**: contact background, prior interactions summarized,
   outstanding asks, and the topic's **approved talking points** — with citations. _(Preview;
   optionally emailed to one demo mailbox.)_
7. _(Optional)_ upload that meeting's **after-action notes as a real PDF** → **Document Intelligence**
   extracts → **consistency check** (_"On message ✅"_ or a drift flag) → feeds the **next** stop's
   pre-brief, closing the loop.

**[CONFIRM]** the exact demo narrative and any real (unclassified) example names the customer prefers.

---

## 9. Reuse Map — existing engine vs. net-new

Grounded in the current `greenhouse-resume-builder` codebase. The planner leans on the **one live
capability (geocoding)**; the pre-brief layer reuses the most mature engines.

| Capability                                                                       | Status in repo                    | Use here                                                             |
| -------------------------------------------------------------------------------- | --------------------------------- | ------------------------------------------------------------------- |
| **Geospatial / geocoding** (Azure Maps)                                          | **Live** (the only live capability) | **Pre-geocode all locations; map pins; distance inputs** — the star |
| **Map UI** (`MapView` + `project_map_pins`, caps 25 pins)                        | Implemented / wired               | Ported into the widget's **Trip tab**: trips, stops, legs           |
| **Distance (haversine from lat/lng)**                                            | —                                 | **Net-new but trivial** — feasibility + clustering                  |
| **Route / travel-time** (Azure Maps **Route Matrix**)                            | **Not called yet**; same account/key | **Optional** real drive-times; demo default = haversine + speed heuristic |
| **Trip model + greedy route ordering / batching**                                | —                                 | **Net-new** (deterministic, unit-testable)                          |
| **5-conflict + trip-ROI engine**                                                 | —                                 | **Net-new** (deterministic, unit-testable)                          |
| **Engagements widget** (tabbed hybrid web+MCP App)                               | pattern exists (6 capability UIs) | **Net-new**: one widget, Trip/Roster/Pre-brief tabs; reuses `MapView`; built with the official **ext-apps SDK** (`App`/`useApp`) |
| **Summarization** (`functions/src/activities/summary.ts` + Azure OpenAI)         | Implemented                       | Per-stop pre-briefs, interaction roll-ups (supporting)              |
| **Document Intelligence** (`document-intelligence.ts`)                           | **Implemented**                   | After-action / feedback PDF ingest (supporting loop)                |
| **Fact extraction + citations + versioning**                                     | Implemented                       | EXSUM → commitments/talking points; message as versioned facts      |
| **Version diff** (`version-diff.ts`)                                             | Implemented                       | Intended vs. actual message drift (supporting)                      |
| **MCP tool host** (`capabilities/mcp-core`, `functions/src/services/agent-runtime.ts`) | Implemented (**tools only**) | **Hosts the `engagements` tools** (promoted to **week 1**); the chat host's model composes them |
| **MCP-App resource serving** (`resources/*` + `_meta.ui`)                        | **Designed only** (`docs/wiki-app-architecture.md`); deps present | **Net-new in `mcp-core`**: serve `ui://engagements-widget.html` + tag tool results |
| **Search / discovery** (`api/src/search`)                                        | Code exists; needs a live index   | Find relevant past interactions; who-to-invite                      |
| **Temporal** (staleness/recurrence)                                              | Stubbed                           | **Net-new logic** for staleness/attention scoring                   |
| **Relationships**                                                                | Stubbed                           | Leader↔contact ties, co-mention                                     |
| **Pre-brief email** (Graph `sendMail`)                                           | —                                 | **Optional/stretch** — real send to a demo mailbox (app reg + Mail.Send) |
| **Synthetic M365-shaped seed (pre-geocoded)**                                    | —                                 | **Net-new** (CSV/JSON mimicking SharePoint/Outlook exports)         |

**Takeaway:** the planner is the **best fit for what actually runs** — geocoding is live and the map
is wired, so distance (haversine) and the trip/route logic are the tractable net-new work. The
supporting pre-brief layer reuses **summary**, **Document Intelligence**, **extraction**, and
**version-diff**. Net-new hot spots: the **Trip model + batching/route ordering**, the
**5-conflict/ROI engine**, and the **engagements widget** (tabbed web+MCP App).

---

## 10. MVP Scope (In / Out)

**In:**

- Synthetic, **pre-geocoded** seed data shaped like SharePoint list + Outlook exports.
- Layer 1 planner: **map + trip builder + batch suggestions + greedy route ordering + all 5
  conflicts + recommendations + trip-ROI + staleness + who-to-invite**, entered via a proactive
  **nudge**, rendered in the chat host's **engagements widget**.
- Layer 2 (supporting): **per-stop pre-brief** (preview) + after-action **Document Intelligence**
  ingest + message-consistency view.
- Reuse the **map** + AI summarization; build the widget with the official **ext-apps SDK**
  (`App`/`useApp` + `registerAppTool`/`registerAppResource`); deliver as **one `engagements` MCP-App
  capability** (tabbed widget) on **mcp-core**; auth bypass for the demo.

**Out (week 1):**

- Real routing **optimization solver** — the planner is a greedy **advisor**, not an auto-optimizer.
- **Standalone-web deployment** of the widget (SharePoint/Teams embed) — **optional fallback**; the
  committed surface is the **chat-host MCP-App**.
- Azure Maps **Route Matrix** real drive-times — **optional** (haversine + speed heuristic by
  default); wire only if time permits.
- Real Graph `sendMail` outbound — **optional/stretch** now (preview-first), since the pre-brief is a
  supporting feature.
- Live Microsoft Graph **reads** (SharePoint list / Outlook calendar) — simulated via seed/exports.
- Production auth/IL5 hardening, multi-tenant, real Azure AI Search at scale.
- Anything classified; unclassified demo data only. **[CONFIRM]**

---

## 11. One-Week Delivery Plan (team)

**Team shape (decided):** **1 Platform team + 3 feature teams (one widget tab each).** The Platform
team stands up the framework, data, **grounded tools**, and the **widget shell**; each feature team
builds one **tab** of the single `engagements` widget, whose tools the **chat host's model composes**
to accomplish an MVP job. This leans on the repo's `capabilities/mcp-core` (tool host + — net-new —
`ui://` resource serving) and `functions/src/services/agent-runtime.ts` (Azure OpenAI, for prose).

**Principle preserved:** _deterministic core, LLM at the edges._ The feasibility math
(distance/score/route/conflicts/ROI) stays pure + unit-tested and is exposed as **tools**; the chat
host's **model** is the reasoning edge that composes tools and produces the nudge, itinerary rationale,
pre-brief, and consistency verdict. **The model never does the math itself.**

| Team | Owns | Builds |
| ---- | ---- | ------ |
| **T1 — Platform & Framework** | data spine, seed, tools, **capability server + widget + basic-host shell**, deploy | JSONB tables + repos; **pre-geocoded seed**; the deterministic **planner tools** (`distance/score/suggest/route/conflicts/roi/on_site_slot_plan/who_to_invite`) exposed as **MCP tools (+ optional REST)**; **mcp-core `resources/read` serving `ui://engagements-widget.html` + `_meta.ui` on tool results**; the **widget shell** (tabs + ported `MapView`+legs + official **ext-apps SDK** `App`/`useApp` + single-file build + text fallback); the **ext-apps `basic-host` host shell**; **auth-bypass**; publishes **tool schemas + mocks** Day 1 |
| **T2 — Trip Planner tab** ★ | the star beat | the proactive **nudge → batch → itinerary → conflicts → ROI** tab; calls `suggest/route/conflicts/roi`; renders the nudge + itinerary on map/timeline; "shows the math" |
| **T3 — Conference Roster tab** | the magnet | the **event-anchor** tab: attendees **on-site** (zero-travel) + **on-site slot plan** + light **prospecting** one-liner + **who-to-invite**; calls `conference_roster/on_site_slot_plan/score/who_to_invite`; renders the roster + slot lane |
| **T4 — Pre-brief / Consistency tab** | the supporting loop | per-stop **pre-brief** (reuse `summary`) with citations; **after-action** PDF → **Document Intelligence** → **version-diff** → drift verdict; feeds the next pre-brief |

**Actual staffing (confirmed — 18) → proposed allocation.** Developer roles build; the
analyst/SME/process roles (PoCs, BAs, Process owner) define choreography, validate the domain, and own
the demo script across teams. _Acronyms inferred — adjust freely:_

| Team | People (18 total) |
| ---- | ----------------- |
| **T1 — Platform & Framework** (9) | **Tech Lead** (also integration owner) · 2× **DevSecOps** · **DPS Lead** · **Data Lead** · 2× **Data Eng** _(own the data stores/seed — this task)_ · 2× **Power Platform** _(SharePoint/Dataverse source adapters, post-demo ETL seam)_ |
| **T2 — Trip Planner tab** ★ (3) | 1× **Dev (AST1)** · 1× **Engagements PoC** (domain SME) · 1× **Business Analyst** |
| **T3 — Conference Roster tab** (3) | 1× **PEC** (dev) · 1× **Engagements PoC** (event/roster SME) · 1× **Business Analyst** |
| **T4 — Pre-brief / Consistency tab** (3) | 1× **PEC** (dev) · 1× **Cyber** (message-consistency/compliance) · 1× **Process Owner** (message-approval process) |

The **Data contingent** (DPS Lead + Data Lead + 2× Data Eng, with 2× Power Platform on source shape)
sits in T1 and owns the **staged data stores** described in §8 / `DEMO-DATASET.md`. **[CONFIRM]** the
inferred acronyms (DPS, PEC, AST1) and whether these assignments match intended skills.

**Contracts-first (the anti-blocking rule):** by **end of Day 1** the Platform team publishes (a) the
**tool schemas** (name/input/output), (b) the **`_meta.ui` resource contract** (each user-facing tool
result → `ui://engagements-widget.html`, served by mcp-core `resources/read`), and (c) **mock tool
responses**. Every feature team builds its tab against those stubs via the ext-apps SDK, so no team is ever
blocked on the Platform's real implementation.

**Day-by-day (4 teams in parallel):**

- **Day 0 — Prereqs.** Azure Maps key, Azure OpenAI deployment reachable, repo access, env files.
  Platform smoke-tests the **Azure OpenAI** round-trip (`max_completion_tokens`) used for pre-brief prose.
- **Day 1 — Contracts & scaffold (unblock everyone).** T1: tables+repos, **seed + pre-geocode**
  (map shows pins), stand up the **`engagements` capability server** (stub tools tagged `_meta.ui`) +
  **mcp-core `resources/read`** serving the **widget shell**, publish **schemas + mocks**. T2–T4:
  scaffold each **widget tab** against stubs; each renders a canned tool result. _(Gate: seed loads,
  pins render, every tab round-trips a stub tool via the ext-apps SDK.)_
- **Day 2 — Real tools + tab v1.** T1: real `distance/score/suggest`, trip persistence. T2:
  Trip-tab nudge v1 from real suggestions. T3: attendee list + who-to-invite v1. T4: pre-brief v1
  (preview). _(Gate: each tab renders a real, non-canned result for its primary beat.)_
- **Day 3 — Intelligence in.** T1: `route/conflicts/roi/on_site_slot_plan` tools + leg-polyline data.
  T2: ordering + all 5 conflicts + ROI "shows the math" + drag/evaluate. T3: on-site slot plan across
  event days + prospecting one-liner. T4: after-action DI → version-diff → **drift flag**. _(Gate: all
  5 conflicts + ROI fire on scripted data; conference on-site plan renders; drift fires.)_
- **Day 4 — Integrate end-to-end.** Nudge → itinerary → ROI → per-stop pre-brief → after-action loop
  runs across teams; recommendation panels; _(optional)_ real `sendMail`. _(Gate: full closed loop
  runs once.)_
- **Day 5 — Harden & rehearse.** Freeze scripted seed; **beat-keyed tests** (each beat in
  `DEMO-DATASET.md` §7 = a test); dry-run twice; buffer. _(Stretch, if ahead: a standalone-web
  deployment of the same widget in a plain browser via the Express fallback.)_

**Critical path:** Platform's **seed + pins + widget shell + tool contracts** (Day 1) unblocks all
three feature teams. **Top prerequisite (Day 0):** an **Azure Maps** key (dev or MI) — needed only at
seed time — and a reachable **Azure OpenAI** deployment for pre-brief prose + consistency.

**Cut-lines (drop in this order if behind), star protected:** standalone-web fallback → real `sendMail`
→ Route Matrix → live after-action DI (fall back to a pre-extracted result) → prospecting one-liner. The
**Travel-Planner star** (nudge → itinerary → ROI) and the **conference on-site plan** are protected.

**Integration cadence:** daily merge to a shared `demo` branch; the **Platform lead is integration
owner** and runs the full end-to-end each afternoon; each feature team owns its beat's rehearsal.

---

## 12. Assumptions

- Unclassified, **synthetic, pre-geocoded** data for the demo.
- **Azure Maps** key (dev key or managed identity) is available — the key live dependency.
- Azure OpenAI (for summaries/consistency) is available to the team.
- Azure Maps **Route Matrix** is **optional**; haversine + speed heuristic is the default for ETAs.
- Real Graph `sendMail` is **optional/stretch**; per-stop pre-briefs default to in-app preview.
- Single demo tenant; auth bypass acceptable for the demo environment.
- The planner **advises**; humans make the final call (no auto-optimizer).

---

## 13. Open Questions — to confirm with the customer

1. _(Decided: the **proactive anchor-and-batch nudge** — "you're already traveling here; here's
   what's nearby; want an itinerary?" — is the centerpiece; a multi-trip "regional-sweep optimizer"
   is post-MVP.)_ Confirm what should **trigger** a suggestion: a **planned trip**, **event
   attendance**, and/or a **single scheduled meeting**?
2. **Leader home bases + days-away budgets** — realistic values? Any real (unclassified) examples?
3. Do they want **real drive/flight times** (Azure Maps Route Matrix) or is a distance/speed
   heuristic fine for the demo?
4. **Trip approval workflow** — who **proposes** vs. **approves** a trip (draft→proposed→approved)?
5. **Scoring** — how is **strategic value** assigned, when is a relationship **stale**, how is
   **topic-relevance** determined, and how should the three be **weighted** in the suggestion score?
6. Keep per-stop pre-brief as **preview**, or invest in **real `sendMail`** (needs app reg +
   Mail.Send admin consent + a demo mailbox — slower in gov tenants)?
7. Which **senior leaders / echelons** are in scope, and who are the **admins/trip planners**?
8. **Classification/privacy** — confirm unclassified-only; how should sensitive contacts be handled?
9. Post-demo **integration** expectations (SharePoint lists, Outlook, the Kanban, the PPT calendar)?
10. **Success criteria** for the demo — what must the audience see to call it a win?
11. Team **size/skills** actually available for the week.
12. _(Supporting)_ Confirm an approved **per-topic talking-points library** exists and identify the
    **approving authority**; what does a real **EXSUM** look like (format, fields, length)?
13. **"Nearby" definition + extend-stay** — what radius (miles or drive-time) counts as "nearby," and
    what's the maximum acceptable **trip extension** (days) when suggesting "stay longer"?
14. _(Decided: the interface is a **web page** (chat UI) that renders MCP UI apps via the **official
    MCP Apps SDK** (`@modelcontextprotocol/ext-apps`), using the ext-apps **`basic-host`** reference as
    the host shell; the planner ships as **one `engagements` MCP-App capability with a single tabbed
    widget** — Trip / Conference Roster / Pre-brief.)_
15. **Attendee/exhibitor & prospect source** — where do conference **attendee/exhibitor lists** and
    **prospect** (new-company) records come from (registration exports, exhibitor directories, a CRM
    prospect list)? For the demo they're **synthetic rosters** attached to the event.
16. _(Decided: **re-engaging existing contacts is the star**; **prospecting new companies** is a
    lighter **supporting flavor** — a one-line "N new companies exhibiting — want intros?" add-on on
    the conference card, not its own full beat.)_

---

## 14. Next Step

The **architecture** is captured in [`ARCHITECTURE.md`](./ARCHITECTURE.md): component diagram, data
flows, Azure services (esp. Maps **geocode** + optional **Route Matrix**), the **batching + greedy
route-ordering + 5-conflict/ROI** engine, the **map + itinerary** UI, the per-stop pre-brief /
message-consistency design, security/IL5 posture, the one-week build sequence, and the post-demo path
to live SharePoint/Outlook (Graph) connectors. Edit this plan and the dataset first; then refine the
architecture to match.

**Optional de-risking spike:** a thin vertical slice — _geocode → map pins → batch-suggest →
conflict/ROI on the itinerary_ — to prove the one live capability carries the demo before the full
team ramps.
