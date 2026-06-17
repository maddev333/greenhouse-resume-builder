import { Repo } from './base-repo';
import type { FactVersion } from '@greenhouse-resume-builder/shared';

const DB    = 'resumeBuilder';
const CONT = 'factVersions';

export class FactVersionRepo extends Repo<FactVersion> {
  constructor() { super(DB, CONT); }

  /** Latest version for a given person + section. */
  async latestByPersonSection(personId: string, sectionId: string): Promise<FactVersion | null> {
    const docs = await this.findDocs<FactVersion>(
      "data->>'personId' = $1 AND data->>'sectionId' = $2",
      [personId, sectionId],
      { orderBy: 'extractedAt', desc: true, limit: 1 },
    );
    return docs[0] ?? null;
  }

  /** All versions for a specific fact key. */
  async getByFactKey(personId: string, factKey: string): Promise<FactVersion[]> {
    return this.findDocs<FactVersion>(
      "data->>'personId' = $1 AND data->>'factKey' = $2",
      [personId, factKey],
      { orderBy: 'extractedAt', desc: true },
    );
  }

  /** All facts for a run. */
  async getByRun(runId: string): Promise<FactVersion[]> {
    return this.findDocs<FactVersion>("data->>'extractionRunId' = $1", [runId]);
  }

  /** All facts for a person + section, newest first. */
  async allByPersonSection(personId: string, sectionId: string): Promise<FactVersion[]> {
    return this.findDocs<FactVersion>(
      "data->>'personId' = $1 AND data->>'sectionId' = $2",
      [personId, sectionId],
      { orderBy: 'extractedAt', desc: true },
    );
  }

  async getById(id: string): Promise<FactVersion | null> { return (await this.read(id))?.resource ?? null; }

  /** Distinct extraction-run IDs for a person, most-recent fact first. */
  async distinctRunIdsByPerson(personId: string, limit?: number): Promise<string[]> {
    let sql = `SELECT data->>'extractionRunId' AS "runId", MAX(data->>'extractedAt') AS last
               FROM ${this.table}
               WHERE data->>'personId' = $1
               GROUP BY data->>'extractionRunId'
               ORDER BY last DESC`;
    if (limit != null) sql += ` LIMIT ${Number(limit)}`;
    const rows = await this.rawRows<{ runId: string | null }>(sql, [personId]);
    return rows.map((r) => r.runId).filter((v): v is string => !!v);
  }

  async createMany(facts: Partial<FactVersion>[]): Promise<void> {
    for (const f of facts) {
      if (!f.id) throw new Error('FactVersion must have id');
      await this.upsert(f as FactVersion);
    }
  }
}

export const factVersionRepo = new FactVersionRepo();
