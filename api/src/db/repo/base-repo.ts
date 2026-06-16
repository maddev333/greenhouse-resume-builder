// ──────────────────────────────────────────────────────────────────────
// Generic repository for a Cosmos DB container (fixed partition key `/id`)
// ──────────────────────────────────────────────────────────────────────

import type { ItemResponse, Container as CosmosContainer } from '@azure/cosmos';
import { getDatabase } from '../cosmos-client';

export class Repo<T extends { id: string }> {
  private container: Promise<CosmosContainer> | null = null;

  constructor(private dbName: string, private containerName: string) {}

  // lazy-load the container pointer
  private async container_(): Promise<CosmosContainer> {
    if (!this.container) this.container = getDatabase().then(db => db.container(this.containerName));
    return this.container;
  }

  // ── CRUD ──────────────────────────────────────────────────────

  /** Upsert (create-or-update) a document. */
  async upsert(doc: T): Promise<ItemResponse<T>> {
    const c = await this.container_();
    return (c.items.upsert<any>(doc)) as unknown as ItemResponse<T>;
  }

  /** Read by id; returns null on 404. */
  async read(id: string): Promise<ItemResponse<T> | null> {
    const c = await this.container_();
    try {
      return (await c.item(id, id).read<T>()) as unknown as ItemResponse<T>;
    } catch { return null; }
  }

  /** Replace (full overwrite) by id. */
  async replace(id: string, doc: T): Promise<ItemResponse<T>> {
    const c = await this.container_();
    return (await c.item(id, id).replace<T>(doc)) as unknown as ItemResponse<T>;
  }

  /** Delete by id. */
  async delete(id: string): Promise<void> {
    const c = await this.container_();
    await c.item(id, id).delete();
  }

  // ── Queries ───────────────────────────────────────────────────

  /** Run a parameterized SQL query; returns all resources. */
  async query<TOut = T>(spec: string | { sql?: string; parameters?: any[] }): Promise<TOut[]> {
    const c = await this.container_();
    const txt$1 = typeof spec === 'string' ? spec : ((spec as any).sql || (spec as any).query) || '';
    const prm3: any[] = (spec as any).parameters || [];
    const qs87 = { query: txt$1, ...(prm3.length ? { parameters: prm3 } : {}) };
    return (await c.items.query<TOut>(qs87 as any).fetchAll()).resources as TOut[];
  }

  // ── Helpers ───────────────────────────────────────────────────

  /** Upsert then return the resource. */
  async upsertAndGet(doc: T): Promise<T> {
    const r = await this.upsert(doc);
    return r.resource!;
  }
}
