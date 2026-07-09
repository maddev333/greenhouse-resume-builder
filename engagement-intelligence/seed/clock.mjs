/**
 * Demo-clock helper — the SINGLE place that reads `config.json` and applies the
 * uniform month-shift. Used by `validate.mjs` today and by the Day-1 loader later,
 * so the seed can run in any year without editing the authored (2025) dates.
 *
 * Invariant: because `shiftMonths` is applied to BOTH `today` and every seed date,
 * all relative relationships (staleness, freshness, event ordering/windows) are
 * identical for any shift value.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const DIR = dirname(fileURLToPath(import.meta.url));
const ISO = /^\d{4}-\d{2}-\d{2}$/;

export function loadConfig() {
  return JSON.parse(readFileSync(join(DIR, 'config.json'), 'utf8'));
}

/** Shift an ISO YYYY-MM-DD date by a whole number of months (UTC-safe; clamps day). */
export function shiftDateByMonths(iso, months = 0) {
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
export function addDays(iso, days) {
  const [y, m, d] = iso.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + days);
  return dt.toISOString().slice(0, 10);
}

/** Effective demo clock: authored `today` shifted by `shiftMonths`. */
export function demoToday(cfg = loadConfig()) {
  return shiftDateByMonths(cfg.today, cfg.shiftMonths || 0);
}

/** Stale cutoff = demoToday - staleCutoffDays. */
export function staleCutoff(cfg = loadConfig()) {
  return addDays(demoToday(cfg), -(cfg.staleCutoffDays ?? 180));
}
