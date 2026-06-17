import { Repo } from './base-repo';
import type { Person } from '@greenhouse-resume-builder/shared';

const DB    = 'resumeBuilder';
const CONT = 'persons';

export class PersonRepo extends Repo<Person> {
  constructor() { super(DB, CONT); }

  async getById(id: string): Promise<Person | null> { return (await this.read(id))?.resource ?? null; }

  /** Find candidates where name partially matches. */
  async searchByName(nameSearch: string): Promise<Person[]> {
    return this.findDocs<Person>(
      "data->'aliases' @> to_jsonb($1::text) OR LOWER(data->>'canonicalName') LIKE '%' || LOWER($1) || '%'",
      [nameSearch],
    );
  }

  /** All persons in the tenant. */
  async allByTenant(tenantId: string): Promise<Person[]> {
    return this.findDocs<Person>("data->>'tenantId' = $1", [tenantId]);
  }

  async upsert(person: Partial<Person> & { id: string }) {
    const fullDoc = { ...person, tenantId: (person as any).tenantId || 'system', id: person.id } as unknown as Person;
    return super.upsert(fullDoc);
  }
}

export const personRepo = new PersonRepo();
