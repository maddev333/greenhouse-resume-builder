/** ResumeBuilderDiffEngine — compares bullet mappings between extraction runs via Cosmos queries. */

import crypto from 'crypto';
import { app } from 'durable-functions';
import type { BulletMapping, FactVersion } from '@greenhouse-resume-builder/shared';
import { queryAllBulletsByPerson } from '../persistence/index';
import { actx } from '../services/agent-runtime';

export type DiffStatus = 'added' | 'removed' | 'changed';

/** Single version diff result for a bullet candidate. */
export interface VersionDiffResult {
  signature:    string;      // stable bulletSignature
  status:       DiffStatus;
  previousText?: string;     // text from prior run (if applicable)
  currentText:   string;     // text from this run
  sectionId:    'experience' | 'skills' | 'education' | 'summary';
  citationIds:  string[];    // factVersionIds linked to this bullet
}

/** Classify bullet-text signatures between two runs (added / removed / changed). */
export function computeVersionDiffs(
  prevBullets:   Array<{ id: string; bulletSignature: string; bulletText: string }>,
  curBullets:    Array<{ sectionId: string; bulletSignature: string; bulletText: string; citationFactVersionIds: string[] }>,
): VersionDiffResult[] {

  const prevMap = new Map<string, { text: string }>();
  for (const b of prevBullets) {
    prevMap.set(b.bulletSignature, { text: b.bulletText });
  }

  const diffSet = new Set<string>();
  const results: VersionDiffResult[] = [];

  // Check current bullets against known versions from previous run
  for (const b of curBullets) {
    if (!prevMap.has(b.bulletSignature)) {
      results.push({ signature: b.bulletSignature, status: 'added', currentText: b.bulletText, sectionId: b.sectionId as VersionDiffResult['sectionId'], citationIds: b.citationFactVersionIds });
    } else if (prevMap.get(b.bulletSignature)!.text !== b.bulletText) {
      results.push({ signature: b.bulletSignature, status: 'changed', previousText: prevMap.get(b.bulletSignature)!.text, currentText: b.bulletText, sectionId: b.sectionId as VersionDiffResult['sectionId'], citationIds: b.citationFactVersionIds });
    }
    diffSet.add(b.bulletSignature);
  }

  // Check what was removed from this run's bullets (seen in prev but not in cur)  
  for (const [sig, data] of prevMap.entries()) {
    if (!diffSet.has(sig)) {
      results.push({ signature: sig, status: 'removed', previousText: data.text, currentText: '', citationIds: [], sectionId: '' as VersionDiffResult['sectionId'] });
    }
  }

  return results;
}

/** Compute bullet-level diffs between two extraction runs for a person. */
export async function computeDiffsForPerson(personId: string): Promise<VersionDiffResult[]> {
  // Query ALL bullets for this person across all runs (not just latest)
  const allBullets = await queryAllBulletsByPerson(personId);
  
  if (allBullets.length === 0) return [];
  
  // Group bullets by extraction run (preserving insertion order from Cosmos)
  const runsByRunId = new Map<string, BulletMapping[]>();
  for (const b of allBullets) {
    const list = runsByRunId.get(b.extractionRunId) || [];
    list.push(b);
    runsByRunId.set(b.extractionRunId, list);
  }
  
  // Sort runs chronologically by first bullet's creation date
  const runIds = [...runsByRunId.keys()]
    .sort((a, b) => {
      const aBullet = runsByRunId.get(a)![0];
      const bBullet = runsByRunId.get(b)![0];
      return (aBullet?.createdAt || '').localeCompare(bBullet?.createdAt || '');
    });

  if (runIds.length < 2) {
    // Only one run — no diffs possible, mark all bullets as "new"
    const latestRunId = runIds[0];
    const bulletsList = runsByRunId.get(latestRunId)!;
    return bulletsList.map(b => ({
      signature: b.bulletSignature,
      status: 'added' as const,
      currentText: b.bulletText,
      sectionId: b.sectionId as VersionDiffResult['sectionId'],
      citationIds: b.citationFactVersionIds,
    }));
  }
  
  // Take the two most recent runs for comparison
  const prevRunId = runIds[runIds.length - 2];
  const curRunId = runIds[runIds.length - 1];
  
  const prevBulletList = runsByRunId.get(prevRunId) || [];
  const curBulletList = runsByRunId.get(curRunId)!;
  
  const prevMapInput = prevBulletList.map(b => ({
    id: b.id,
    bulletSignature: b.bulletSignature,
    bulletText: b.bulletText,
  }));

  const curBullets = curBulletList.map(b => ({
    sectionId: b.sectionId as VersionDiffResult['sectionId'],
    bulletSignature: b.bulletSignature,
    bulletText: b.bulletText,
    citationFactVersionIds: b.citationFactVersionIds,
  }));

  return computeVersionDiffs(prevMapInput, curBullets);
}

/** ComparePriorVersionDiff — Durable Function activity for version diffs. */
export async function comparePriorVersionDiff(
  context: any,
  input: { runId: string; personId?: string },
): Promise<VersionDiffResult[]> {
  const runId = input.runId;
  const personId = input.personId;
  
  if (!personId) {
    context.logger.warn('[VersionDiffEngine] Person ID missing — cannot compute diffs');
    return [];
  }
  
  context.logger.info(`[VersionDiffEngine] Computing version diffs for person ${personId}`);
  return computeDiffsForPerson(personId);
}

app.activity('ComparePriorVersionDiff', {
  handler: (input: { runId: string; personId?: string }, context: any) =>
    comparePriorVersionDiff(actx(context), input),
});
