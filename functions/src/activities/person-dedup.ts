/** Person Dedup: compares extracted name + employment patterns against existing persons. */

import { app } from 'durable-functions';

export interface DedupResult {
  personId?:          string;
  candidates?:        Array<{ id: string; canonicalName: string; score: number }>;
  isConfidentMatch:   boolean;
}

/** Compute Levenshtein distance between two strings. Efficient for short names. */
function levenshtein(a: string, b: string): number {
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;

  const m: number[][] = [];
  for (let i = 0; i <= b.length; i++) m[i] = [i];
  for (let j = 0; j <= a.length; j++) m[0][j] = j;

  for (let i = 1; i <= b.length; i++) {
    for (let j = 1; j <= a.length; j++) {
      if (b[i - 1] === a[j - 1]) {
        m[i][j] = m[i - 1][j - 1];
      } else {
        m[i][j] = Math.min(m[i - 1][j - 1] + 1, m[i][j - 1] + 1, m[i - 1][j] + 1);
      }
    }
  }
  return m[b.length][a.length];
}

/** Normalize a person's name for comparison (lowercase, strip non-alphanumeric except spaces). */
function normalizeName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').trim();
}

/** Compute similarity score between two names (0.0 to 1.0). */
function nameSimilarity(a: string, b: string): number {
  const na = normalizeName(a);
  const nb = normalizeName(b);
  if (na === nb) return 1.0;
  if (!na || !nb) return 0.0;

  // Check substring match (e.g., "Jon Smith" matches "Jonathan Smith")
  if (na.includes(nb) || nb.includes(na)) {
    const shorterLen = Math.min(na.length, nb.length);
    const longerLen  = Math.max(na.length, nb.length);
    if ((shorterLen / longerLen) >= 0.7) return 0.9;
  }

  const maxLen = Math.max(na.length, nb.length);
  return 1.0 - (levenshtein(na, nb) / maxLen);
}

/** Match an extracted candidate against existing candidates in Cosmos DB. */
export function resolvePersonDedup(
  extractedName: string,
  extractedEmployers: string[],
  existingCandidates: Array<{ id: string; canonicalName: string; aliases?: string[] }>,
): DedupResult {
  const CONFIDENT_THRESHOLD = 0.85;
  const REVIEW_THRESHOLD    = 0.60;

  if (extractedName.trim() === '') return { isConfidentMatch: false };

  // Build candidate match scores
  const scoredCandidates: Array<{ id: string; canonicalName: string; score: number }> = existingCandidates
    .map(cand => {
      const namesToCheck = [cand.canonicalName, ...(cand.aliases ?? [])];
      let bestScore = 0;

      // Name similarity
      for (const other of namesToCheck) {
        const sim = nameSimilarity(extractedName, other);
        if (sim > bestScore) bestScore = Math.max(bestScore, sim);
      }

      // Bonus for matching employers
      let employerBonus = 0;
      for (const e1 of extractedEmployers) {
        for (const other of namesToCheck) {
          if (other.toLowerCase().includes(e1.toLowerCase()) && !bestScore) {
            employerBonus += 0.1; // Small bonus if employer name appears in any alias
          }
        }
      }

      return { id: cand.id, canonicalName: cand.canonicalName, score: Math.min(bestScore + employerBonus, 1.0) };
    })
    .sort((a, b) => b.score - a.score);

  const best = scoredCandidates[0];

  if (best && best.score >= CONFIDENT_THRESHOLD) {
    return { personId: best.id, candidates: scoredCandidates.slice(0, 5), isConfidentMatch: true };
  }

  // Partial match above review threshold: flag for recruiter confirmation
  if (scoredCandidates.length > 0 && scoredCandidates[0].score >= REVIEW_THRESHOLD) {
    return { candidates: scoredCandidates.slice(0, 3), isConfidentMatch: false };
  }

  return { isConfidentMatch: false }; // No plausible match -- new person
}

app.activity('ResumeBuilderCandidateMatches', {
  handler: async (input: any, _context: any) => {
    const { extractionRunId, extractedName = '', extractedEmployers = [], existingCandidates = [] } = input as any;
    console.log(`[PersonDedup] Checking candidate matches for run: ${extractionRunId}`);

    // In production: query Cosmos DB Persons container for aliases matching this name & employer pattern
    return resolvePersonDedup(extractedName, extractedEmployers, existingCandidates);
  },
});
