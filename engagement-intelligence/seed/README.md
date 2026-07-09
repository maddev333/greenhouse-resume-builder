# Seed data — staged target-schema records

Synthetic, **already-conformed** demo data for the Strategic Engagements Travel Planner MVP.

For the MVP we **skip live extraction** from the real sources and stage records that already
match "the schema we would ETL to" (`schema.ts`). This lets the planner engine, agents, and UI
be built and demoed with **zero external dependencies** (no live SharePoint/Outlook/Azure Maps
call at demo time — locations are pre-geocoded).

## Files

| File | Entity | Count |
|------|--------|------:|
| `schema.ts` | Canonical target types (drops into `shared/src/` on Day-1) | — |
| `topics.json` | `Topic` — trip subjects / approved-message anchors | 4 |
| `messages.json` | `Message` — approved, versioned talking points | 2 |
| `leaders.json` | `Leader` — Pool A (senior leaders whose time we allocate) | 6 |
| `contacts.json` | `Contact` — Pool B (20 active + 3 prospects) | 23 |
| `events.json` | `Event` — travel anchors / attendee-magnets | 3 |
| `engagements.json` | `Engagement` — past meetings (history) | 3 |
| `afteractions.json` | `AfterActionNote` — EXSUM readouts (message-drift signal) | 2 |
| `config.json` | Demo-clock config (`today`, `staleCutoffDays`, `shiftMonths`) | — |
| `clock.mjs` | Shared clock helper (reads `config.json`, applies the shift) | — |
| `validate.mjs` | Dependency-free integrity checker | — |

`Trip` / `Stop` / `Leg` are **runtime-produced by the planner engine** and are therefore NOT
seeded (their shapes are defined in `schema.ts` for completeness).

## Validate

```bash
node validate.mjs   # exits 1 on any error; prints a per-entity + staleness report
```

## Envelope note (ETL "load" framing)

The staged JSON carries **only domain fields**. The (deferred) Platform Day-1 loader stamps the
`BaseEntity` envelope — `tenantId` (= `demo`), `createdAt`, `updatedAt` — at load time, exactly
as a real ETL *load* step stamps tenant + audit columns. `schema.ts` still declares those fields
because they are part of the true target shape in Postgres.

## Source → target ETL mapping (what we would extract from, per entity)

| Target entity | Real source(s) we would ETL from |
|---------------|----------------------------------|
| `Leader` | SharePoint "leaders" list + Outlook (availability) |
| `Contact` (active) | SharePoint "contacts" list |
| `Contact` (prospect) | Conference **exhibitor directory** (e.g. AUSA) |
| `Event` | The PowerPoint "calendar" + SharePoint events list |
| `Engagement` | SharePoint **Kanban** board + Outlook calendar |
| `Topic` / `Message` | Central comms / strategic-messaging library |
| `AfterActionNote` | Uploaded **EXSUM PDFs** → Document Intelligence |
| `Trip` / `Stop` / `Leg` | **Runtime** planner output (not extracted) |

## Demo clock & pre-geocoding

## Demo clock (configurable) & pre-geocoding

The demo clock lives in **`config.json`** — the single source of truth read by `validate.mjs`
today and by the Day-1 loader later:

- **`today`** (authored `2025-10-06`) and **`staleCutoffDays`** (`180`) → derived **stale cutoff
  `2025-04-09`**. Active contacts whose `lastInteractionDate` is before the cutoff are "stale"
  (15 of 20; fresh: C7, C9, C11, C14, C15).
- **`shiftMonths`** relocates the *whole* demo to another year without editing any seed date. It is
  applied **uniformly to `today` AND every date in the seed**, so all staleness / freshness /
  event-window relationships are **invariant**. Default `0` → 2025; set `12` → 2026 (e.g. to align
  with the next AUSA). Verified: both values yield the same **15 stale / 5 fresh** split.
- All `GeoPoint`s are **pre-geocoded** (`lat`/`lng` baked in). At real ETL time these are filled
  by the Azure Maps geocoder; the `project_map_pins` MCP tool caps at 25 locations/call, so the
  ~32 records geocode in ≤2 chunks — done once at seed time, never at demo time.

## Choreographed demo story (why these values)

- **Anchor:** L1 (industrial-base MG, home = DC) plans around **AUSA** (E-AUSA, DC, Oct 12–15;
  topics T1+T3). AUSA is the *magnet*.
- **On-site at ~zero travel:** `E-AUSA.attendingContactIds = [C8, C10, C13, C15, C16, C19]`.
  Ranking story for a **T1** trip: **C8** (T1, stale, value 5) ★ > **C13** (T1, stale, v3) >
  **C15** (T1, but **fresh** → down-ranked) ≈ **C10/C19** (T2, off-topic to a T1 trip) >
  **C16** (low value). Shows staleness × strategic-value × topic-relevance interacting.
- **Off-site stretch:** C17 (Raleigh) + C20 (Philadelphia) are drive-feasible off-site stops,
  deliberately **not** in the AUSA roster.
- **Prospecting (supporting flavor):** `exhibitorProspectIds = [P1, P2, P3]` — new companies from
  the exhibitor directory matched to T1/T3 → a one-line "want intros?" add-on, never the star.
- **Message-consistency thread (C1, value 5, stale @ 2025-02-20):**
  - `EX-002` (L1, 2025-01-18) → `AA-onmsg`: on-message.
  - `EX-003` (L5, 2025-02-20) → `AA-drift`: LTG Cole signaled a **specific program-dollar figure**,
    violating `M-T1-v2` point *"No commitments on specific program dollars"* → the drift the
    pre-brief / message-consistency check surfaces.
  - Both engagements carry `intendedMessageId = M-T1-v2`. **Simplification:** the seed does NOT
    enforce message-snapshot-by-date (M-T1-v2 `effectiveFrom` is 2025-09-01, after these dates);
    treat `intendedMessageId` as "the message this meeting is judged against," not a temporal
    snapshot. The real system would snapshot the then-current version.

## Day-1 wiring (deferred, per user decision)

Schema + JSON only for now — no DB dependency. On Platform Day-1:

1. Move `schema.ts` types into `shared/src/interfaces.ts` (+ any enums to `shared/src/enums.ts`),
   re-export from `shared/src/index.ts`.
2. Register one JSONB table per entity in `api/src/db/pg-client.ts` (`TABLE_DDL` +
   `CONTAINER_TABLES` + `physicalTable()`), following the existing `{ id TEXT PRIMARY KEY, data
   JSONB }` convention.
3. Add a `Repo<T>` per entity (extends `api/src/db/repo/base-repo.ts`).
4. Write a small loader that reads each `*.json`, applies the demo-clock shift to every date field
   via `clock.mjs` (`shiftDateByMonths(date, config.shiftMonths)`), stamps the envelope
   (`tenantId='demo'`, `createdAt`/`updatedAt=now`), and `upsert`s via the repos.
5. A `geo` adapter maps our `GeoPoint {lat,lng}` to whatever coordinate key `project_map_pins`
   expects (only needed if we ever re-geocode live).
