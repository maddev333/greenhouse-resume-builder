import { Repo } from './base-repo';
import type { Relationship } from '@greenhouse-resume-builder/shared';

const DB    = 'resumeBuilder';
const CONT = 'relationships';

export class RelationshipRepo extends Repo<Relationship> {
  constructor() { super(DB, CONT); }

  async getById(id: string): Promise<Relationship | null> { return (await this.read(id))?.resource ?? null; }

  /** Suggested relationships for a person. */
  async suggested(personId: string): Promise<Relationship[]> {
    return this.findDocs<Relationship>(
      "data->>'status' = 'suggested' AND (data->>'fromPersonId' = $1 OR data->>'toPersonId' = $1)",
      [personId],
    );
  }

  /** Confirmed relationships for a person. */
  async confirmed(personId: string): Promise<Relationship[]> {
    return this.findDocs<Relationship>(
      "data->>'status' = 'confirmed' AND (data->>'fromPersonId' = $1 OR data->>'toPersonId' = $1)",
      [personId],
    );
  }

  /** Check if an edge already exists between two people. */
  async edgeExists(personA: string, personB: string): Promise<boolean> {
    const docs = await this.findDocs<Relationship>(
      "(data->>'fromPersonId' = $1 AND data->>'toPersonId' = $2) OR (data->>'fromPersonId' = $2 AND data->>'toPersonId' = $1)",
      [personA, personB],
      { limit: 1 },
    );
    return docs.length > 0;
  }

  async updateStatus(id: string, status: Relationship['status'], userId?: string): Promise<void> {
    const r = await this.read(id);
    if (!r) throw new Error('Relationship not found: ' + id);
    const prev: any = (r && r.resource) || {};
    const updated: any = { ...prev, status };
    if (status === 'confirmed') {
      (updated as any).confirmedByUserId = userId ?? 'system';
      (updated as any).confirmedAt       = new Date().toISOString();
    } else {
      (updated as any).rejectedByUserId = userId ?? 'system';
      (updated as any).rejectedAt       = new Date().toISOString();
    }
    await this.replace(id, updated);
  }

  async create(edge: Partial<Relationship> & { id: string }): Promise<void> {
    await this.upsert(edge as Relationship);
  }
}

export const relationshipRepo = new RelationshipRepo();
