// ──────────────────────────────────────────────────────────────────────
// Generic repository backed by a PostgreSQL JSONB document table.
// Each entity is stored as `{ id TEXT PRIMARY KEY, data JSONB }`, mirroring
// the single-partition Cosmos containers the MVP previously used.
// ──────────────────────────────────────────────────────────────────────

import { getPool, physicalTable } from '../pg-client';

/** Back-compat envelope so callers can keep using `.resource`. */
export interface ItemResult<T> {
  resource: T;
}

export interface FindOptions {
  orderBy?: string; // top-level JSON field to sort on (ISO timestamps sort lexicographically)
  desc?: boolean;
  limit?: number;
}

export class Repo<T extends { id: string }> {
  protected readonly table: string;

  constructor(_dbName: string, containerName: string) {
    this.table = physicalTable(containerName);
  }

  // ── CRUD ──────────────────────────────────────────────────────

  /** Upsert (create-or-update) a document. */
  async upsert(doc: T): Promise<ItemResult<T>> {
    const pool = await getPool();
    const res = await pool.query(
      `INSERT INTO ${this.table} (id, data) VALUES ($1, $2::jsonb)
       ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data
       RETURNING data`,
      [doc.id, JSON.stringify(doc)],
    );
    return { resource: res.rows[0].data as T };
  }

  /** Read by id; returns null on miss. */
  async read(id: string): Promise<ItemResult<T> | null> {
    const pool = await getPool();
    const res = await pool.query(`SELECT data FROM ${this.table} WHERE id = $1`, [id]);
    if (res.rowCount === 0) return null;
    return { resource: res.rows[0].data as T };
  }

  /** Replace (full overwrite) by id. */
  async replace(id: string, doc: T): Promise<ItemResult<T>> {
    return this.upsert({ ...(doc as any), id } as T);
  }

  /** Delete by id. */
  async delete(id: string): Promise<void> {
    const pool = await getPool();
    await pool.query(`DELETE FROM ${this.table} WHERE id = $1`, [id]);
  }

  // ── Queries ───────────────────────────────────────────────────

  /**
   * Find documents matching a SQL `WHERE` clause written against the `data` JSONB
   * column (e.g. `data->>'personId' = $1`). Optional ordering/limit on a JSON field.
   */
  protected async findDocs<TOut = T>(where: string, params: any[] = [], opts?: FindOptions): Promise<TOut[]> {
    const pool = await getPool();
    let sql = `SELECT data FROM ${this.table}`;
    if (where) sql += ` WHERE ${where}`;
    if (opts?.orderBy) sql += ` ORDER BY data->>'${opts.orderBy}' ${opts.desc ? 'DESC' : 'ASC'}`;
    if (opts?.limit != null) sql += ` LIMIT ${Number(opts.limit)}`;
    const res = await pool.query(sql, params);
    return res.rows.map((r) => r.data as TOut);
  }

  /** Escape hatch for custom SQL that returns the `data` column. */
  protected async rawDocs<TOut = T>(sql: string, params: any[] = []): Promise<TOut[]> {
    const pool = await getPool();
    const res = await pool.query(sql, params);
    return res.rows.map((r) => r.data as TOut);
  }

  /** Escape hatch for custom SQL that returns arbitrary projected rows. */
  protected async rawRows<R = any>(sql: string, params: any[] = []): Promise<R[]> {
    const pool = await getPool();
    const res = await pool.query(sql, params);
    return res.rows as R[];
  }

  /** COUNT(*) with an optional `WHERE` clause over the `data` column. */
  async count(where?: string, params: any[] = []): Promise<number> {
    const pool = await getPool();
    let sql = `SELECT COUNT(*)::int AS n FROM ${this.table}`;
    if (where) sql += ` WHERE ${where}`;
    const res = await pool.query(sql, params);
    return res.rows[0].n as number;
  }

  // ── Helpers ───────────────────────────────────────────────────

  /** Upsert then return the resource. */
  async upsertAndGet(doc: T): Promise<T> {
    const r = await this.upsert(doc);
    return r.resource;
  }
}
