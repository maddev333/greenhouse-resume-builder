/**
 * Grounding catalog for the orchestrator's prompt + deterministic router.
 *
 * The leader roster and topic taxonomy live in the demo seed (the same source the capability
 * indexes). Leaders are NOT exposed as an MCP tool, so the orchestrator reads them here to
 * (a) inject a valid roster into the system prompt and (b) resolve a default leader when the
 * user does not name one. Topic keyword mapping powers the no-LLM fallback.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const SEED_DIR = resolve(import.meta.dirname, '..', '..', '..', '..', 'engagement-intelligence', 'seed');

/**
 * The four strategic stakeholder AUDIENCES an Army leader balances (plus a catch-all `other`), in
 * report order. Mirrors `@greenhouse-resume-builder/shared`'s `EngagementCategory`/`ENGAGEMENT_CATEGORIES`;
 * re-declared here (like {@link Leader}) so the agent stays decoupled from the shared package.
 */
export type EngagementCategory = 'congressional' | 'academia' | 'industry' | 'army-internal' | 'other';

export const ENGAGEMENT_CATEGORY_ORDER: readonly EngagementCategory[] = [
  'congressional',
  'academia',
  'industry',
  'army-internal',
  'other',
] as const;

export const CATEGORY_LABEL: Record<EngagementCategory, string> = {
  congressional: 'Congressional',
  academia: 'Academia',
  industry: 'Industry',
  'army-internal': 'Army internal',
  other: 'Other',
};

export interface Leader {
  id: string;
  name: string;
  role: string;
  domain: string;
  smeAreas: string[];
  homeBase: { city: string; state: string };
  /** The strategic audiences this leader engages — drives the per-category itinerary options. */
  engagementCategories?: EngagementCategory[];
}

export interface Topic {
  id: string;
  name: string;
  smeAreas: string[];
  domain?: string;
  ownerOrg?: string;
  approvedMessageId?: string | null;
}

export interface Region {
  id: string;
  name: string;
  aliases: string[];
  centroid: { city: string; state: string; lat: number; lng: number };
  defaultRadiusMi: number;
}

interface DemoClockConfig {
  today: string;
  shiftMonths?: number;
}

function readSeed<T>(file: string): T {
  return JSON.parse(readFileSync(resolve(SEED_DIR, file), 'utf-8')) as T;
}

let _leaders: Leader[] | null = null;
let _topics: Topic[] | null = null;
let _regions: Region[] | null = null;
let _config: DemoClockConfig | null = null;

export function loadLeaders(): Leader[] {
  return (_leaders ??= readSeed<Leader[]>('leaders.json'));
}

export function loadTopics(): Topic[] {
  return (_topics ??= readSeed<Topic[]>('topics.json'));
}

export function loadRegions(): Region[] {
  return (_regions ??= readSeed<Region[]>('regions.json'));
}

function loadClockConfig(): DemoClockConfig {
  return (_config ??= readSeed<DemoClockConfig>('config.json'));
}

/** The leader whose time is planned when the user does not name one. */
export function resolveDefaultLeaderId(): string {
  const env = process.env.ENGAGEMENTS_DEFAULT_LEADER?.trim();
  if (env && loadLeaders().some((l) => l.id === env)) return env;
  return loadLeaders()[0]?.id ?? 'L1';
}

/**
 * Keyword -> topicId, used by the deterministic fallback to map a free-text ask
 * ("UAS/drone", "cyber") onto the seed taxonomy. The LLM path does this via the prompt.
 */
const TOPIC_KEYWORDS: Record<string, string[]> = {
  T1: ['industrial base', 'dib', 'supply chain', 'munition', 'acquisition', 'contracting'],
  T2: ['cyber', 'zero-trust', 'zero trust', 'c5isr', 'network defense'],
  T3: ['uas', 'drone', 'autonom', 'startup', 'innovation', 'venture', 'dual-use', 'non-traditional'],
  T4: ['stem', 'talent', 'recruit', 'workforce'],
};

