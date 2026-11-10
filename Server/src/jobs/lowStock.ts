import { withPlatform, withTenant } from '../db/pool';

/**
 * Background job: raises a low-stock notification per product per day.
 * The tenant list is read in platform context; each tenant's work then runs
 * in its own RLS-scoped transaction, so a job can never mix tenants' data.
 */
export async function runLowStockJob(): Promise<{ tenants: number; created: number }> {
  const tenants = await withPlatform(null, (db) =>
    db.many<{ id: string }>(`SELECT id FROM tenants WHERE status = 'active' ORDER BY created_at`),
  );
  let created = 0;
  for (const t of tenants) {
    created += await withTenant({ tenantId: t.id }, (db) =>
      db.exec(
        `INSERT INTO notifications (kind, title, body, dedupe_key)
         SELECT 'low_stock', 'Low stock: ' || p.name,
                'Only ' || COALESCE(s.qty, 0) || ' ' || p.unit || ' left (reorder level ' || p.reorder_level || ')',
                'low_stock:' || p.id || ':' || app_tenant_today()
         FROM products p
         LEFT JOIN (SELECT product_id, sum(qty) AS qty FROM stock_levels GROUP BY product_id) s ON s.product_id = p.id
         WHERE p.is_active AND p.reorder_level > 0 AND COALESCE(s.qty, 0) <= p.reorder_level
         ON CONFLICT (tenant_id, dedupe_key) DO NOTHING`,
      ),
    );
  }
  return { tenants: tenants.length, created };
}
