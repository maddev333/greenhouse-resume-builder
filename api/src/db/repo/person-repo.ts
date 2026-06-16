import { Repo } from './base-repo';
import type { Person } from '@greenhouse-resume-builder/shared';

const DB    = 'resumeBuilder';
const CONT = 'persons';

export class PersonRepo extends Repo<Person> {
  constructor() { super(DB, CONT); }

  async getById(id: string): Promise<Person | null> { return (await this.read(id))?.resource ?? null; }

  /** Find candidates where name partially matches. */
  async searchByName(nameSearch: string): Promise<Person[]> {
    const docs = await this.query({
      sql: 'SELECT * FROM c WHERE ARRAY_CONTAINS(c.aliases, @s) OR CONTAINS(LOWER(c.canonicalName), LOWER(@s))',
      parameters: [{ name: '@s', value: nameSearch }],
    });
    return (docs as unknown as Person[]);
  }

  /** All persons in the tenant. */
  async allByTenant(tenantId: string): Promise<Person[]> {
    const docs = await this.query({
      sql: 'SELECT * FROM c WHERE c.tenantId = @t',
      parameters: [{ name: '@t', value: tenantId }],
    });
    return (docs as unknown as Person[]);
  }

  async upsert(person: Partial<Person> & { id: string }) {
    const fullDoc = { ...person, tenantId: (person as any).tenantId || 'system', id: person.id } as unknown as Person;
    return super.upsert(fullDoc);
  }
}

export const personRepo = new PersonRepo();
