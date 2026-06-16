import { Repo } from './base-repo';
import type { Annotation } from '@greenhouse-resume-builder/shared';

const DB    = 'resumeBuilder';
const CONT = 'annotations';

export class AnnotationRepo extends Repo<Annotation> {
  constructor() { super(DB, CONT); }

  async getById(id: string): Promise<Annotation | null> { return (await this.read(id))?.resource ?? null; }

  /** Recent annotations for a factVersion. */
  async byFactVersion(factVersionId: string, limit = 50): Promise<Annotation[]> {
    const docs = await this.query({
      sql: 'SELECT TOP @lim * FROM c WHERE c.targetFactVersionId = @f ORDER BY c.createdAt DESC',
      parameters: [{ name: '@f', value: factVersionId }, { name: '@lim', value: limit }],
    });
    return (docs as unknown as Annotation[]);
  }

  /** Recent annotations for a person. */
  async byPerson(personId: string, limit = 100): Promise<Annotation[]> {
    const docs = await this.query({
      sql: 'SELECT TOP @lim * FROM c WHERE c.personId = @p ORDER BY c.createdAt DESC',
      parameters: [{ name: '@p', value: personId }, { name: '@lim', value: limit }],
    });
    return (docs as unknown as Annotation[]);
  }

  async createMany(annotations: Partial<Annotation>[]): Promise<void> {
    const c = await (this as any).getContainer();
    for (const a of annotations) {
      const doc = { ...a, partitionKey: (a as any).id! } as unknown as Annotation;
      await c.items.upsert(doc);
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
