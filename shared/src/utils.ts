import crypto from 'crypto';

/** Generate a v4-style UUID */
export function generateId(): string {
  return crypto.randomUUID();
}

/** Create a stable bullet signature for diffing via SHA-256 of normalized text */
export function makeBulletSignature(text: string): string {
  return crypto.createHash('sha256').update(text).digest('hex');
}

/** Normalize employer names: trim, lowercase, collapse whitespace, remove punctuation variants */
export function normalizeEmployerName(name: string): string {
  return name.trim().toLowerCase().replace(/[.,]/g, '').replace(/\s+/g, ' ');
}

/** Normalize dates to year-month when possible (e.g. "2019-03" or "2019-00") */
export function normalizeDate(dateStr: string):string {
  const m = dateStr.match(/^(\d{4})[-/]?.*?(\d{1,2})/);
  if (m) return `${m[1]}-${String(Math.min(parseInt(m[2]), 12)).padStart(2, '0')}`;
  const y = dateStr.match(/^(\d{4})/);
  if (y) return `${y[1]}-00`;
  return dateStr.trim().toLowerCase();
}

/** Normalize strings: trim, lowercase, collapse whitespace */
export function normalizeString(s: string): string {
  return s.trim().toLowerCase().replace(/\s+/g, ' ');
}

/** Deduplicate names using similarity matching. Returns unique names and any near-duplicates found. */
export function dedupNames(names: string[]): { unique: string[]; similarities: Array<{ nameA: string; nameB: string; score: number }> } {
  const seen = new Set<string>();
  const similarities: Array<{ nameA: string; nameB: string; score: number }> = [];
  const unique = names.filter((name, i) => {
    const normed = normalizeString(name);
    if (seen.has(normed)) return false;
    seen.add(normed);

    // Check similarity with earlier accepted names
    for (let j = 0; j < i; j++) {
      const other = normalizeString(names[j]);
      if (other.length !== 0 && name.length !== other.length && Math.abs(name.length - other.length) > 10) continue;
      // Simple substring / similarity check as heuristic
      if (normed.includes(other) || other.includes(normed)) {
        similarities.push({ nameA: names[j], nameB: name, score: 0.8 });
      }
    }
    return true;
  });

  return { unique, similarities };
}