import type { Ctx } from '../auth/context';
import type { Db } from '../db/pool';

/** Next per-tenant document number, e.g. INV-000042. Row lock keeps it gap-free. */
export async function nextNumber(db: Db, key: string, prefix = key, pad = 6): Promise<string> {
  const row = await db.one<{ value: number }>(
    `INSERT INTO counters (key, value) VALUES ($1, 1)
     ON CONFLICT (tenant_id, key) DO UPDATE SET value = counters.value + 1
     RETURNING value`,
    [key],
  );
  return `${prefix}-${String(row.value).padStart(pad, '0')}`;
}

export interface Settings {
  company_name: string;
  tagline: string;
  currency_symbol: string;
  timezone: string;
  default_vat_rate: number;
  invoice_prefix: string;
  allow_negative_stock: boolean;
}

export async function getSettings(db: Db): Promise<Settings> {
  return db.one(`SELECT * FROM tenant_settings`);
}

export async function tenantToday(db: Db): Promise<string> {
  return (await db.one<{ d: string }>(`SELECT app_tenant_today()::text AS d`)).d;
}

export async function logActivity(
  db: Db,
  ctx: Ctx,
  action: string,
  summary: string,
  opts: { entity?: string; entityId?: string | null; details?: Record<string, unknown> } = {},
) {
  await db.exec(
    `INSERT INTO activity_logs (user_id, action, entity, entity_id, summary, details, ip)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [ctx.userId || null, action, opts.entity ?? null, opts.entityId ?? null, summary, opts.details ?? {}, ctx.ip ?? null],
  );
}

/**
 * SQL predicate for "timestamp column falls on local dates [from, to]" in the
 * tenant's timezone. Index-friendly: compares the raw column to bounds.
 */
export function localDateRange(column: string, fromParam: number, toParam: number) {
  return `${column} >= ($${fromParam}::date::timestamp AT TIME ZONE app_tenant_tz())
      AND ${column} < (($${toParam}::date + 1)::timestamp AT TIME ZONE app_tenant_tz())`;
}

/** Resolves a from/to range, defaulting to the current month in tenant time. */
export async function resolveRange(db: Db, from?: string, to?: string) {
  const r = await db.one<{ from: string; to: string }>(
    `SELECT COALESCE($1::date, date_trunc('month', app_tenant_today())::date)::text AS from,
            COALESCE($2::date, app_tenant_today())::text AS to`,
    [from ?? null, to ?? null],
  );
  return r;
}
