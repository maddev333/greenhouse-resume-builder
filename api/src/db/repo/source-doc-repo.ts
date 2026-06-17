import { Repo } from './base-repo';
import type { SourceDocument } from '@greenhouse-resume-builder/shared';

const DB    = 'resumeBuilder';
const CONT = 'sourceDocuments';

export class SourceDocRepo extends Repo<SourceDocument> {
  constructor() { super(DB, CONT); }

  async getByRun(runId: string): Promise<SourceDocument[]> {
    return this.findDocs<SourceDocument>("data->>'extractionRunId' = $1", [runId]);
  }

  async getById(id: string): Promise<SourceDocument | null> { return (await this.read(id))?.resource ?? null; }

  /** All source docs for a person. */
  async allByPerson(personId: string): Promise<SourceDocument[]> {
    return this.findDocs<SourceDocument>("data->>'personId' = $1", [personId]);
  }

  /** Find source documents of a specific type. */
  async getByTypeAndRun(sourceType: 'web' | 'upload', runId: string): Promise<SourceDocument[]> {
    return this.findDocs<SourceDocument>(
      "data->>'sourceType' = $1 AND data->>'extractionRunId' = $2",
      [sourceType, runId],
    );
  }

  async create(doc: Partial<SourceDocument> & { id: string }): Promise<void> {
    await this.upsert(doc as SourceDocument);
  }
}

export const sourceDocRepo = new SourceDocRepo();