export function topicIdsFromText(text: string): string[] {
  const t = text.toLowerCase();
  return Object.entries(TOPIC_KEYWORDS)
    .filter(([, kws]) => kws.some((k) => t.includes(k)))
    .map(([id]) => id);
}

export function rosterForPrompt(): string {
  return loadLeaders()
    .map(
      (l) =>
        `  ${l.id}: ${l.name} — ${l.role} [${l.domain}], home ${l.homeBase.city}, ${l.homeBase.state}; ` +
        `SME ${l.smeAreas.join('/')}; audiences ${(l.engagementCategories ?? []).join('/') || 'unspecified'}`,
    )
    .join('\n');
}

export function topicsForPrompt(): string {
  return loadTopics()
    .map(
      (t) =>
        `  ${t.id}: ${t.name} (${t.smeAreas.join(', ')}); owner ${t.ownerOrg ?? 'unassigned'}; ` +
        `approved message ${t.approvedMessageId ? 'yes' : 'no'}`,
    )
    .join('\n');
}

// ── Area-first grounding (Phase 4 interactive planner) ──────────────────────

/** What the user picked for an area anchor — forwarded to the `plan_options` MCP tool. */
export interface AreaInput {
  regionId?: string;
  region?: string;
  city?: string;
  state?: string;
}

/** Region chips for the UI + the "which area?" clarifying question (value = region id). */
export function regionChoices(): { value: string; label: string; detail: string }[] {
  return loadRegions().map((r) => ({
    value: r.id,
    label: r.name,
    detail: `${r.centroid.city}, ${r.centroid.state} · ${r.defaultRadiusMi} mi`,
  }));
}

/**
 * Parse a free-text ask into an area anchor: first a known region (name/alias, longest match
 * wins so "Washington DC" beats "DC"), else a proper-cased place after a locative preposition
 * ("plan a trip to Huntsville" -> city). Returns null when nothing anchors — the caller then
 * asks the "which area?" clarifying question.
 */
export function resolveAreaInput(text: string): AreaInput | null {
  const haystack = text.toLowerCase();
  const pairs = loadRegions()
    .flatMap((r) => [r.name, ...r.aliases].map((alias) => ({ id: r.id, alias })))
    .sort((a, b) => b.alias.length - a.alias.length);
  for (const { id, alias } of pairs) {
    const rx = new RegExp(`\\b${alias.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`);
    if (rx.test(haystack)) return { regionId: id };
  }
  const loc = text.match(/\b(?:in|to|at|near|around|visiting|visit)\s+([A-Z][\w.]*(?:\s+[A-Z][\w.]*)*)/);
  if (loc?.[1]) return { city: loc[1].trim() };
  return null;
}

function addMonthsISO(iso: string, months: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() + months);
  return d.toISOString().slice(0, 10);
}

function addDaysISO(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/**
 * Default planning window when the user does not give dates: the demo clock's `today`
 * (shift-aware) through `today + horizon`. `plan_options` requires a window, and this default
 * spans the seed's event season so an area's in-window event gets auto-absorbed. Override with
 * ENGAGEMENTS_PLAN_WINDOW="YYYY-MM-DD..YYYY-MM-DD" or ENGAGEMENTS_PLAN_HORIZON_DAYS.
 */
export function defaultWindow(): { start: string; end: string } {
  const env = process.env.ENGAGEMENTS_PLAN_WINDOW?.trim();
  const m = env?.match(/^(\d{4}-\d{2}-\d{2})\.\.(\d{4}-\d{2}-\d{2})$/);
  if (m) return { start: m[1], end: m[2] };
  const cfg = loadClockConfig();
  const start = addMonthsISO(cfg.today, cfg.shiftMonths ?? 0);
  const horizon = Number(process.env.ENGAGEMENTS_PLAN_HORIZON_DAYS) || 25;
  return { start, end: addDaysISO(start, horizon) };
}

/** The demo clock's effective "today" (shift-aware) — used to rank upcoming events for hot topics. */
export function demoToday(): string {
  const cfg = loadClockConfig();
  return addMonthsISO(cfg.today, cfg.shiftMonths ?? 0);
}
