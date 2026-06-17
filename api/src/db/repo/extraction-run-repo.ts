import { Repo } from './base-repo';
import type { ExtractionRun } from '@greenhouse-resume-builder/shared';

const DB    = 'resumeBuilder';
const CONT = 'extractionRuns';

export class ExtractionRunRepo extends Repo<ExtractionRun> {
  constructor() { super(DB, CONT); }

  /** Create a new run in the requested state (stubs default to `queued`). */
  async create(input: Partial<ExtractionRun>): Promise<ExtractionRun> {
    const now = new Date().toISOString();
    const doc: ExtractionRun = {
      id:                input.id                ?? `run_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      tenantId:          input.tenantId          ?? 'tenant',
      requestedByUserId: input.requestedByUserId  ?? 'system',
      status:            'queued'                    as const,
      sourceDocumentIds: input.sourceDocumentIds  ?? [],
      createdAt:         input.createdAt           ?? now,
    } as any;
    return this.upsertAndGet(doc);
  }

  async updateStatus(runId: string, status: ExtractionRun['status'], extra?: Partial<ExtractionRun>): Promise<void> {
    const r = await this.read(runId);
    if (!r) throw new Error('ExtractionRun not found: ' + runId);
    const prev: any = (r ? (r.resource as ExtractionRun | null) : null) || {};

    await this.replace(runId, { ...prev, status, updatedAt: new Date().toISOString(), ...extra });
  }

  async getById(runId: string): Promise<ExtractionRun | null> { return (await this.read(runId))?.resource ?? null; }

  /** Return the most recent completed / active run for a person. */
  async latestByPerson(personId: string): Promise<ExtractionRun | null> {
    const docs = await this.findDocs<ExtractionRun>(
      "data->>'personId' = $1",
      [personId],
      { orderBy: 'createdAt', desc: true, limit: 1 },
    );
    return docs[0] ?? null;
  }

  /** All runs for a tenant, newest first. */
  async allByTenant(tenantId: string): Promise<ExtractionRun[]> {
    return this.findDocs<ExtractionRun>(
      "data->>'tenantId' = $1",
      [tenantId],
      { orderBy: 'createdAt', desc: true },
    );
  }

  /** Active (queued / in-progress) runs for a tenant, newest first. */
  async activeByTenant(tenantId: string): Promise<ExtractionRun[]> {
    return this.findDocs<ExtractionRun>(
      "data->>'tenantId' = $1 AND data->>'status' IN ('queued', 'in_progress')",
      [tenantId],
      { orderBy: 'createdAt', desc: true },
    );
  }

  /** Most recent runs across all tenants, newest first. */
  async recentAll(limit = 50): Promise<ExtractionRun[]> {
    return this.findDocs<ExtractionRun>('', [], { orderBy: 'createdAt', desc: true, limit });
  }
}

export const extractionRunRepo = new ExtractionRunRepo();
