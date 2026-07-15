# Strategic Engagements Travel Planner — Synthetic Demo Dataset

> **Status:** DRAFT for review — engineered to make every demo beat fire. Fictional, unclassified.
> Names/orgs are placeholders and can be swapped. Companion to `MVP-PLAN.md` (see its §8 demo flow).

---

## 0. Design principles

1. **Every record earns its place** — each entity exists to trigger a specific demo beat (§7 map).
2. **Pre-geocoded** — real US cities with cached lat/lng, so the demo runs offline and haversine
   distances are believable (no live Maps call during the demo).
3. **Choreographed contrast** — for every "should suggest" record there's a near-twin that should
   **not** (fresh vs. stale, matched vs. mismatched, near vs. far) so the intelligence is visible.
4. **"Today" = 2025-10-06** (configurable — see `seed/config.json`). Staleness threshold = **180
   days** → stale if last interaction ≤ **2025-04-09**. AUSA is **2025-10-12 → 10-15**; the startup
   luncheon is **2025-10-16**. Set `shiftMonths: 12` in `config.json` to relocate the whole demo to
   2026 (applied uniformly, so staleness/freshness are unchanged).

---

## 1. Reference scales

- **Domain** (drives the **fit** soft-flag): `technical` | `non-technical`.
- **SME areas** — technical: `cyber, zero-trust, space, C5ISR, software, AI, autonomy`; non-technical:
  `industrial-base, acquisition, policy, talent/STEM, innovation/startups, strategy`.
- **Level** `L1–L4` (L1 action officer → L4 senior executive/GO/SES). Level gap ≥ 2 = soft flag.
- **Strategic value** `1–5` (5 = enterprise priority).
- **Days-away budget** — max travel-days per leader in the window.
- **Contact status** `active | prospect` — _active_ = an existing relationship (has a last-interaction
  date); _prospect_ = a **new company** we've never engaged (no last-interaction date), scored by
  topic-fit for the **initiate** path.

## 2. Topics (trip purpose + topic-relevance)

| ID  | Topic                                 | Technical? | Approved message? |
| --- | ------------------------------------- | ---------- | ----------------- |
| T1  | Defense industrial base (DIB) resilience | no       | **M-T1-v2** (§6)  |
| T2  | Cyber / zero-trust modernization      | yes        | M-T2-v1           |
| T3  | Defense innovation & startups         | no         | —                 |
| T4  | Talent / STEM outreach & recruiting   | no         | —                 |

