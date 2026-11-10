/**
 * Guards the multi-tenant schema as it grows: any new table must either be
 * an explicitly listed platform table or carry tenant_id with FORCEd RLS.
 */
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { adminClient } from './helpers';
import { testUrls } from './urls';

const PLATFORM_TABLES = ['tenants', 'users', 'sessions', 'auth_events', 'platform_audit_log', 'schema_migrations'];

let admin: pg.Client;
beforeAll(async () => {
  admin = await adminClient();
});
afterAll(async () => {
  await admin.end();
});

describe('Tenant schema guard', () => {
  it('every non-platform table is tenant-owned with forced RLS and a policy', async () => {
    const { rows } = await admin.query(`
      SELECT c.relname AS table, c.relrowsecurity AS rls, c.relforcerowsecurity AS forced,
             EXISTS (SELECT 1 FROM information_schema.columns col
                     WHERE col.table_schema = 'public' AND col.table_name = c.relname AND col.column_name = 'tenant_id') AS has_tenant,
             (SELECT count(*) FROM pg_policies p WHERE p.schemaname = 'public' AND p.tablename = c.relname) AS policies
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind = 'r'`);
    const offenders = rows
      .filter((r) => !PLATFORM_TABLES.includes(r.table))
      .filter((r) => !r.has_tenant || !r.rls || !r.forced || Number(r.policies) === 0)
      .map((r) => r.table);
    expect(offenders).toEqual([]);
    expect(rows.length).toBeGreaterThan(40);
  });

  it('every foreign key between tenant tables includes tenant_id', async () => {
    const { rows } = await admin.query(`
      SELECT con.conname, rel.relname AS child, frel.relname AS parent,
             (SELECT array_agg(att.attname) FROM unnest(con.conkey) k JOIN pg_attribute att
                ON att.attrelid = con.conrelid AND att.attnum = k) AS cols
      FROM pg_constraint con
      JOIN pg_class rel ON rel.oid = con.conrelid
      JOIN pg_class frel ON frel.oid = con.confrelid
      JOIN pg_namespace n ON n.oid = rel.relnamespace
      WHERE con.contype = 'f' AND n.nspname = 'public'`);
    const unsafe = rows
      .filter((r) => !PLATFORM_TABLES.includes(r.child) && !['tenants', 'users'].includes(r.parent))
      .filter((r) => !String(r.cols).includes('tenant_id'))
      .map((r) => `${r.child} -> ${r.parent}`);
    expect(unsafe).toEqual([]);
  });

  it('the runtime role is neither superuser nor BYPASSRLS and owns no tables', async () => {
    const appUser = decodeURIComponent(new URL(testUrls.app).username);
    const role = (await admin.query(`SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = $1`, [appUser])).rows[0];
    expect(role).toEqual({ rolsuper: false, rolbypassrls: false });
    const owned = await admin.query(
      `SELECT count(*)::int AS n FROM pg_tables WHERE schemaname = 'public' AND tableowner = $1`,
      [appUser],
    );
    expect(owned.rows[0].n).toBe(0);
  });

  it('the runtime role cannot grant platform-admin rights or rewrite ledgers', async () => {
    const app = new pg.Client({ connectionString: testUrls.app });
    await app.connect();
    try {
      await expect(app.query(`UPDATE users SET is_platform_admin = true`)).rejects.toMatchObject({ code: '42501' });
      await expect(app.query(`DELETE FROM journal_lines`)).rejects.toMatchObject({ code: '42501' });
      await expect(app.query(`UPDATE stock_movements SET qty_change = 1`)).rejects.toMatchObject({ code: '42501' });
      await expect(app.query(`DELETE FROM activity_logs`)).rejects.toMatchObject({ code: '42501' });
    } finally {
      await app.end();
    }
  });
});
