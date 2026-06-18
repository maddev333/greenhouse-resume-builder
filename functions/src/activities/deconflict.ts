/**
 * Person deconfliction — merge multiple person records that share the same name
 * (and are therefore most likely the same individual) into a single canonical person.
 *
 * This is the cleanup counterpart to the create-time dedup in `person-dedup.ts`:
 *   - dedup PREVENTS new same-name duplicates at ingestion time;
 *   - deconfliction MERGES same-name duplicates that already exist in the graph.
 *
 * A merge re-points every fact / bullet / source-doc / annotation / extraction-run /
 * relationship from each duplicate onto the survivor, unions the aliases, drops self-loops
 * and redundant edges, then deletes the now-empty duplicate person shells. No fact, bullet
 * or relationship DATA is lost — only the duplicate person records and redundant edges.
 */

import { app } from 'durable-functions';
import * as persist from '../persistence/index';
import {
  type PersonLike,
  findDuplicateGroups,
  selectSurvivor,
  unionAliases,
  pickCanonicalName,
} from './deconflict-logic';

export {
  normalizePersonName,
  findDuplicateGroups,
  selectSurvivor,
  unionAliases,
  pickCanonicalName,
  type PersonLike,
} from './deconflict-logic';

export interface DeconflictInput {
  tenantId: string;
  /** When set, only the duplicate group containing this person is merged, and it is kept as survivor. */
  preferredPersonId?: string;
}

export interface DeconflictSummary {
  tenantId: string;
  groupsFound: number;
  personsMerged: number;
  edgesRemoved: number;
  survivors: Array<{ survivorId: string; survivorName: string; mergedIds: string[] }>;
  /** Set when `preferredPersonId` was itself merged away — the canonical id it now maps to. */
  remappedTo?: string;
}

/**
 * Find same-name duplicate persons in a tenant and merge each group into one canonical person.
 * Returns a summary describing what was merged. Safe to run repeatedly (idempotent once merged).
 */
export async function deconflictDuplicatePersons(input: DeconflictInput): Promise<DeconflictSummary> {
  const summary: DeconflictSummary = {
    tenantId: input.tenantId,
    groupsFound: 0,
    personsMerged: 0,
    edgesRemoved: 0,
    survivors: [],
  };

  const persons = (await persist.listPersonsByTenant(input.tenantId)) as PersonLike[];
  let groups = findDuplicateGroups(persons);

  // Pipeline use: restrict to the group containing the just-ingested person (low blast radius).
  if (input.preferredPersonId) {
    groups = groups.filter((g) => g.some((p) => p.id === input.preferredPersonId));
  }
  summary.groupsFound = groups.length;

  for (const group of groups) {
    const survivor = selectSurvivor(group, input.preferredPersonId);
    const duplicates = group.filter((p) => p.id !== survivor.id);
    if (duplicates.length === 0) continue;

    for (const dup of duplicates) {
      await persist.reassignPersonReferences(dup.id, survivor.id);
    }

    const existing = await persist.getPerson(survivor.id);
    const canonicalName = pickCanonicalName(group, survivor);
    await persist.upsertPerson({
      ...(existing ?? {}),
      id: survivor.id,
      tenantId: input.tenantId,
      canonicalName,
      aliases: unionAliases(group),
      dedupStatus: 'system_matched',
      systemMatchScore: 1,
      createdAt: existing?.createdAt ?? survivor.createdAt ?? new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    } as any);

    for (const dup of duplicates) await persist.deletePersonDoc(dup.id);
    summary.edgesRemoved += await persist.cleanupRelationshipsForPerson(survivor.id);

    summary.personsMerged += duplicates.length;
    summary.survivors.push({ survivorId: survivor.id, survivorName: canonicalName, mergedIds: duplicates.map((d) => d.id) });

    if (
      input.preferredPersonId &&
      survivor.id !== input.preferredPersonId &&
      duplicates.some((d) => d.id === input.preferredPersonId)
    ) {
      summary.remappedTo = survivor.id;
    }
  }

  return summary;
}

app.activity('DeconflictDuplicatePersons', {
  handler: (input: DeconflictInput, _context: any) => deconflictDuplicatePersons(input),
});
