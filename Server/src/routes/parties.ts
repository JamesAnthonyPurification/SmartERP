import type { FastifyInstance } from 'fastify';
import { tenantRoutes } from '../auth/context';
import type { Db } from '../db/pool';
import { conflict, notFound } from '../lib/errors';
import { round2 } from '../lib/money';
import { likePattern, parse, z, zBool, zDate, zId, zMoney, zOpt, zOptId, zPaging, zPositiveMoney } from '../lib/validate';
import { logActivity, nextNumber, resolveRange } from '../services/common';
import { createCustomerPayment, createSupplierPayment } from '../services/payments';

const partySchema = z.object({
  code: zOpt(30),
  name: z.string().trim().min(1).max(160),
  phone: zOpt(40),
  email: z.union([z.string().trim().email().max(160), z.literal(''), z.null()]).optional().transform((v) => v || null),
  address: zOpt(400),
  isActive: zBool.default(true),
});

const paymentSchema = z.object({
  accountId: zId,
  amount: zPositiveMoney,
  paymentDate: zDate.optional().nullable(),
  note: zOpt(300),
  allocations: z.array(z.object({ docId: zId, amount: zPositiveMoney })).max(200).optional().nullable(),
});

interface StatementEvent {
  at: string;
  type: string;
  ref: string;
  description: string;
  debit: number;
  credit: number;
}

/** Opening balance + events within the range with a running balance. */
function buildStatement(events: StatementEvent[], from: string, to: string, sign: 1 | -1) {
  let opening = 0;
  let balance = 0;
  const rows: (StatementEvent & { balance: number })[] = [];
  for (const e of events) {
    const delta = sign * (e.debit - e.credit);
    const day = e.at.slice(0, 10);
    if (day < from) {
      opening = round2(opening + delta);
      balance = opening;
    } else if (day <= to) {
      balance = round2(balance + delta);
      rows.push({ ...e, balance });
    }
  }
  return {
    from,
    to,
    opening,
    closing: balance,
    totalDebit: round2(rows.reduce((a, r) => a + r.debit, 0)),
    totalCredit: round2(rows.reduce((a, r) => a + r.credit, 0)),
    rows,
  };
}

async function customerStatement(db: Db, customerId: string, from?: string, to?: string) {
  const range = await resolveRange(db, from, to);
  const events = await db.many<StatementEvent>(
    `SELECT to_char(at AT TIME ZONE app_tenant_tz(), 'YYYY-MM-DD HH24:MI') AS at, type, ref, description, debit, credit
     FROM (
       SELECT s.sale_date AS at, 'sale' AS type, s.number AS ref, 'Invoice' AS description, s.total AS debit, 0::numeric AS credit
       FROM sales s WHERE s.customer_id = $1 AND s.status = 'completed'
       UNION ALL
       SELECT s.sale_date, 'payment', s.number, 'Payment at sale', 0, s.paid_amount
       FROM sales s WHERE s.customer_id = $1 AND s.status = 'completed' AND s.paid_amount > 0
       UNION ALL
       SELECT cp.created_at, 'collection', cp.number, COALESCE('Due collection — ' || cp.note, 'Due collection'), 0, cp.amount
       FROM customer_payments cp WHERE cp.customer_id = $1
       UNION ALL
       SELECT r.return_date, 'return', r.number, 'Goods returned (' || s.number || ')', 0, r.amount
       FROM sale_returns r JOIN sales s ON s.id = r.sale_id WHERE s.customer_id = $1
       UNION ALL
       SELECT r.return_date, 'refund', r.number, 'Cash refund', r.refund_amount, 0
       FROM sale_returns r JOIN sales s ON s.id = r.sale_id WHERE s.customer_id = $1 AND r.refund_amount > 0
     ) e ORDER BY e.at, e.type <> 'sale', e.type`,
    [customerId],
  );
  return buildStatement(events, range.from, range.to, 1);
}

async function supplierStatement(db: Db, supplierId: string, from?: string, to?: string) {
  const range = await resolveRange(db, from, to);
  const events = await db.many<StatementEvent>(
    `SELECT to_char(at AT TIME ZONE app_tenant_tz(), 'YYYY-MM-DD HH24:MI') AS at, type, ref, description, debit, credit
     FROM (
       SELECT p.created_at AS at, 'purchase' AS type, p.number AS ref,
              'Stock in' || COALESCE(' — ref ' || p.reference, '') AS description, 0::numeric AS debit, p.total AS credit
       FROM purchases p WHERE p.supplier_id = $1
       UNION ALL
       SELECT p.created_at, 'payment', p.number, 'Paid at purchase', p.paid_amount, 0
       FROM purchases p WHERE p.supplier_id = $1 AND p.paid_amount > 0
       UNION ALL
       SELECT sp.created_at, 'payment', sp.number, COALESCE('Payment — ' || sp.note, 'Payment'), sp.amount, 0
       FROM supplier_payments sp WHERE sp.supplier_id = $1
     ) e ORDER BY e.at, e.type <> 'purchase'`,
    [supplierId],
  );
  return buildStatement(events, range.from, range.to, -1);
}

