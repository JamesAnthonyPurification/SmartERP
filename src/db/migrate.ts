import fs from 'node:fs';
import path from 'node:path';
import pg from 'pg';
import { config } from '../config';

const MIGRATIONS_DIR = path.resolve(__dirname, '../../migrations');

/**
 * Applies pending SQL migrations as the owner role, then (re)creates the
 * restricted runtime role and its grants. Idempotent: safe on every deploy.
 */
export async function migrate(opts: { adminUrl?: string; appUrl?: string; log?: (msg: string) => void } = {}) {
  const log = opts.log ?? console.log;
  const appUrl = new URL(opts.appUrl ?? config.databaseUrl);
  const appRole = decodeURIComponent(appUrl.username);
  const appPassword = decodeURIComponent(appUrl.password);
  if (!/^[a-z_][a-z0-9_]*$/.test(appRole)) throw new Error(`Invalid app role name: ${appRole}`);

  const client = new pg.Client({ connectionString: opts.adminUrl ?? config.databaseAdminUrl });
  await client.connect();
  try {
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`);
    const applied = new Set((await client.query('SELECT name FROM schema_migrations')).rows.map((r) => r.name));
    const files = fs.readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort();

    for (const file of files) {
      if (applied.has(file)) continue;
      const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');
      log(`Applying ${file}`);
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      }
    }

    // Runtime role: never superuser, never BYPASSRLS, never owner of tables.
    const exists = (await client.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [appRole])).rowCount;
    const verb = exists ? 'ALTER' : 'CREATE';
    const { rows } = await client.query(
      `SELECT format('${verb} ROLE %I LOGIN PASSWORD %L NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE', $1::text, $2::text) AS sql`,
      [appRole, appPassword],
    );
    await client.query(rows[0].sql);

    const dbName = (await client.query('SELECT current_database() AS d')).rows[0].d;
    const grants = `
      GRANT CONNECT ON DATABASE "${dbName}" TO ${appRole};
      REVOKE CREATE ON SCHEMA public FROM PUBLIC;
      GRANT USAGE ON SCHEMA public TO ${appRole};
      GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${appRole};
      GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ${appRole};
      REVOKE ALL ON schema_migrations FROM ${appRole};
      -- Identities: the app may never grant platform-admin rights.
      REVOKE INSERT, UPDATE, DELETE ON users FROM ${appRole};
      GRANT INSERT (id, email, name, password_hash, is_active) ON users TO ${appRole};
      GRANT UPDATE (email, name, password_hash, is_active, last_login_at) ON users TO ${appRole};
      REVOKE DELETE ON tenants FROM ${appRole};
      -- Append-only ledgers and audit trails.
      REVOKE UPDATE, DELETE ON auth_events, platform_audit_log, activity_logs,
        stock_movements, journal_entries, journal_lines FROM ${appRole};
    `;
    await client.query(grants);
    log('Migrations complete');
  } finally {
    await client.end();
  }
}

if (require.main === module) {
  migrate().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
