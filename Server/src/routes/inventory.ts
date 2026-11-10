import type { FastifyInstance } from 'fastify';
import { tenantRoutes } from '../auth/context';
import type { Db } from '../db/pool';
import { badRequest, notFound } from '../lib/errors';
import { round2, round4 } from '../lib/money';
import { likePattern, parse, z, zDate, zId, zMoney, zOpt, zOptId, zPaging, zQty } from '../lib/validate';
import { getSettings, logActivity, nextNumber } from '../services/common';
import { applyStock, assertWarehouse, averageIn, createAdjustment, lockProducts } from '../services/inventory';
import { assertMoneyAccount, postJournal, systemAccounts } from '../services/ledger';
import { postProduction } from '../services/production';
import { createPurchase } from '../services/purchases';

const zListRange = zPaging.extend({ from: zDate.optional(), to: zDate.optional() });

async function getPurchase(db: Db, id: string) {
  const purchase = await db.maybe(
    `SELECT p.*, s.name AS supplier_name, s.phone AS supplier_phone, w.name AS warehouse_name, u.name AS user_name
     FROM purchases p
     LEFT JOIN suppliers s ON s.id = p.supplier_id
     JOIN warehouses w ON w.id = p.warehouse_id
     LEFT JOIN users u ON u.id = p.user_id
     WHERE p.id = $1`,
    [id],
  );
  if (!purchase) throw notFound('Purchase');
  const items = await db.many(
    `SELECT i.id, i.product_id, i.qty, i.unit_cost, i.line_total, p.name AS product_name, p.sku, p.unit
     FROM purchase_items i JOIN products p ON p.id = i.product_id WHERE i.purchase_id = $1 ORDER BY p.name`,
    [id],
  );
  return { ...purchase, items };
}

