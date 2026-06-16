/** ResumeRelationshipInference — shared-employer matching between extraction runs via Cosmos queries. */

import { app } from 'durable-functions';
import type { Relationship } from '@greenhouse-resume-builder/shared';
import { queryAllFacts, queryBulletsByPerson, queryRelationshipsForPerson, upsertRelationship, updateExtractionRunStatus } from '../persistence/index';
import { generateId } from '@greenhouse-resume-builder/shared';

export interface RelationshipSuggestion {
  toPersonId: string;
  confidence: number;
  relationshipType?: string;
  evidence: Array<{ employerName: string; fromRun: string; toRun: string }>;
}

/** Match persons who share an employer with the extraction target. Uses real Cosmos queries. */
async function findCandidateMatchingPersons(
  personId: string,
  runId: string,
): Promise<RelationshipSuggestion[]> {
  // Get all employers for this person's current run
  const currentFacts = await queryAllFacts();
  const currentEmployers = new Set<string>();
  
  for (const f of currentFacts) {
    if (f.personId !== personId || f.extractionRunId !== runId) continue;
    if (!f.factKey?.startsWith('employment.')) continue;
    
    const val = typeof f.factValue === 'string' ? f.factValue : String(f.factValue);
    currentEmployers.add(val.trim().toLowerCase().replace(/[.,]/g, ''));
  }

  if (currentEmployers.size === 0) return [];

  // Build a map of all persons who share any employer with our target person
  const personEmployers = new Map<string, Set<string>>();
  const personRuns = new Map<string, string[]>();
  
  for (const f of currentFacts) {
    if (f.personId === personId || !f.factKey?.startsWith('employment.')) continue;
    
    const val = typeof f.factValue === 'string' ? f.factValue : String(f.factValue);
    const normalized = val.trim().toLowerCase().replace(/[.,]/g, '');
    
    if (currentEmployers.has(normalized)) {
      let employers = personEmployers.get(f.personId);
      if (!employers) {
        employers = new Set<string>();
        personEmployers.set(f.personId, employers);
      }
      employers.add(normalized);
      
      // Track extraction runs for this person
      const runs = personRuns.get(f.personId) || [];
      if (!runs.includes(f.extractionRunId)) {
        runs.push(f.extractionRunId);
        personRuns.set(f.personId, runs);
      }
    }
  }

  // Filter out already-confirmed or rejected relationships
  const existingRelationships = await queryRelationshipsForPerson(personId);
  const blockedIds = new Set<string>();
  for (const r of existingRelationships) {
    if (r.status === 'confirmed' || r.status === 'rejected') {
      const otherSideId = otherSide(r, personId);
      if (otherSideId) blockedIds.add(otherSideId);
    }
  }

  // Convert to suggestions with confidence scoring
  const results: RelationshipSuggestion[] = [];
  
  for (const [candidatePersonId, sharedEmployers] of personEmployers.entries()) {
    if (blockedIds.has(candidatePersonId)) continue;
    
    const evidence: RelationshipSuggestion['evidence'] = [];
    for (const employer of sharedEmployers) {
      // Find the matching fact's run ID
      const matchFacts = currentFacts.filter((f: any) => 
        f.factKey?.startsWith('employment.') &&
        f.personId === candidatePersonId &&
        typeof f.factValue === 'string' &&
        f.factValue.trim().toLowerCase().replace(/[.,]/g, '') === employer
      );
      
      const toRun = matchFacts[0]?.extractionRunId || '';

      // Avoid duplicate evidence entries for same employer
      if (!evidence.some(e => e.employerName.toLowerCase() === employer)) {
        evidence.push({
          employerName: employer.charAt(0).toUpperCase() + employer.slice(1),
          fromRun: runId,
          toRun,
        });
      }
    }

    // Confidence scales with number of shared employers (capped at 95%)
    const confidence = Math.min(0.65 + sharedEmployers.size * 0.12, 0.95);
    
    results.push({
      toPersonId: candidatePersonId,
      confidence,
      relationshipType: 'shared_employer',
      evidence,
    });
  }

  return results;
}

function otherSide(r: Relationship, self: string): string {
  if (r.fromPersonId === self) return r.toPersonId;
  if (r.toPersonId === self) return r.fromPersonId;
  return '';
}

/** Infer relationships and optionally persist them as 'suggested' edges. */
export async function inferRelationshipsForMatchingPersons(
  _context: any,
  input: { runId: string; personId: string },
): Promise<RelationshipSuggestion[]> {
  const suggestions = await findCandidateMatchingPersons(input.personId, input.runId);
  
  // Persist as suggested relationships for UI display
  for (const s of suggestions) {
    try {
      const rel: Relationship = {
        id: generateId(),
        tenantId: 'tenant-default',
        fromPersonId: input.personId,
        toPersonId: s.toPersonId,
        relationshipType: 'shared_employer',
        status: 'suggested',
        inferredByAgent: true,
        confidence: s.confidence,
        evidenceFactVersionIds: [], // Will be populated when confirmed
        evidenceSourceDocumentIds: [],
      };
      await upsertRelationship(rel);
    } catch (err: any) {
      console.warn('[ResRelInference] Persist suggestion failed:', err.message);
    }
  }

  return suggestions;
}

app.activity('InferRelationshipsForMatchingPersons', {
  handler: (input: any, context: any) => inferRelationshipsForMatchingPersons(context, input),
});

/** Durable function helper to update extraction run status */
export async function updateRunStatus(
  _context: any,
  input: { runId: string; status: 'queued' | 'in_progress' | 'completed' | 'failed'; personId?: string; sourceDocumentIds?: string[]; failedReason?: string },
): Promise<void> {
  const extra: any = { ...input, updatedAt: new Date().toISOString() };
  if (input.status === 'completed') extra.completedAt = extra.completedAt ?? new Date().toISOString();
  await updateExtractionRunStatus(input.runId, input.status, extra);
}

app.activity('UpdateExtractionRunStatus', {
  handler: (input: any, context: any) => updateRunStatus(context, input),
});
