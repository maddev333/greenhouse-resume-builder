/**
 * Demo-clock helper — the SINGLE place that reads `config.json` and applies the uniform
 * month-shift. A CommonJS-safe TypeScript port of `engagement-intelligence/seed/clock.mjs`
 * (no `import.meta`, so it compiles under the api's `module: commonjs` tsconfig).
 *
 * Invariant: because `shiftMonths` is applied to BOTH `today` and every seed date, all relative
 * relationships (staleness, freshness, event ordering/windows) are identical for any shift value.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { SEED_DIR } from './paths';

const ISO = /^\d{4}-\d{2}-\d{2}$/;

export interface DemoConfig {
  today: string;
  staleCutoffDays: number;
  shiftMonths: number;
}

export function loadConfig(): DemoConfig {
  const raw = JSON.parse(readFileSync(join(SEED_DIR, 'config.json'), 'utf8')) as Partial<DemoConfig>;
  return {
    today: raw.today ?? '2025-10-06',
    staleCutoffDays: raw.staleCutoffDays ?? 180,
    shiftMonths: raw.shiftMonths ?? 0,
  };
}

/** Shift an ISO YYYY-MM-DD date by a whole number of months (UTC-safe; clamps day). */
export function shiftDateByMonths(iso: string, months = 0): string {
  if (typeof iso !== 'string' || !ISO.test(iso) || !months) return iso;
  const [y, m, d] = iso.split('-').map(Number);
  const target = new Date(Date.UTC(y, m - 1 + months, 1));
  const year = target.getUTCFullYear();
  const month0 = target.getUTCMonth();
  const daysInMonth = new Date(Date.UTC(year, month0 + 1, 0)).getUTCDate();
  const day = Math.min(d, daysInMonth);
  return `${year}-${String(month0 + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/** Add (or subtract) whole days to an ISO date (UTC-safe). */
export function addDays(iso: string, days: number): string {
  const [y, m, d] = iso.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + days);
  return dt.toISOString().slice(0, 10);
}

/** Whole days from ISO date `a` to ISO date `b` (`b - a`; negative when `b` precedes `a`). */
export function daysBetween(a: string, b: string): number {
  const [ay, am, ad] = a.slice(0, 10).split('-').map(Number);
  const [by, bm, bd] = b.slice(0, 10).split('-').map(Number);
  const da = Date.UTC(ay, am - 1, ad);
  const db = Date.UTC(by, bm - 1, bd);
  return Math.round((db - da) / 86_400_000);
}

/** Effective demo clock: authored `today` shifted by `shiftMonths`. */
export function demoToday(cfg: DemoConfig = loadConfig()): string {
  return shiftDateByMonths(cfg.today, cfg.shiftMonths || 0);
}

/** Stale cutoff = demoToday - staleCutoffDays. */
export function staleCutoff(cfg: DemoConfig = loadConfig()): string {
  return addDays(demoToday(cfg), -(cfg.staleCutoffDays ?? 180));
}

/** An active contact is stale when its (shifted) lastInteractionDate precedes the stale cutoff. */
export function isStale(lastInteractionDate: string | undefined, cfg: DemoConfig = loadConfig()): boolean {
  if (!lastInteractionDate) return false; // prospects are never "stale" (no history)
  return shiftDateByMonths(lastInteractionDate, cfg.shiftMonths || 0) < staleCutoff(cfg);
}
