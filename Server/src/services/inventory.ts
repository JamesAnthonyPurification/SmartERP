import { assertWarehouseAccess, Ctx } from '../auth/context';
import type { Db } from '../db/pool';
import { badRequest } from '../lib/errors';
import { round2, round4 } from '../lib/money';
import { getSettings, logActivity, nextNumber } from './common';
import { postJournal, systemAccounts } from './ledger';

export interface LockedProduct {
  id: string;
  name: string;
  sku: string;
  unit: string;
  sale_price: number;
  purchase_price: number;
  avg_cost: number;
  vat_rate: number;
  is_active: boolean;
}

/**
 * Locks the products touched by a stock operation in a deterministic order
 * (prevents deadlocks and serialises concurrent sales of the same item).
 * RLS hides other tenants' products, so a foreign id is simply "not found".
 */
export async function lockProducts(db: Db, ids: string[], opts: { requireActive?: boolean } = {}) {
  const unique = [...new Set(ids)].sort();
  const rows = await db.many<LockedProduct>(
    `SELECT id, name, sku, unit, sale_price, purchase_price, avg_cost, vat_rate, is_active
     FROM products WHERE id = ANY($1::uuid[]) ORDER BY id FOR UPDATE`,
    [unique],
  );
  if (rows.length !== unique.length) throw badRequest('One or more products were not found');
  if (opts.requireActive) {
    const inactive = rows.find((r) => !r.is_active);
    if (inactive) throw badRequest(`${inactive.name} is inactive`);
  }
  return new Map(rows.map((r) => [r.id, r]));
}

export async function assertWarehouse(db: Db, ctx: Ctx, warehouseId: string) {
  assertWarehouseAccess(ctx, warehouseId);
  const w = await db.maybe<{ id: string; name: string }>(
    `SELECT id, name FROM warehouses WHERE id = $1 AND is_active`,
    [warehouseId],
  );
  if (!w) throw badRequest('Warehouse not found');
  return w;
}

export interface StockMove {
  productId: string;
  warehouseId: string;
  /** Signed quantity: positive receives stock, negative issues it. */
  qty: number;
  unitCost: number;
  kind: string;
  refType?: string;
  refId?: string;
  refNumber?: string;
  note?: string | null;
}

/** Atomically changes a stock balance and appends to the movement ledger. */
export async function applyStock(
  db: Db,
  ctx: Ctx,
  m: StockMove,
  opts: { allowNegative: boolean; productName?: string },
): Promise<number> {
  const row = await db.one<{ qty: number }>(
    `INSERT INTO stock_levels (warehouse_id, product_id, qty) VALUES ($1, $2, $3)
     ON CONFLICT (tenant_id, warehouse_id, product_id)
     DO UPDATE SET qty = stock_levels.qty + EXCLUDED.qty, updated_at = now()
     RETURNING qty`,
    [m.warehouseId, m.productId, m.qty],
  );
  if (m.qty < 0 && row.qty < 0 && !opts.allowNegative) {
    const available = Math.round((row.qty - m.qty) * 1000) / 1000;
    throw badRequest(`Insufficient stock for ${opts.productName ?? 'product'}: available ${available}, requested ${-m.qty}`);
  }
  await db.exec(
    `INSERT INTO stock_movements
       (product_id, warehouse_id, qty_change, unit_cost, balance_after, kind, ref_type, ref_id, ref_number, note, user_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
    [
      m.productId, m.warehouseId, m.qty, round4(m.unitCost), row.qty, m.kind,
      m.refType ?? null, m.refId ?? null, m.refNumber ?? null, m.note ?? null, ctx.userId || null,
    ],
  );
  return row.qty;
}

/** Weighted moving-average cost update for incoming stock. Call before applyStock. */
export async function averageIn(db: Db, product: LockedProduct, qtyIn: number, unitCost: number) {
  const { total } = await db.one<{ total: number }>(
    `SELECT COALESCE(sum(qty), 0) AS total FROM stock_levels WHERE product_id = $1`,
    [product.id],
  );
  const prevQty = Math.max(total, 0);
  const newQty = prevQty + qtyIn;
  const avg = newQty > 0 ? round4((prevQty * product.avg_cost + qtyIn * unitCost) / newQty) : round4(unitCost);
  await db.exec(`UPDATE products SET avg_cost = $2, updated_at = now() WHERE id = $1`, [product.id, avg]);
  product.avg_cost = avg;
}

export type AdjustReason = 'count' | 'damage' | 'expired' | 'lost' | 'opening' | 'other';

export async function createAdjustment(
  db: Db,
  ctx: Ctx,
  input: {
    warehouseId: string;
    reason: AdjustReason;
    note: string | null;
    items: { productId: string; qtyChange: number; unitCost?: number | null }[];
  },
) {
  await assertWarehouse(db, ctx, input.warehouseId);
  if (input.items.some((i) => i.qtyChange === 0)) throw badRequest('Quantity change cannot be zero');
  const settings = await getSettings(db);
  const products = await lockProducts(db, input.items.map((i) => i.productId));
  const number = await nextNumber(db, 'ADJ');
  const adj = await db.one<{ id: string; number: string }>(
    `INSERT INTO stock_adjustments (number, warehouse_id, reason, note, user_id)
     VALUES ($1, $2, $3, $4, $5) RETURNING id, number`,
    [number, input.warehouseId, input.reason, input.note, ctx.userId],
  );

  let increase = 0;
  let decrease = 0;
  for (const item of input.items) {
    const p = products.get(item.productId)!;
    let unitCost: number;
    if (item.qtyChange > 0) {
      unitCost = item.unitCost ?? (p.avg_cost || p.purchase_price);
      await averageIn(db, p, item.qtyChange, unitCost);
      increase += item.qtyChange * unitCost;
    } else {
      unitCost = p.avg_cost;
      decrease += -item.qtyChange * unitCost;
    }
    await applyStock(
      db,
      ctx,
      {
        productId: p.id,
        warehouseId: input.warehouseId,
        qty: item.qtyChange,
        unitCost,
        kind: input.reason === 'opening' ? 'opening' : 'adjustment',
        refType: 'stock_adjustment',
        refId: adj.id,
        refNumber: adj.number,
        note: input.note,
      },
      { allowNegative: settings.allow_negative_stock, productName: p.name },
    );
    await db.exec(
      `INSERT INTO stock_adjustment_items (adjustment_id, product_id, qty_change, unit_cost) VALUES ($1, $2, $3, $4)`,
      [adj.id, p.id, item.qtyChange, round4(unitCost)],
    );
  }

  const acc = await systemAccounts(db);
  increase = round2(increase);
  decrease = round2(decrease);
  const journalId = await postJournal(db, ctx, {
    memo: `Stock adjustment ${adj.number} (${input.reason})`,
    refType: 'stock_adjustment',
    refId: adj.id,
    lines: [
      { accountId: acc.INVENTORY, debit: increase },
      { accountId: input.reason === 'opening' ? acc.OPENING_EQUITY : acc.INV_ADJ, credit: increase },
      { accountId: acc.INV_ADJ, debit: decrease },
      { accountId: acc.INVENTORY, credit: decrease },
    ],
  });
  if (journalId) await db.exec(`UPDATE stock_adjustments SET journal_entry_id = $2 WHERE id = $1`, [adj.id, journalId]);
  await logActivity(db, ctx, 'stock.adjust', `Stock adjustment ${adj.number} (${input.reason})`, {
    entity: 'stock_adjustment',
    entityId: adj.id,
    details: { items: input.items.length },
  });
  return adj;
}
