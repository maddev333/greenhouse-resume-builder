import { Repo } from './base-repo';
import type { BulletMapping } from '@greenhouse-resume-builder/shared';

const DB    = 'resumeBuilder';
const CONT = 'bulletMappings';

export class BulletMappingRepo extends Repo<BulletMapping> {
  constructor() { super(DB, CONT); }

  /** All current bullets for a person + section. */
  async allByPersonSection(personId: string, sectionId: string): Promise<BulletMapping[]> {
    return this.findDocs<BulletMapping>(
      "data->>'personId' = $1 AND data->>'sectionId' = $2",
      [personId, sectionId],
    );
  }

  /** Latest bullet text with citations for a specific bullet key. */
  async latestByKey(personId: string, bulletKey: string): Promise<BulletMapping | null> {
    const docs = await this.findDocs<BulletMapping>(
      "data->>'personId' = $1 AND data->>'bulletSignature' = $2",
      [personId, bulletKey],
      { orderBy: 'createdAt', desc: true, limit: 1 },
    );
    return docs[0] ?? null;
  }

  /** All latest bullets for a person across all sections. */
  async latestAllByPerson(personId: string): Promise<BulletMapping[]> {
    return this.findDocs<BulletMapping>(
      "data->>'personId' = $1 AND (data->>'latestForBullet')::boolean = true",
      [personId],
    );
  }

  /** Bullets from a specific extraction run. */
  async allByRun(runId: string): Promise<BulletMapping[]> {
    return this.findDocs<BulletMapping>("data->>'extractionRunId' = $1", [runId]);
  }

  /** Bullets from a specific extraction run, scoped to a single section. */
  async allByRunAndSection(runId: string, sectionId: string): Promise<BulletMapping[]> {
    return this.findDocs<BulletMapping>(
      "data->>'extractionRunId' = $1 AND data->>'sectionId' = $2",
      [runId, sectionId],
    );
  }

  async getById(id: string): Promise<BulletMapping | null> { return (await this.read(id))?.resource ?? null; }

  async create(mapping: Partial<BulletMapping> & { id: string }): Promise<void> {
    await this.upsert(mapping as BulletMapping);
  }

  async createMany(mappings: Partial<BulletMapping>[]): Promise<void> {
    for (const m of mappings) {
      if (!m.id) throw new Error('BulletMapping must have id');
      await this.upsert(m as BulletMapping);
    }
  }
}

export const bulletMappingRepo = new BulletMappingRepo();