export default async function partyRoutes(app: FastifyInstance) {
  const r = tenantRoutes(app);

  // ---- Customers ------------------------------------------------------
  r.get('/api/customers', ['customers.view', 'pos.sell', 'collections.manage'], async ({ db, query }) => {
    const q = parse(zPaging.extend({ dueOnly: zBool.default(false), status: z.enum(['active', 'all']).default('active') }), query);
    const rows = await db.many(
      `SELECT c.*, COALESCE(d.due, 0) AS due, COALESCE(d.total_sales, 0) AS total_sales, d.last_sale,
              count(*) OVER () AS total_count
       FROM customers c
       LEFT JOIN (
         SELECT customer_id, sum(due_amount) AS due, sum(total - returned_amount) AS total_sales, max(sale_date) AS last_sale
         FROM sales WHERE status = 'completed' AND customer_id IS NOT NULL GROUP BY customer_id
       ) d ON d.customer_id = c.id
       WHERE ($1::text IS NULL OR c.name ILIKE $1 OR c.phone ILIKE $1 OR c.code ILIKE $1)
         AND (NOT $2 OR COALESCE(d.due, 0) > 0) AND ($3 = 'all' OR c.is_active)
       ORDER BY c.name LIMIT $4 OFFSET $5`,
      [likePattern(q.q), q.dueOnly, q.status, q.pageSize, (q.page - 1) * q.pageSize],
    );
    return { rows, total: rows[0]?.total_count ?? 0 };
  });

  r.get('/api/customers/:id', ['customers.view', 'collections.manage'], async ({ db, params }) => {
    const { id } = parse(z.object({ id: zId }), params);
    const c = await db.maybe(`SELECT * FROM customers WHERE id = $1`, [id]);
    if (!c) throw notFound('Customer');
    const stats = await db.one(
      `SELECT COALESCE(sum(due_amount), 0) AS due, COALESCE(sum(total - returned_amount), 0) AS total_sales,
              count(*) AS invoices, max(sale_date) AS last_sale
       FROM sales WHERE customer_id = $1 AND status = 'completed'`,
      [id],
    );
    const openInvoices = await db.many(
      `SELECT id, number, sale_date, total, due_amount FROM sales
       WHERE customer_id = $1 AND status = 'completed' AND due_amount > 0 ORDER BY sale_date`,
      [id],
    );
    return { ...c, ...stats, openInvoices };
  });

  r.post('/api/customers', ['customers.manage', 'pos.sell'], async ({ db, ctx, body, reply }) => {
    const b = parse(partySchema.extend({ creditLimit: zMoney.optional().nullable() }), body);
    const code = b.code ?? (await nextNumber(db, 'CUST', 'C', 5));
    const row = await db.one(
      `INSERT INTO customers (code, name, phone, email, address, credit_limit, is_active)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
      [code, b.name, b.phone, b.email, b.address, b.creditLimit ?? null, b.isActive],
    );
    await logActivity(db, ctx, 'customer.create', `Customer ${b.name} created`, { entity: 'customer', entityId: row.id });
    reply.code(201);
    return row;
  });

  r.patch('/api/customers/:id', 'customers.manage', async ({ db, ctx, body, params }) => {
    const { id } = parse(z.object({ id: zId }), params);
    const b = parse(partySchema.extend({ code: z.string().trim().min(1).max(30), creditLimit: zMoney.optional().nullable() }), body);
    const row = await db.maybe(
      `UPDATE customers SET code = $2, name = $3, phone = $4, email = $5, address = $6, credit_limit = $7, is_active = $8
       WHERE id = $1 RETURNING *`,
      [id, b.code, b.name, b.phone, b.email, b.address, b.creditLimit ?? null, b.isActive],
    );
    if (!row) throw notFound('Customer');
    await logActivity(db, ctx, 'customer.update', `Customer ${b.name} updated`, { entity: 'customer', entityId: id });
    return row;
  });

  r.del('/api/customers/:id', 'customers.manage', async ({ db, ctx, params }) => {
    const { id } = parse(z.object({ id: zId }), params);
    const used = await db.maybe(
      `SELECT 1 FROM sales WHERE customer_id = $1 UNION ALL SELECT 1 FROM customer_payments WHERE customer_id = $1 LIMIT 1`,
      [id],
    );
    if (used) throw conflict('This customer has transactions. Deactivate instead of deleting.');
    const n = await db.exec(`DELETE FROM customers WHERE id = $1`, [id]);
    if (!n) throw notFound('Customer');
    await logActivity(db, ctx, 'customer.delete', 'Customer deleted', { entity: 'customer', entityId: id });
    return { ok: true };
  });

  r.get('/api/customers/:id/statement', ['reports.view', 'customers.view'], async ({ db, params, query }) => {
    const { id } = parse(z.object({ id: zId }), params);
    const q = parse(z.object({ from: zDate.optional(), to: zDate.optional() }), query);
    const c = await db.maybe(`SELECT id, code, name, phone, address FROM customers WHERE id = $1`, [id]);
    if (!c) throw notFound('Customer');
    return { party: c, ...(await customerStatement(db, id, q.from, q.to)) };
  });

  // ---- Due collection -------------------------------------------------
  r.get('/api/collections', ['collections.manage', 'finance.view'], async ({ db, query }) => {
    const q = parse(zPaging.extend({ customerId: zOptId }), query);
    const rows = await db.many(
      `SELECT cp.id, cp.number, cp.payment_date, cp.amount, cp.note, cp.created_at, c.name AS customer_name,
              a.name AS account_name, u.name AS user_name,
              (SELECT string_agg(s.number || ': ' || al.amount, ', ') FROM customer_payment_allocations al
               JOIN sales s ON s.id = al.sale_id WHERE al.payment_id = cp.id) AS applied_to,
              count(*) OVER () AS total_count
       FROM customer_payments cp
       JOIN customers c ON c.id = cp.customer_id
       JOIN accounts a ON a.id = cp.account_id
       LEFT JOIN users u ON u.id = cp.user_id
       WHERE ($1::text IS NULL OR cp.number ILIKE $1 OR c.name ILIKE $1) AND ($2::uuid IS NULL OR cp.customer_id = $2)
       ORDER BY cp.created_at DESC LIMIT $3 OFFSET $4`,
      [likePattern(q.q), q.customerId, q.pageSize, (q.page - 1) * q.pageSize],
    );
    return { rows, total: rows[0]?.total_count ?? 0 };
  });

  r.post('/api/collections', 'collections.manage', async ({ db, ctx, body, reply }) => {
    const b = parse(paymentSchema.extend({ customerId: zId }), body);
    const result = await createCustomerPayment(db, ctx, { ...b, partyId: b.customerId });
    reply.code(201);
    return result;
  });

  // ---- Suppliers ------------------------------------------------------
  r.get('/api/suppliers', ['suppliers.view', 'inventory.receive', 'suppliers.pay'], async ({ db, query }) => {
    const q = parse(zPaging.extend({ dueOnly: zBool.default(false) }), query);
    const rows = await db.many(
      `SELECT s.*, COALESCE(d.due, 0) AS payable, COALESCE(d.total, 0) AS total_purchases, d.last_purchase,
              count(*) OVER () AS total_count
       FROM suppliers s
       LEFT JOIN (
         SELECT supplier_id, sum(due_amount) AS due, sum(total) AS total, max(purchase_date) AS last_purchase
         FROM purchases WHERE supplier_id IS NOT NULL GROUP BY supplier_id
       ) d ON d.supplier_id = s.id
       WHERE ($1::text IS NULL OR s.name ILIKE $1 OR s.phone ILIKE $1 OR s.code ILIKE $1)
         AND (NOT $2 OR COALESCE(d.due, 0) > 0)
       ORDER BY s.name LIMIT $3 OFFSET $4`,
      [likePattern(q.q), q.dueOnly, q.pageSize, (q.page - 1) * q.pageSize],
    );
    return { rows, total: rows[0]?.total_count ?? 0 };
  });

  r.post('/api/suppliers', 'suppliers.manage', async ({ db, ctx, body, reply }) => {
    const b = parse(partySchema, body);
    const code = b.code ?? (await nextNumber(db, 'SUPP', 'S', 5));
    const row = await db.one(
      `INSERT INTO suppliers (code, name, phone, email, address, is_active) VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [code, b.name, b.phone, b.email, b.address, b.isActive],
    );
    await logActivity(db, ctx, 'supplier.create', `Supplier ${b.name} created`, { entity: 'supplier', entityId: row.id });
    reply.code(201);
    return row;
  });

  r.patch('/api/suppliers/:id', 'suppliers.manage', async ({ db, ctx, body, params }) => {
    const { id } = parse(z.object({ id: zId }), params);
    const b = parse(partySchema.extend({ code: z.string().trim().min(1).max(30) }), body);
    const row = await db.maybe(
      `UPDATE suppliers SET code = $2, name = $3, phone = $4, email = $5, address = $6, is_active = $7 WHERE id = $1 RETURNING *`,
      [id, b.code, b.name, b.phone, b.email, b.address, b.isActive],
    );
    if (!row) throw notFound('Supplier');
    await logActivity(db, ctx, 'supplier.update', `Supplier ${b.name} updated`, { entity: 'supplier', entityId: id });
    return row;
  });

  r.post('/api/suppliers/:id/payments', 'suppliers.pay', async ({ db, ctx, body, params, reply }) => {
    const { id } = parse(z.object({ id: zId }), params);
    const b = parse(paymentSchema, body);
    const result = await createSupplierPayment(db, ctx, { ...b, partyId: id });
    reply.code(201);
    return result;
  });

  r.get('/api/suppliers/:id/statement', ['reports.view', 'suppliers.view'], async ({ db, params, query }) => {
    const { id } = parse(z.object({ id: zId }), params);
    const q = parse(z.object({ from: zDate.optional(), to: zDate.optional() }), query);
    const s = await db.maybe(`SELECT id, code, name, phone, address FROM suppliers WHERE id = $1`, [id]);
    if (!s) throw notFound('Supplier');
    return { party: s, ...(await supplierStatement(db, id, q.from, q.to)) };
  });
}
