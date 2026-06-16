import { Repo } from './base-repo';
import type { FactVersion } from '@greenhouse-resume-builder/shared';

const DB    = 'resumeBuilder';
const CONT = 'factVersions';

export class FactVersionRepo extends Repo<FactVersion> {
  constructor() { super(DB, CONT); }

  /** Latest version for a given person + section. */
  async latestByPersonSection(personId: string, sectionId: string): Promise<FactVersion | null> {
    const docs = await this.query({
      sql: 'SELECT TOP 1 * FROM c WHERE c.personId = @p AND c.sectionId = @s ORDER BY c.extractedAt DESC',
      parameters: [{ name: '@p', value: personId }, { name: '@s', value: sectionId }],
    });
    return (docs[0] as unknown as FactVersion) ?? null;
  }

  /** All versions for a specific fact key. */
  async getByFactKey(personId: string, factKey: string): Promise<FactVersion[]> {
    const docs = await this.query({
      sql: 'SELECT * FROM c WHERE c.personId = @p AND c.factKey = @k ORDER BY c.extractedAt DESC',
      parameters: [{ name: '@p', value: personId }, { name: '@k', value: factKey }],
    });
    return (docs as unknown as FactVersion[]);
  }

  /** All facts for a run. */
  async getByRun(runId: string): Promise<FactVersion[]> {
    const docs = await this.query({
      sql: 'SELECT * FROM c WHERE c.extractionRunId = @r',
      parameters: [{ name: '@r', value: runId }],
    });
    return (docs as unknown as FactVersion[]);
  }

  /** All facts for a person + section, newest first. */
  async allByPersonSection(personId: string, sectionId: string): Promise<FactVersion[]> {
    const docs = await this.query({
      sql: 'SELECT * FROM c WHERE c.personId = @p AND c.sectionId = @s ORDER BY c.extractedAt DESC',
      parameters: [{ name: '@p', value: personId }, { name: '@s', value: sectionId }],
    });
    return (docs as unknown as FactVersion[]);
  }

  async getById(id: string): Promise<FactVersion | null> { return (await this.read(id))?.resource ?? null; }

  async createMany(facts: Partial<FactVersion>[]): Promise<void> {
    const c = await (this as any).getContainer();
    for (const f of facts) {
      // Repo.upsert handles id-as-partition; use it directly.
      
    }
  }
}

export const factVersionRepo = new FactVersionRepo();
