import pg from 'pg';
import { config } from '../config';

// numeric/bigint arrive as strings by default; amounts in this app stay far
// below 2^53 and are rounded to 2-4 decimals, so JS numbers are safe.
pg.types.setTypeParser(pg.types.builtins.NUMERIC, (v) => Number(v));
pg.types.setTypeParser(pg.types.builtins.INT8, (v) => Number(v));
pg.types.setTypeParser(pg.types.builtins.DATE, (v) => v);

/** Runtime pool. Connects as the non-superuser, non-BYPASSRLS app role. */
export const appPool = new pg.Pool({ connectionString: config.databaseUrl, max: config.dbPoolMax });
// An idle connection dropped by a DB restart must not crash the process; the pool reconnects.
appPool.on('error', (err) => console.error('PostgreSQL pool error:', err.message));

export class Db {
  constructor(readonly client: pg.ClientBase) {}

  async many<T = any>(text: string, params: unknown[] = []): Promise<T[]> {
    const res = await this.client.query(text, params as any[]);
    return res.rows as T[];
  }

  async maybe<T = any>(text: string, params: unknown[] = []): Promise<T | null> {
    const rows = await this.many<T>(text, params);
    return rows[0] ?? null;
  }

  async one<T = any>(text: string, params: unknown[] = []): Promise<T> {
    const row = await this.maybe<T>(text, params);
    if (!row) throw new Error('Query returned no rows');
    return row;
  }

  async exec(text: string, params: unknown[] = []): Promise<number> {
    const res = await this.client.query(text, params as any[]);
    return res.rowCount ?? 0;
  }

  /** Switches the transaction-local tenant context (used when provisioning a tenant). */
  async setTenant(tenantId: string): Promise<void> {
    await this.client.query(`SELECT set_config('app.tenant_id', $1, true)`, [tenantId]);
  }
}

type ContextKey = 'app.tenant_id' | 'app.user_id' | 'app.platform';
export type DbContext = Partial<Record<ContextKey, string>>;

/**
 * Runs fn inside a transaction with transaction-local context settings.
 * set_config(..., true) is reset at COMMIT/ROLLBACK, so a pooled connection
 * can never carry one tenant's context into another request.
 */
export async function transaction<T>(context: DbContext, fn: (db: Db) => Promise<T>, pool: pg.Pool = appPool): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const keys = Object.keys(context) as ContextKey[];
    if (keys.length) {
      const calls = keys.map((_, i) => `set_config($${i * 2 + 1}, $${i * 2 + 2}, true)`).join(', ');
      await client.query(`SELECT ${calls}`, keys.flatMap((k) => [k, context[k] ?? '']));
    }
    const result = await fn(new Db(client));
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

/** Tenant-scoped work: RLS limits every query to this tenant. */
export function withTenant<T>(ctx: { tenantId: string; userId?: string | null }, fn: (db: Db) => Promise<T>) {
  return transaction({ 'app.tenant_id': ctx.tenantId, 'app.user_id': ctx.userId ?? '' }, fn);
}

/** No tenant selected: the user can see only their own memberships and tenants. */
export function withUser<T>(userId: string, fn: (db: Db) => Promise<T>) {
  return transaction({ 'app.user_id': userId }, fn);
}

/** Platform administration. Grants access to the tenants table only, never to tenant data. */
export function withPlatform<T>(userId: string | null, fn: (db: Db) => Promise<T>) {
  return transaction({ 'app.platform': 'on', 'app.user_id': userId ?? '' }, fn);
}

/** Global identity tables only (users, sessions, auth events). Tenant tables return nothing. */
export function withSystem<T>(fn: (db: Db) => Promise<T>) {
  return transaction({}, fn);
}