export default async function inventoryRoutes(app: FastifyInstance) {
  const r = tenantRoutes(app);

  // ---- Stock In (purchases) ------------------------------------------
  r.get('/api/purchases', ['inventory.receive', 'inventory.view', 'suppliers.view'], async ({ db, query }) => {
    const q = parse(zListRange.extend({ supplierId: zOptId, dueOnly: z.coerce.boolean().default(false) }), query);
    const rows = await db.many(
      `SELECT p.id, p.number, p.purchase_date, p.reference, p.total, p.paid_amount, p.due_amount, p.created_at,
              s.name AS supplier_name, w.name AS warehouse_name, u.name AS user_name,
              (SELECT count(*) FROM purchase_items i WHERE i.purchase_id = p.id) AS item_count,
              count(*) OVER () AS total_count
       FROM purchases p
       LEFT JOIN suppliers s ON s.id = p.supplier_id
       JOIN warehouses w ON w.id = p.warehouse_id
       LEFT JOIN users u ON u.id = p.user_id
       WHERE ($1::text IS NULL OR p.number ILIKE $1 OR p.reference ILIKE $1 OR s.name ILIKE $1)
         AND ($2::date IS NULL OR p.purchase_date >= $2) AND ($3::date IS NULL OR p.purchase_date <= $3)
         AND ($4::uuid IS NULL OR p.supplier_id = $4) AND (NOT $5 OR p.due_amount > 0)
       ORDER BY p.purchase_date DESC, p.created_at DESC LIMIT $6 OFFSET $7`,
      [likePattern(q.q), q.from ?? null, q.to ?? null, q.supplierId, q.dueOnly, q.pageSize, (q.page - 1) * q.pageSize],
    );
    return { rows, total: rows[0]?.total_count ?? 0 };
  });

  r.get('/api/purchases/:id', ['inventory.receive', 'inventory.view', 'suppliers.view'], async ({ db, params }) => {
    const { id } = parse(z.object({ id: zId }), params);
    return getPurchase(db, id);
  });

  r.post('/api/purchases', 'inventory.receive', async ({ db, ctx, body, reply }) => {
    const b = parse(
      z.object({
        supplierId: zOptId,
        warehouseId: zId,
        purchaseDate: zDate.optional(),
        reference: zOpt(80),
        note: zOpt(500),
        items: z.array(z.object({ productId: zId, qty: zQty, unitCost: zMoney })).min(1).max(300),
        paidAmount: zMoney.default(0),
        accountId: zOptId,
      }),
      body,
    );
    const id = await createPurchase(db, ctx, b);
    reply.code(201);
    return getPurchase(db, id);
  });

  // ---- Stock adjustments ----------------------------------------------
  r.get('/api/adjustments', ['inventory.adjust', 'inventory.view'], async ({ db, query }) => {
    const q = parse(zListRange, query);
    const rows = await db.many(
      `SELECT a.id, a.number, a.reason, a.note, a.created_at, w.name AS warehouse_name, u.name AS user_name,
              (SELECT json_agg(json_build_object('product', p.name, 'qty', i.qty_change, 'unit_cost', i.unit_cost))
               FROM stock_adjustment_items i JOIN products p ON p.id = i.product_id WHERE i.adjustment_id = a.id) AS items,
              count(*) OVER () AS total_count
       FROM stock_adjustments a JOIN warehouses w ON w.id = a.warehouse_id LEFT JOIN users u ON u.id = a.user_id
       WHERE ($1::text IS NULL OR a.number ILIKE $1 OR a.note ILIKE $1)
       ORDER BY a.created_at DESC LIMIT $2 OFFSET $3`,
      [likePattern(q.q), q.pageSize, (q.page - 1) * q.pageSize],
    );
    return { rows, total: rows[0]?.total_count ?? 0 };
  });

  r.post('/api/adjustments', 'inventory.adjust', async ({ db, ctx, body, reply }) => {
    const b = parse(
      z.object({
        warehouseId: zId,
        reason: z.enum(['count', 'damage', 'expired', 'lost', 'opening', 'other']),
        note: zOpt(500),
        items: z
          .array(
            z.object({
              productId: zId,
              qtyChange: z.coerce.number().finite().min(-1e9).max(1e9).refine((n) => n !== 0, 'Cannot be zero'),
              unitCost: zMoney.optional().nullable(),
            }),
          )
          .min(1)
          .max(300),
      }),
      body,
    );
    const adj = await createAdjustment(db, ctx, b);
    reply.code(201);
    return adj;
  });

  // ---- Transfers between warehouses -----------------------------------
  r.get('/api/transfers', ['inventory.adjust', 'inventory.view'], async ({ db, query }) => {
    const q = parse(zListRange, query);
    const rows = await db.many(
      `SELECT t.id, t.number, t.note, t.created_at, fw.name AS from_name, tw.name AS to_name, u.name AS user_name,
              (SELECT json_agg(json_build_object('product', p.name, 'qty', i.qty))
               FROM stock_transfer_items i JOIN products p ON p.id = i.product_id WHERE i.transfer_id = t.id) AS items,
              count(*) OVER () AS total_count
       FROM stock_transfers t
       JOIN warehouses fw ON fw.id = t.from_warehouse_id
       JOIN warehouses tw ON tw.id = t.to_warehouse_id
       LEFT JOIN users u ON u.id = t.user_id
       ORDER BY t.created_at DESC LIMIT $1 OFFSET $2`,
      [q.pageSize, (q.page - 1) * q.pageSize],
    );
    return { rows, total: rows[0]?.total_count ?? 0 };
  });

  r.post('/api/transfers', 'inventory.adjust', async ({ db, ctx, body, reply }) => {
    const b = parse(
      z.object({
        fromWarehouseId: zId,
        toWarehouseId: zId,
        note: zOpt(500),
        items: z.array(z.object({ productId: zId, qty: zQty })).min(1).max(300),
      }),
      body,
    );
    if (b.fromWarehouseId === b.toWarehouseId) throw badRequest('Choose two different warehouses');
    await assertWarehouse(db, ctx, b.fromWarehouseId);
    const to = await db.maybe(`SELECT id FROM warehouses WHERE id = $1 AND is_active`, [b.toWarehouseId]);
    if (!to) throw badRequest('Destination warehouse not found');

    const products = await lockProducts(db, b.items.map((i) => i.productId));
    const number = await nextNumber(db, 'TRF');
    const t = await db.one<{ id: string }>(
      `INSERT INTO stock_transfers (number, from_warehouse_id, to_warehouse_id, note, user_id)
       VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [number, b.fromWarehouseId, b.toWarehouseId, b.note, ctx.userId],
    );
    for (const item of b.items) {
      const p = products.get(item.productId)!;
      const ref = { refType: 'stock_transfer', refId: t.id, refNumber: number, note: b.note };
      // Transfers never go negative, whatever the tenant setting.
      await applyStock(db, ctx, { productId: p.id, warehouseId: b.fromWarehouseId, qty: -item.qty, unitCost: p.avg_cost, kind: 'transfer_out', ...ref }, { allowNegative: false, productName: p.name });
      await applyStock(db, ctx, { productId: p.id, warehouseId: b.toWarehouseId, qty: item.qty, unitCost: p.avg_cost, kind: 'transfer_in', ...ref }, { allowNegative: true });
      await db.exec(`INSERT INTO stock_transfer_items (transfer_id, product_id, qty, unit_cost) VALUES ($1, $2, $3, $4)`, [
        t.id, p.id, item.qty, p.avg_cost,
      ]);
    }
    await logActivity(db, ctx, 'stock.transfer', `Stock transfer ${number}`, { entity: 'stock_transfer', entityId: t.id });
    reply.code(201);
    return { id: t.id, number };
  });

  // ---- Production -----------------------------------------------------
  r.get('/api/production', ['production.manage', 'inventory.view'], async ({ db, query }) => {
    const q = parse(zListRange, query);
    const rows = await db.many(
      `SELECT o.id, o.number, o.output_qty, o.materials_cost, o.extra_cost, o.unit_cost, o.note, o.created_at,
              p.name AS output_product, p.unit AS output_unit, w.name AS warehouse_name, u.name AS user_name,
              (SELECT json_agg(json_build_object('product', ip.name, 'qty', i.qty, 'unit_cost', i.unit_cost))
               FROM production_inputs i JOIN products ip ON ip.id = i.product_id WHERE i.production_order_id = o.id) AS inputs,
              count(*) OVER () AS total_count
       FROM production_orders o
       JOIN products p ON p.id = o.output_product_id
       JOIN warehouses w ON w.id = o.warehouse_id
       LEFT JOIN users u ON u.id = o.user_id
       WHERE ($1::text IS NULL OR o.number ILIKE $1 OR p.name ILIKE $1)
       ORDER BY o.created_at DESC LIMIT $2 OFFSET $3`,
      [likePattern(q.q), q.pageSize, (q.page - 1) * q.pageSize],
    );
    return { rows, total: rows[0]?.total_count ?? 0 };
  });

  r.post('/api/production', 'production.manage', async ({ db, ctx, body, reply }) => {
    const b = parse(
      z.object({
        warehouseId: zId,
        outputProductId: zId,
        outputQty: zQty,
        inputs: z.array(z.object({ productId: zId, qty: zQty })).min(1).max(100),
        extraCost: zMoney.default(0),
        accountId: zOptId,
        note: zOpt(500),
      }),
      body,
    );
    const result = await postProduction(db, ctx, b);
    reply.code(201);
    return result;
  });
}
