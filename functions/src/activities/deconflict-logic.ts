/**
 * Pure deconfliction helpers — no I/O, no framework imports, so they are trivially unit-testable.
 * The DB-bound orchestration lives in `deconflict.ts`, which composes these.
 */

export const PLACEHOLDER_NAME = 'Unknown Candidate';

export interface PersonLike {
  id: string;
  canonicalName: string;
  aliases?: string[];
  createdAt?: string;
}

/** Lowercase, strip punctuation, collapse whitespace — the grouping key for "same name". */
export function normalizePersonName(name: string): string {
  return (name || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function isRealName(name?: string): boolean {
  const v = (name || '').trim();
  return !!v && v !== PLACEHOLDER_NAME;
}

/**
 * Group persons by normalized canonical name and return only the groups that contain a
 * genuine duplicate (more than one member). Unnamed records and the `Unknown Candidate`
 * placeholder are never grouped — distinct unknowns must not be collapsed together.
 */
export function findDuplicateGroups(persons: PersonLike[]): PersonLike[][] {
  const placeholderKey = normalizePersonName(PLACEHOLDER_NAME);
  const byName = new Map<string, PersonLike[]>();
  for (const p of persons) {
    const key = normalizePersonName(p.canonicalName);
    if (!key || key === placeholderKey) continue;
    const arr = byName.get(key) ?? [];
    arr.push(p);
    byName.set(key, arr);
  }
  return [...byName.values()].filter((g) => g.length > 1);
}

/**
 * Choose the survivor for a duplicate group. Prefer `preferredId` when it is part of the
 * group (keeps the active ingestion's personId stable); otherwise the earliest-created
 * record wins, with the lexicographically-smallest id as a deterministic tie-breaker.
 */
export function selectSurvivor(group: PersonLike[], preferredId?: string): PersonLike {
  if (preferredId) {
    const pref = group.find((p) => p.id === preferredId);
    if (pref) return pref;
  }
  return [...group].sort((a, b) => {
    const ca = a.createdAt ?? '';
    const cb = b.createdAt ?? '';
    if (ca !== cb) return ca < cb ? -1 : 1;
    return a.id < b.id ? -1 : 1;
  })[0];
}

/** Union of every real name + alias across the group, de-duplicated case-insensitively. */
export function unionAliases(group: PersonLike[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const p of group) {
    for (const candidate of [p.canonicalName, ...(p.aliases ?? [])]) {
      const v = (candidate || '').trim();
      if (!isRealName(v)) continue;
      const k = v.toLowerCase();
      if (seen.has(k)) continue;
      seen.add(k);
      out.push(v);
    }
  }
  return out;
}

/** Pick the survivor's display name, preferring a real name over the placeholder. */
export function pickCanonicalName(group: PersonLike[], survivor: PersonLike): string {
  if (isRealName(survivor.canonicalName)) return survivor.canonicalName.trim();
  for (const p of group) if (isRealName(p.canonicalName)) return p.canonicalName.trim();
  return survivor.canonicalName || PLACEHOLDER_NAME;
}
