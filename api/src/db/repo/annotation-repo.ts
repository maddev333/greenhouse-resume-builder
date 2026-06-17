import { Repo } from './base-repo';
import type { Annotation } from '@greenhouse-resume-builder/shared';

const DB    = 'resumeBuilder';
const CONT = 'annotations';

export class AnnotationRepo extends Repo<Annotation> {
  constructor() { super(DB, CONT); }

  async getById(id: string): Promise<Annotation | null> { return (await this.read(id))?.resource ?? null; }

  /** Recent annotations for a factVersion. */
  async byFactVersion(factVersionId: string, limit = 50): Promise<Annotation[]> {
    return this.findDocs<Annotation>(
      "data->>'targetFactVersionId' = $1",
      [factVersionId],
      { orderBy: 'createdAt', desc: true, limit },
    );
  }

  /** Recent annotations for a person. */
  async byPerson(personId: string, limit = 100): Promise<Annotation[]> {
    return this.findDocs<Annotation>(
      "data->>'personId' = $1",
      [personId],
      { orderBy: 'createdAt', desc: true, limit },
    );
  }

  async createMany(annotations: Partial<Annotation>[]): Promise<void> {
    for (const a of annotations) {
      if (!a.id) throw new Error('Annotation must have id');
      await this.upsert(a as Annotation);
    }
  }

  async updateStatus(id: string, status: 'open' | 'resolved'): Promise<void> {
    const r = await this.read(id);
    if (!r) throw new Error('Annotation not found: ' + id);
    const existing = r.resource as Annotation;
    await this.replace(id, { ...existing, status } as unknown as Annotation);
  }
}

export const annotationRepo = new AnnotationRepo();
