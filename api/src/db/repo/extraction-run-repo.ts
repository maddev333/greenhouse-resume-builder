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
    const docs = await this.query({
      sql: 'SELECT TOP 1 * FROM c WHERE c.personId = @p ORDER BY c.createdAt DESC',
      parameters: [{ name: '@p', value: personId }],
    });
    return (docs[0] as unknown as ExtractionRun) ?? null;
  }

  /** All runs for a tenant, newest first. */
  async allByTenant(tenantId: string): Promise<ExtractionRun[]> {
    const docs = await this.query({
      sql: 'SELECT * FROM c WHERE c.tenantId = @t ORDER BY c.createdAt DESC',
      parameters: [{ name: '@t', value: tenantId }],
    });
    return (docs as unknown as ExtractionRun[]);
  }
}

export const extractionRunRepo = new ExtractionRunRepo();