_Topic-relevance_ = overlap between a contact's SME/topic and the **trip's** purpose (the anchor
event's topic). The AUSA trip's purpose is **T1 + T3**, so T1/T3 contacts score higher than T2 ones
on this trip — making topic-relevance visibly matter.

## 3. Events (travel anchors)

| ID         | Name                          | City, ST        | lat, lng          | Dates            | Topic | Role in demo                        |
| ---------- | ----------------------------- | --------------- | ----------------- | ---------------- | ----- | ----------------------------------- |
| E-AUSA     | AUSA Annual Meeting           | Washington, DC  | 38.9072, -77.0369 | 10-12 → 10-15    | T1    | **Primary anchor** (leader already going) |
| E-LUNCH    | Defense Startup Luncheon      | Arlington, VA   | 38.8816, -77.0910 | 10-16            | T3    | Nearby event in the nudge; who-to-invite target |
| E-SPACE    | Space & Missile Symposium     | Colo. Springs, CO | 38.8339, -104.821 | 10-14 → 10-16  | T2    | West-coast richness; alternative anchor |

**E-AUSA roster (the "magnet").** AUSA is a dense gathering — model it as more than an anchor:

- **Contacts attending (engage on-site, travel ≈ 0) — 6:** **C8** (Huntsville, stale v5), **C13**
  (Warren MI, stale v3), **C16** (Nashville, stale v2), **C10** (Colo Springs, stale v4), **C19** (LA,
  stale v4), and **C15** (Atlanta, **fresh** — contrast). C8/C10/C19 would normally be
  **far/drive-only** trips, but at AUSA they're reachable at **zero travel**. Among attendees the
  **on-topic T1** ones rank by staleness×value — **C8** (v5) top, then **C13**; **C15** (T1 but
  **fresh**) and **C16** (T1 but low value) fall; **C10/C19** (space/T2) score lowest on
  topic-relevance for this T1 trip. On-site meetings are **stops with no travel legs**, scheduled
  into venue time-slots across 10-12→15.
- **Exhibitor prospects (new companies → initiate) — 3:** **P1–P3** (§5.1), matched on **T1/T3**.
- **Topics present:** T1 (DIB) + T3 (startups).

_Conference-as-magnet: attendees come to you; C1–C4 remain the **off-site** nearby batch you drive to;
exhibitors are net-new intros — all three pools coexist on one trip._

---

## 4. Leaders (Pool A) — 6

| ID  | Name             | Echelon / role     | Domain        | SME                          | Lvl | Home base (lat,lng)          | Avail (Oct) | Budget | Role in demo                          |
| --- | ---------------- | ------------------ | ------------- | ---------------------------- | --- | ---------------------------- | ----------- | ------ | ------------------------------------- |
| L1  | MG D. Whitfield  | ASA(ALT) staff     | non-technical | industrial-base, acquisition | L4  | Washington, DC (38.907,-77.037) | 6–20    | 10 d   | **Protagonist** — attending AUSA      |
| L2  | Ms. P. Anand     | USAREC (SES)       | non-technical | talent/STEM, recruiting      | L4  | Fort Knox, KY (37.891,-85.963)  | 8–18    | 8 d    | **Fit beat** — non-tech assigned to a cyber contact |
| L3  | Dr. M. Bell      | Army Cyber         | technical     | cyber, zero-trust, AI        | L3  | Augusta, GA (33.470,-82.011)    | 10–17   | 6 d    | The **better-matched** cyber leader (fit rec) |
| L4  | COL S. Reyes     | SMDC / space       | technical     | space, C5ISR                 | L3  | Colo. Springs, CO (38.834,-104.821) | 12–16 | 5 d  | Geographic spread; near E-SPACE       |
| L5  | LTG A. Cole      | Senior principal   | non-technical | strategy, international      | L4  | Washington, DC (38.907,-77.037) | 6–20    | 12 d   | High-value host; **drift** source (§6) |
| L6  | Mr. T. Nguyen    | Army Software Fac. | technical     | software, data, AI           | L2  | Boston, MA (42.360,-71.059)     | 13–19   | 6 d    | **Opportunity-cost beat** (sent cross-country alone) |

**Engagement categories per leader** (`Leader.engagementCategories`) — the strategic audiences each
billet actually engages. The Stage-2 area planner offers **one single-audience itinerary per category
here** (never a blended trip), so the SAME area yields a DIFFERENT menu per leader (see §5.2 / design §G):

| Leader | `engagementCategories` | Rationale |
| --- | --- | --- |
| L1 MG Whitfield (ASA(ALT)) | `industry`, `congressional` | acquisition → defense industry + Congressional oversight/appropriations |
| L2 Ms. Anand (USAREC)      | `academia`, `army-internal` | STEM/recruiting → universities + internal recruiting command |
| L3 Dr. Bell (Army Cyber)   | `industry`, `army-internal` | cyber vendors + Army Cyber Command |
| L4 COL Reyes (SMDC/Space)  | `industry`, `army-internal` | space primes + SMDC internal |
| L5 LTG Cole (principal)    | `congressional`, `academia` | strategy/international → the Hill + think-tanks/policy academia |
| L6 Mr. Nguyen (Sw Factory) | `industry`, `academia`, `army-internal` | software startups + university labs + internal software factory |

---

## 5. Contacts (Pool B) — 20

Stale = last interaction ≤ 2025-04-09. `Val` = strategic value 1–5.

| ID  | Name (org)                | City, ST         | lat, lng           | Domain        | SME / Topic         | Lvl | Val | Last int.  | Stale | Owner | Role in demo                         |
| --- | ------------------------- | ---------------- | ------------------ | ------------- | ------------------- | --- | --- | ---------- | ----- | ----- | ------------------------------------ |
| C1  | TechCorp Defense          | Arlington, VA    | 38.8816, -77.0910  | non-technical | industrial / T1     | L4  | 5   | 2025-02-20 | ✅    | L1    | **Batch #1 + featured pre-brief**    |
| C2  | Dr. Elena Fischer (CSIS)  | Bethesda, MD     | 38.9847, -77.0947  | non-technical | policy / T1         | L4  | 4   | 2025-01-20 | ✅    | L5    | **Batch #2**                         |
| C3  | Meridian Robotics         | Reston, VA       | 38.9586, -77.3570  | non-technical | autonomy-mfg / T1,T3| L3  | 4   | 2025-02-10 | ✅    | L1    | **Batch #3**                         |
| C4  | Capital Defense Angels    | Alexandria, VA   | 38.8048, -77.0469  | non-technical | startups / T3       | L4  | 4   | 2024-11-15 | ✅    | L5    | **Batch #4** + luncheon invite       |
| C5  | Hopkins APL (cyber lead)  | Baltimore, MD    | 39.2904, -76.6122  | technical     | cyber / T2          | L4  | 5   | 2025-03-01 | ✅    | L3    | **Fit beat** target (cyber near DC)  |
| C6  | Lone Star Dynamics        | Austin, TX       | 30.2672, -97.7431  | non-technical | industrial / T1     | L4  | 4   | 2025-01-10 | ✅    | L1    | **Travel + double-book beat**        |
| C7  | Cascade Micro             | Seattle, WA      | 47.6062, -122.332  | technical     | software / T2       | L2  | 2   | 2025-08-01 | ❌    | L6    | **Opportunity-cost** (low val, fresh, far) |
| C8  | Redstone Systems          | Huntsville, AL   | 34.7304, -86.5861  | non-technical | industrial / T1     | L4  | 5   | 2025-02-18 | ✅    | L1    | **AUSA attendee** (T1, stale v5) → top on-site pick |
| C9  | Alamo Cyber Range         | San Antonio, TX  | 29.4241, -98.4936  | technical     | cyber / T2          | L3  | 3   | 2025-06-01 | ❌    | L3    | Fresh contrast (recently engaged)    |
| C10 | Orbital Edge              | Colo. Springs, CO| 38.8339, -104.821  | technical     | space / T2          | L3  | 4   | 2025-01-05 | ✅    | L4    | Near E-SPACE; **AUSA attendee** (T2, off-topic to T1 trip) |
| C11 | Hub Robotics (MIT spinout)| Boston, MA       | 42.3601, -71.0589  | non-technical | startups / T3       | L2  | 4   | 2025-09-10 | ❌    | L6    | **Fresh contrast** for who-to-invite |
| C12 | Bay Defense Ventures      | San Francisco, CA| 37.7749, -122.419  | non-technical | startups / T3       | L4  | 5   | 2024-12-20 | ✅    | L5    | **Top luncheon invite** (high val, stale) |
| C13 | Motor City Defense        | Warren, MI       | 42.5145, -83.0147  | non-technical | industrial / T1     | L3  | 3   | 2025-03-15 | ✅    | L1    | **AUSA attendee** (T1, stale v3)     |
| C14 | SimTrain Partners         | Orlando, FL      | 28.5383, -81.3792  | non-technical | startups / T3       | L3  | 3   | 2025-05-05 | ❌    | L5    | Fresh mid-value; who-to-invite mid   |
| C15 | Peachtree Logistics       | Atlanta, GA      | 33.7490, -84.3880  | non-technical | industrial / T1     | L3  | 3   | 2025-08-20 | ❌    | L1    | **AUSA attendee** — T1 but **fresh** → ranks low |
| C16 | Music City Policy Group   | Nashville, TN    | 36.1627, -86.7816  | non-technical | policy / T1         | L2  | 2   | 2025-02-01 | ✅    | L5    | **AUSA attendee** — T1 but low val → ranks low |
| C17 | Triangle Semiconductors   | Raleigh, NC      | 35.7796, -78.6382  | non-technical | industrial / T1     | L4  | 4   | 2025-01-30 | ✅    | L1    | **Drive-feasible** stretch stop (~250 mi) |
| C18 | APG Test Directorate      | Aberdeen, MD     | 39.5093, -76.1641  | technical     | C5ISR / T2          | L3  | 3   | 2025-03-20 | ✅    | L4    | Borderline "near DC" (~70 mi)        |
| C19 | West Coast Space Works     | Los Angeles, CA  | 34.0522, -118.244  | technical     | space / T2          | L4  | 4   | 2025-02-05 | ✅    | L4    | **AUSA attendee**; T2 (off-topic to T1 trip) |
| C20 | Liberty Shipworks         | Philadelphia, PA | 39.9526, -75.1652  | non-technical | industrial / T1     | L4  | 4   | 2024-12-01 | ✅    | L1    | **Drive-feasible** stretch stop (~140 mi) |

**The near-DC picture (why the batch works):** C1–C4 are ≤ ~20 mi from AUSA, **stale**, **high
value**, and **T1/T3-matched to L1** → the batch. C5 (Baltimore, cyber/T2) and C18 (Aberdeen) are
nearby but **not matched to L1's domain/topic** → lower suggestion score, and C5 is the fit-flag
example. C17 (Raleigh) and C20 (Philadelphia) are **drive-feasible** → nice route-ordering stretch
stops. C6 (Austin), C7 (Seattle) are **far** → feasibility/opportunity-cost material (C8 Huntsville would be
too, but it's **attending AUSA** — reachable on-site at zero travel; see §3 roster).

### 5.1 Prospects — new companies / exhibitors (3)

Never engaged (no last-interaction date). Scored by **topic-fit × estimated value** (the **initiate**
path), not staleness. All exhibiting at **E-AUSA**.

| ID  | Company (booth)        | City, ST       | lat, lng          | Domain        | SME / Topic      | Est. val | Role in demo                                       |
| --- | ---------------------- | -------------- | ----------------- | ------------- | ---------------- | -------- | -------------------------------------------------- |
| P1  | NovaForge Additive     | Youngstown, OH | 41.0998, -80.6495 | non-technical | industrial / T1  | 4        | **Top prospect** — strong T1 fit, exhibiting       |
| P2  | Sentinel Drone Systems | San Diego, CA  | 32.7157, -117.161 | non-technical | autonomy / T1,T3 | 4        | Prospect — T1/T3 fit; "want an intro?"             |
| P3  | BluePeak Analytics     | Austin, TX     | 30.2672, -97.7431 | technical     | AI/data / T2     | 3        | **Off-topic contrast** — T2, low fit → downranked  |

**Why P1/P2 surface, P3 doesn't:** P1/P2 match the AUSA trip's **T1/T3** purpose → **initiate**
suggestions ("3 new companies exhibiting — want intros?"); P3 is **T2** (AI/cyber) → low
topic-relevance on this trip, so it's the prospect contrast that stays quiet.

### 5.2 Engagement-audience coverage (the four-audience identification)

Beyond topic and staleness, each contact carries a **`sector`** that rolls up (via `categoryForSector`,
`shared/src/engagements.ts`) into one of four strategic **audiences** an Army leader balances on a
single trip — **Congressional, Academia, Industry, Army-internal** (+ a catch-all `other`). The planner
reports every area's footprint across all four (always emitting the targets, so a **coverage gap** is
explicit) and flags which audiences the trip's options actually reach.

To make the near-DC audience picture demonstrable, the seed adds representative NCR engagements outside
the AUSA on-site roster (all T1, active, stale, >1 mi from the NCR centroid so the topic/stale tripwires
hold):

| ID  | Name (org)                    | City, ST         | `sector`        | Audience        | Role in demo                                  |
| --- | ----------------------------- | ---------------- | --------------- | --------------- | --------------------------------------------- |
| C18 | APG Test Directorate          | Aberdeen, MD     | `army-internal` | Army-internal   | Retagged `government`→`army-internal` (Army test org) |
| C31 | HASC Professional Staff       | Washington, DC   | `congressional` | Congressional   | House Armed Services Committee staff — the Congressional audience |
| C32 | Senate Approps (Defense) Staff| Washington, DC   | `congressional` | Congressional   | Senate Appropriations defense staff — budget-cycle engagement |
| C33 | AFC NCR Liaison               | Arlington, VA    | `army-internal` | Army-internal   | Army Futures Command NCR liaison — internal-Army coordination |
| C34 | PEO Ground Combat Systems     | Alexandria, VA   | `army-internal` | Army-internal   | Program Executive Office — internal-Army acquisition |

Together with the existing near-DC **Industry** (C1, C3, …) and **Academia** (C2 CSIS/think-tank) rows,
the NCR now spans all four audiences — so "identify engagements across Congressional / Academia /
Industry / Army-internal" returns a real, non-trivial breakdown, and dropping any one audience from a
trip's options is surfaced as a gap. Because the NCR holds all four audiences, it also demonstrates the
**per-leader single-audience grouping** (§4): the Stage-2 planner offers L1 a {Congressional, Industry}
menu, L5 a {Congressional, Academia} menu, L3 a {Industry, Army-internal} menu — the same area, filtered
to each leader's `engagementCategories`, one itinerary per category (never blended).

---

## 6. Interaction history, approved message & the drift record

For the **pre-brief** and **message-consistency** beats (supporting layer):

**Approved message — `M-T1-v2` (DIB resilience), status: approved, effective 2025-09-01, approver: comms/strategic-messaging.**
Intended points: (a) multi-year contracting stability is coming; (b) prioritize supply-chain
onshoring for munitions; (c) no commitments on specific program dollars.

**C1 TechCorp interaction history (citations for the pre-brief):**

- `EX-001` (2024-12-05, L1) — intro meeting; TechCorp asked about **multi-year contracting** certainty.
  Outstanding ask: _"clarity on multi-year vehicles."_
- `EX-002` (2025-01-18, L1) — follow-up; TechCorp flagged a **munitions supply-chain** bottleneck.
  Has after-action `AA-onmsg`.
- `EX-003` (2025-02-20, **L5**) — principal-level readout; strong rapport but the message drifted.
  Has after-action `AA-drift`. (C1's `lastInteractionDate` = 2025-02-20 — still stale.)

**After-action notes (both present in the seed; `AA-drift` also carries a source PDF for the DI beat):**

- `AA-onmsg` (on `EX-002`) — L1↔C1 readout that **matches** M-T1-v2 → consistency check = _"On message ✅."_
- `AA-drift` (on `EX-003`) — **L5↔C1** readout where L5 hinted at **specific program dollars**
  (violates point c) → consistency check = **drift flag**: _"Two leaders gave inconsistent guidance to
  TechCorp on DIB — L1 aligned to M-T1-v2, L5 diverged on program funding."_

---

## 7. Beat → data → expected system response (the choreography)

| # | Demo beat                     | Trigger records                                              | Expected response                                                        |
| - | ----------------------------- | ----------------------------------------------------------- | ------------------------------------------------------------------------ |
| 1 | **Proactive nudge → build**   | L1 at E-AUSA (DC, 10-12→15); C1–C4 near, stale, matched, avail; E-LUNCH 10-16 | Trip-tab nudge: "stay +2 days, batch these 4 + luncheon"; accept → itinerary densifies, **trip-ROI jumps** |
| 1b | **Conference roster & prospecting** | E-AUSA attendees C8/C10/C13/C15/C16/C19 + exhibitor prospects P1–P3 | "6 contacts attending — engage **on-site, no travel**; 3 new companies exhibiting on T1/T3 — **want intros?**" → **on-site slot plan**; on-topic T1 **C8/C13** rank top, C15 (fresh) + C16 (low val) + C10/C19 (off-topic) lower; **P1/P2** surface, **P3** stays quiet |
| 2 | **Travel + double-book**      | Add C6 (Austin) into the DC window                          | **Travel-infeasible** (DC↔Austin same-day) + **double-book** → "move to a separate West-TX sweep" |
| 3 | **Fit (soft flag)**           | Assign L2 (non-tech) to C5 (cyber/T2)                       | **Fit flag** (allowed) → recommend **L3** (cyber) as a better match       |
| 4 | **Opportunity cost / ROI**    | Plan sends L6 (Boston) → C7 (Seattle, val 2, fresh) alone   | **Low trip-ROI** → "redirect: DC cluster C1–C4 (high value, stale) is unstaffed" |
| 5 | **Who-to-invite (luncheon)**  | Rank T3 contacts for E-LUNCH: C4, C12, C11, C14            | Top = **C12** (v5, stale), **C4** (v4, stale); **C11 downranked** (fresh) |
| 6 | **Per-stop pre-brief**        | Select C1 stop → EX-001/002/003 + M-T1-v2                   | Pre-brief: background, history, outstanding ask, approved talking points, **citations** |
| 7 | **After-action + consistency**| Upload `AA-drift.pdf` for C1 → Document Intelligence        | Extract → compare to M-T1-v2 → **drift flag** (L1 vs L5); feeds next pre-brief |

**Contrast records that should NOT trigger** (proof the logic is real): C9/C11/C15 (fresh) aren't
suggested despite value/proximity; C19 (LA, cyber) scores low on the T1 trip (topic-relevance);
C16 (low value, stale) is a **drop** candidate, not an invite.

---

## 8. Adjustable knobs (confirm before we seed)

- **Names/orgs** — all fictional placeholders; swap for customer-preferred (unclassified) examples.
- **Scale** — 6 leaders / 20 contacts / 3 prospects / 3 events. Enough for a rich map without clutter; adjust.
- **"Today" & window** — 2025-10-06 with AUSA 10-12→15; flip `seed/config.json` `shiftMonths` to
  relocate the whole demo (e.g. `12` → 2026) without editing any seed date.
- **Staleness threshold** (180 d) and **value scale** (1–5) — tune to the customer's convention.
- **Coordinates** — approximate city-center; we pre-geocode via the live Maps client once at seed time.
