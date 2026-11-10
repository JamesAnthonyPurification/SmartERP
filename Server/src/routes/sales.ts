import type { FastifyInstance } from 'fastify';
import { tenantRoutes } from '../auth/context';
import { likePattern, parse, z, zBool, zDate, zId, zMoney, zOpt, zOptId, zPaging, zPositiveMoney, zQty } from '../lib/validate';
import { createReplacement, createReturn, createSale, getSale, voidSale } from '../services/sales';

const zSaleFilters = zPaging.extend({
  from: zDate.optional(),
  to: zDate.optional(),
  status: z.enum(['completed', 'void', 'all']).default('all'),
  customerId: zOptId,
  warehouseId: zOptId,
  dueOnly: zBool.default(false),
});

export default async function salesRoutes(app: FastifyInstance) {
  const r = tenantRoutes(app);

  r.post('/api/sales', 'pos.sell', async ({ db, ctx, body, reply }) => {
    const b = parse(
      z.object({
        warehouseId: zId,
        customerId: zOptId,
        items: z
          .array(
            z.object({
              productId: zId,
              qty: zQty,
              unitPrice: zMoney.optional().nullable(),
              discount: zMoney.default(0),
            }),
          )
          .min(1)
          .max(300),
        discount: zMoney.default(0),
        payments: z.array(z.object({ accountId: zId, amount: zPositiveMoney })).max(5).default([]),
        note: zOpt(500),
      }),
      body,
    );
    const id = await createSale(db, ctx, b);
    reply.code(201);
    return getSale(db, ctx, id);
  });

  r.get('/api/sales', ['sales.view', 'pos.sell'], async ({ db, ctx, query }) => {
    const q = parse(zSaleFilters, query);
    const rows = await db.many(
      `SELECT s.id, s.number, s.sale_date, s.subtotal, s.discount, s.vat_amount, s.total, s.paid_amount, s.due_amount,
              s.returned_amount, s.status, s.customer_id, c.name AS customer_name, c.phone AS customer_phone,
              w.name AS warehouse_name, u.name AS cashier_name,
              count(*) OVER () AS total_count,
              COALESCE(sum(s.total) FILTER (WHERE s.status = 'completed') OVER (), 0) AS sum_total,
              COALESCE(sum(s.due_amount) FILTER (WHERE s.status = 'completed') OVER (), 0) AS sum_due
       FROM sales s
       LEFT JOIN customers c ON c.id = s.customer_id
       JOIN warehouses w ON w.id = s.warehouse_id
       LEFT JOIN users u ON u.id = s.user_id
       WHERE ($1::text IS NULL OR s.number ILIKE $1 OR c.name ILIKE $1 OR c.phone ILIKE $1)
         AND ($2::date IS NULL OR s.sale_date >= ($2::date::timestamp AT TIME ZONE app_tenant_tz()))
         AND ($3::date IS NULL OR s.sale_date < (($3::date + 1)::timestamp AT TIME ZONE app_tenant_tz()))
         AND ($4 = 'all' OR s.status = $4)
         AND ($5::uuid IS NULL OR s.customer_id = $5)
         AND ($6::uuid IS NULL OR s.warehouse_id = $6)
         AND (NOT $7 OR s.due_amount > 0)
         AND ($8::uuid[] IS NULL OR s.warehouse_id = ANY($8))
       ORDER BY s.sale_date DESC LIMIT $9 OFFSET $10`,
      [
        likePattern(q.q), q.from ?? null, q.to ?? null, q.status, q.customerId, q.warehouseId, q.dueOnly,
        ctx.warehouseIds, q.pageSize, (q.page - 1) * q.pageSize,
      ],
    );
    return {
      rows,
      total: rows[0]?.total_count ?? 0,
      sumTotal: rows[0]?.sum_total ?? 0,
      sumDue: rows[0]?.sum_due ?? 0,
    };
  });

  r.get('/api/sales/:id', ['sales.view', 'pos.sell', 'returns.manage'], async ({ db, ctx, params }) => {
    const { id } = parse(z.object({ id: zId }), params);
    return getSale(db, ctx, id);
  });

  r.post('/api/sales/:id/void', 'sales.void', async ({ db, ctx, params, body }) => {
    const { id } = parse(z.object({ id: zId }), params);
    const { reason } = parse(z.object({ reason: z.string().trim().min(3).max(300) }), body);
    await voidSale(db, ctx, id, reason);
    return getSale(db, ctx, id);
  });

  // ---- Returns --------------------------------------------------------
  r.get('/api/returns', ['returns.manage', 'sales.view'], async ({ db, query }) => {
    const q = parse(zPaging, query);
    const rows = await db.many(
      `SELECT r.id, r.number, r.return_date, r.amount, r.refund_amount, r.due_reduction, r.restock, r.reason,
              s.number AS sale_number, c.name AS customer_name, u.name AS user_name,
              (SELECT json_agg(json_build_object('product', p.name, 'qty', i.qty, 'amount', i.amount))
               FROM sale_return_items i JOIN products p ON p.id = i.product_id WHERE i.return_id = r.id) AS items,
              count(*) OVER () AS total_count
       FROM sale_returns r
       JOIN sales s ON s.id = r.sale_id
       LEFT JOIN customers c ON c.id = s.customer_id
       LEFT JOIN users u ON u.id = r.user_id
       WHERE ($1::text IS NULL OR r.number ILIKE $1 OR s.number ILIKE $1 OR c.name ILIKE $1)
       ORDER BY r.return_date DESC LIMIT $2 OFFSET $3`,
      [likePattern(q.q), q.pageSize, (q.page - 1) * q.pageSize],
    );
    return { rows, total: rows[0]?.total_count ?? 0 };
  });

  r.post('/api/returns', 'returns.manage', async ({ db, ctx, body, reply }) => {
    const b = parse(
      z.object({
        saleId: zId,
        items: z.array(z.object({ saleItemId: zId, qty: zQty })).min(1).max(300),
        restock: zBool.default(true),
        accountId: zOptId,
        reason: zOpt(300),
      }),
      body,
    );
    const result = await createReturn(db, ctx, b);
    reply.code(201);
    return result;
  });

  // ---- Replacements ---------------------------------------------------
  r.get('/api/replacements', ['returns.manage', 'sales.view'], async ({ db, query }) => {
    const q = parse(zPaging, query);
    const rows = await db.many(
      `SELECT r.id, r.number, r.created_at, r.returned_qty, r.issued_qty, r.issued_cost, r.charge_amount,
              r.restock_returned, r.reason, s.number AS sale_number, c.name AS customer_name,
              rp.name AS returned_product, ip.name AS issued_product, u.name AS user_name,
              count(*) OVER () AS total_count
       FROM replacements r
       LEFT JOIN sales s ON s.id = r.sale_id
       LEFT JOIN customers c ON c.id = r.customer_id
       JOIN products rp ON rp.id = r.returned_product_id
       JOIN products ip ON ip.id = r.issued_product_id
       LEFT JOIN users u ON u.id = r.user_id
       WHERE ($1::text IS NULL OR r.number ILIKE $1 OR s.number ILIKE $1 OR c.name ILIKE $1 OR rp.name ILIKE $1)
       ORDER BY r.created_at DESC LIMIT $2 OFFSET $3`,
      [likePattern(q.q), q.pageSize, (q.page - 1) * q.pageSize],
    );
    return { rows, total: rows[0]?.total_count ?? 0 };
  });

  r.post('/api/replacements', 'returns.manage', async ({ db, ctx, body, reply }) => {
    const b = parse(
      z.object({
        saleId: zOptId,
        customerId: zOptId,
        warehouseId: zId,
        returnedProductId: zId,
        returnedQty: zQty,
        restockReturned: zBool.default(false),
        issuedProductId: zId,
        issuedQty: zQty,
        chargeAmount: zMoney.default(0),
        accountId: zOptId,
        reason: zOpt(300),
      }),
      body,
    );
    const result = await createReplacement(db, ctx, b);
    reply.code(201);
    return result;
  });
}
