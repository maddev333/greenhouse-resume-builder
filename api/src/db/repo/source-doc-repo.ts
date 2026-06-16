import { Repo } from './base-repo';
import type { SourceDocument } from '@greenhouse-resume-builder/shared';

const DB    = 'resumeBuilder';
const CONT = 'sourceDocuments';

export class SourceDocRepo extends Repo<SourceDocument> {
  constructor() { super(DB, CONT); }

  async getByRun(runId: string): Promise<SourceDocument[]> {
    const docs = await this.query({
      sql: 'SELECT * FROM c WHERE c.extractionRunId = @r',
      parameters: [{ name: '@r', value: runId }],
    });
    return (docs as unknown as SourceDocument[]);
  }

  async getById(id: string): Promise<SourceDocument | null> { return (await this.read(id))?.resource ?? null; }

  /** All source docs for a person. */
  async allByPerson(personId: string): Promise<SourceDocument[]> {
    const docs = await this.query({
      sql: 'SELECT * FROM c WHERE c.personId = @p',
      parameters: [{ name: '@p', value: personId }],
    });
    return (docs as unknown as SourceDocument[]);
  }

  /** Find source documents of a specific type. */
  async getByTypeAndRun(sourceType: 'web' | 'upload', runId: string): Promise<SourceDocument[]> {
    const docs = await this.query({
      sql: "SELECT * FROM c WHERE c.sourceType = @t AND c.extractionRunId = @r",
      parameters: [{ name: '@t', value: sourceType }, { name: '@r', value: runId }],
    });
    return (docs as unknown as SourceDocument[]);
  }

  async create(doc: Partial<SourceDocument> & { id: string }): Promise<void> {
    const item = { ...doc, partitionKey: doc.id } as unknown as SourceDocument;
    await this.upsert(item);
  }
}

export const sourceDocRepo = new SourceDocRepo();
