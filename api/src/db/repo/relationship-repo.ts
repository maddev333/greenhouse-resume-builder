import { Repo } from './base-repo';
import type { Relationship } from '@greenhouse-resume-builder/shared';

const DB    = 'resumeBuilder';
const CONT = 'relationships';

export class RelationshipRepo extends Repo<Relationship> {
  constructor() { super(DB, CONT); }

  async getById(id: string): Promise<Relationship | null> { return (await this.read(id))?.resource ?? null; }

  /** Suggested relationships for a person. */
  async suggested(personId: string): Promise<Relationship[]> {
    const docs = await this.query({
      sql: "SELECT * FROM c WHERE c.status = @s AND (c.fromPersonId = @p OR c.toPersonId = @p)",
      parameters: [{ name: '@s', value: 'suggested' }, { name: '@p', value: personId }],
    });
    return (docs as unknown as Relationship[]);
  }

  /** Confirmed relationships for a person. */
  async confirmed(personId: string): Promise<Relationship[]> {
    const docs = await this.query({
      sql: "SELECT * FROM c WHERE c.status = @s AND (c.fromPersonId = @p OR c.toPersonId = @p)",
      parameters: [{ name: '@s', value: 'confirmed' }, { name: '@p', value: personId }],
    });
    return (docs as unknown as Relationship[]);
  }

  /** Check if an edge already exists between two people. */
  async edgeExists(personA: string, personB: string): Promise<boolean> {
    const docs = await this.query({
      sql: "SELECT TOP 1 c.id FROM c WHERE (c.fromPersonId = @a AND c.toPersonId = @b) OR (c.fromPersonId = @b AND c.toPersonId = @a)",
      parameters: [{ name: '@a', value: personA }, { name: '@b', value: personB }],
    });
    return !!(docs as unknown as any[])[0];
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
    const doc = { ...edge, partitionKey: edge.id } as unknown as Relationship;
    await this.upsert(doc);
  }
}

export const relationshipRepo = new RelationshipRepo();
