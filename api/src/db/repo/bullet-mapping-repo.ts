import { Repo } from './base-repo';
import type { BulletMapping } from '@greenhouse-resume-builder/shared';

const DB    = 'resumeBuilder';
const CONT = 'bulletMappings';

export class BulletMappingRepo extends Repo<BulletMapping> {
  constructor() { super(DB, CONT); }

  /** All current bullets for a person + section. */
  async allByPersonSection(personId: string, sectionId: string): Promise<BulletMapping[]> {
    const docs = await this.query({
      sql: 'SELECT * FROM c WHERE c.personId = @p AND c.sectionId = @s',
      parameters: [{ name: '@p', value: personId }, { name: '@s', value: sectionId }],
    });
    return (docs as unknown as BulletMapping[]);
  }

  /** Latest bullet text with citations for a specific bullet key. */
  async latestByKey(personId: string, bulletKey: string): Promise<BulletMapping | null> {
    const docs = await this.query({
      sql: 'SELECT TOP 1 * FROM c WHERE c.personId = @p AND c.bulletSignature = @k ORDER BY c.createdAt DESC',
      parameters: [{ name: '@p', value: personId }, { name: '@k', value: bulletKey }],
    });
    return (docs[0] as unknown as BulletMapping) ?? null;
  }

  /** All latest bullets for a person across all sections. */
  async latestAllByPerson(personId: string): Promise<BulletMapping[]> {
    const docs = await this.query({
      sql: 'SELECT * FROM c WHERE c.personId = @p AND c.latestForBullet = true',
      parameters: [{ name: '@p', value: personId }],
    });
    return (docs as unknown as BulletMapping[]);
  }

  /** Bullets from a specific extraction run. */
  async allByRun(runId: string): Promise<BulletMapping[]> {
    const docs = await this.query({
      sql: 'SELECT * FROM c WHERE c.extractionRunId = @r',
      parameters: [{ name: '@r', value: runId }],
    });
    return (docs as unknown as BulletMapping[]);
  }

  async getById(id: string): Promise<BulletMapping | null> { return (await this.read(id))?.resource ?? null; }

  async create(mapping: Partial<BulletMapping> & { id: string }): Promise<void> {
    const doc = { ...mapping, partitionKey: mapping.id } as unknown as BulletMapping;
    await this.upsert(doc);
  }

  async createMany(mappings: Partial<BulletMapping>[]): Promise<void> {
    const c = await (this as any).getContainer();
    for (const m of mappings) {
      const doc = { ...m, partitionKey: (m as any).id! } as unknown as BulletMapping;
      await c.items.upsert(doc);
    }
  }
}

export const bulletMappingRepo = new BulletMappingRepo();
