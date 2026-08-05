/**
 * Wire contract for the `ui://trip-map` App — the ONLY thing shared between the server tool
 * (`build_itinerary`, which BUILDS this payload) and the browser map App (which RENDERS it).
 *
 * IMPORTANT: this module must stay browser-safe. It must NOT import from `./engine.js` or the engine
 * modules (`./planner`, `./retrieval`), because Vite bundles it into the App. Keep it plain types
 * only — the mapping from engine results into this shape lives server-side in `tools.ts`.
 */

export type TripMapPointKind = "origin" | "on-site" | "off-site";

/** A plottable point: the anchor venue (`origin`) or a stop (a contact to meet). */
export interface TripMapPoint {
  id: string;
  label: string;
  lat: number;
  lng: number;
  kind: TripMapPointKind;
  /** One-line context shown in the pin popup / list row. */
  detail?: string;
}

/** A travel leg of the itinerary (origin → nearest-neighbor off-site sweep). */
export interface TripMapLeg {
  fromLat: number;
  fromLng: number;
  toLat: number;
  toLng: number;
  mode: "air" | "ground";
  distanceMi?: number;
}

/** The full geospatial payload attached to a `build_itinerary` result under `structuredContent.tripMap`. */
export interface TripMapPayload {
  /** e.g. "MG Whitfield @ AUSA". */
  title: string;
  origin: TripMapPoint;
  /** Ordered: on-site (at the venue) first, then the off-site nearest-neighbor sweep. */
  stops: TripMapPoint[];
  /** Travel legs; empty when every stop is on-site. */
  legs: TripMapLeg[];
  roiScore?: number;
  overBudget?: boolean;
  totalMi?: number;
}
