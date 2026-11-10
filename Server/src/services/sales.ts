import { assertWarehouseAccess, Ctx } from '../auth/context';
import type { Db } from '../db/pool';
import { badRequest, conflict, notFound } from '../lib/errors';
import { round2, sum } from '../lib/money';
import { getSettings, logActivity, nextNumber } from './common';
import { applyStock, assertWarehouse, averageIn, lockProducts } from './inventory';
import { assertMoneyAccount, postJournal, reverseJournal, systemAccounts } from './ledger';

export interface PricedLineInput {
  qty: number;
  unitPrice: number;
  discount: number;
  vatRate: number;
}

/**
 * Prices an invoice. The invoice-level discount is spread across lines in
 * proportion to their net value so VAT is charged on the discounted price;
 * rounding residue goes to the last line so the lines always sum to the total.
 */
export function priceSale(lines: PricedLineInput[], invoiceDiscount: number) {
  const nets = lines.map((l) => round2(l.qty * l.unitPrice - l.discount));
  if (nets.some((n) => n < 0)) throw badRequest('A line discount cannot exceed the line amount');
  const subtotal = sum(nets);
  if (invoiceDiscount > subtotal) throw badRequest('Discount cannot exceed the subtotal');

  let remaining = invoiceDiscount;
  const taxable = nets.map((net, i) => {
    const share = i === nets.length - 1 ? remaining : subtotal > 0 ? round2((invoiceDiscount * net) / subtotal) : 0;
    remaining = round2(remaining - share);
    return Math.max(0, round2(net - share));
  });
  const priced = lines.map((l, i) => {
    const vat = round2((taxable[i] * l.vatRate) / 100);
    return { ...l, net: nets[i], taxable: taxable[i], vat, lineTotal: round2(taxable[i] + vat) };
  });
  const taxableTotal = sum(taxable);
  const vatAmount = sum(priced.map((p) => p.vat));
  return {
    lines: priced,
    subtotal,
    discount: round2(subtotal - taxableTotal),
    vatAmount,
    total: sum(priced.map((p) => p.lineTotal)),
  };
}

export interface SaleInput {
  warehouseId: string;
  customerId: string | null;
  items: { productId: string; qty: number; unitPrice?: number | null; discount?: number }[];
  discount: number;
  payments: { accountId: string; amount: number }[];
  note: string | null;
  /** Back-dating is only used by the demo seed. */
  saleDate?: string;
}

export async function createSale(db: Db, ctx: Ctx, input: SaleInput) {
  await assertWarehouse(db, ctx, input.warehouseId);
  let customer: { id: string; name: string; credit_limit: number | null } | null = null;
  if (input.customerId) {
    customer = await db.maybe(`SELECT id, name, credit_limit FROM customers WHERE id = $1 AND is_active`, [input.customerId]);
    if (!customer) throw badRequest('Customer not found');
  }
  const settings = await getSettings(db);
  const products = await lockProducts(db, input.items.map((i) => i.productId), { requireActive: true });
  const priced = priceSale(
    input.items.map((i) => {
      const p = products.get(i.productId)!;
      return { qty: i.qty, unitPrice: i.unitPrice ?? p.sale_price, discount: i.discount ?? 0, vatRate: p.vat_rate };
    }),
    input.discount,
  );

  const paid = sum(input.payments.map((p) => p.amount));
  if (paid > priced.total) throw badRequest('Payments exceed the invoice total');
  const due = round2(priced.total - paid);
  if (due > 0) {
    if (!customer) throw badRequest('Select a customer to sell on credit (due)');
    if (customer.credit_limit !== null) {
      const { current } = await db.one<{ current: number }>(
        `SELECT COALESCE(sum(due_amount), 0) AS current FROM sales WHERE customer_id = $1 AND status = 'completed'`,
        [customer.id],
      );
      if (round2(current + due) > customer.credit_limit) {
        throw badRequest(`Credit limit exceeded for ${customer.name}: current due ${current}, limit ${customer.credit_limit}`);
      }
    }
  }
  for (const p of input.payments) await assertMoneyAccount(db, p.accountId);

  const number = await nextNumber(db, 'INV', settings.invoice_prefix);
  const sale = await db.one<{ id: string; local_date: string }>(
    `INSERT INTO sales (number, customer_id, warehouse_id, sale_date, subtotal, discount, vat_amount, total,
                        paid_amount, due_amount, note, user_id)
     VALUES ($1, $2, $3, COALESCE($4::timestamptz, now()), $5, $6, $7, $8, $9, $10, $11, $12)
     RETURNING id, (sale_date AT TIME ZONE app_tenant_tz())::date::text AS local_date`,
    [
      number, input.customerId, input.warehouseId, input.saleDate ?? null, priced.subtotal, priced.discount,
      priced.vatAmount, priced.total, paid, due, input.note, ctx.userId,
    ],
  );

  let costTotal = 0;
  for (let i = 0; i < input.items.length; i++) {
    const item = input.items[i];
    const line = priced.lines[i];
    const p = products.get(item.productId)!;
    costTotal += item.qty * p.avg_cost;
    await db.exec(
      `INSERT INTO sale_items (sale_id, product_id, qty, unit_price, discount, vat_rate, vat_amount, line_total, unit_cost)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [sale.id, p.id, item.qty, line.unitPrice, line.discount, line.vatRate, line.vat, line.lineTotal, p.avg_cost],
    );
    await applyStock(
      db,
      ctx,
      {
        productId: p.id, warehouseId: input.warehouseId, qty: -item.qty, unitCost: p.avg_cost, kind: 'sale',
        refType: 'sale', refId: sale.id, refNumber: number,
      },
      { allowNegative: settings.allow_negative_stock, productName: p.name },
    );
  }
  costTotal = round2(costTotal);

  for (const p of input.payments) {
    await db.exec(`INSERT INTO sale_payments (sale_id, account_id, amount) VALUES ($1, $2, $3)`, [sale.id, p.accountId, p.amount]);
  }

  const acc = await systemAccounts(db);
  const journalId = await postJournal(db, ctx, {
    date: sale.local_date,
    memo: `Sale ${number}${customer ? ` to ${customer.name}` : ''}`,
    refType: 'sale',
    refId: sale.id,
    lines: [
      ...input.payments.map((p) => ({ accountId: p.accountId, debit: p.amount })),
      { accountId: acc.AR, debit: due },
      { accountId: acc.SALES, credit: round2(priced.subtotal - priced.discount) },
      { accountId: acc.VAT_PAYABLE, credit: priced.vatAmount },
      { accountId: acc.COGS, debit: costTotal },
      { accountId: acc.INVENTORY, credit: costTotal },
    ],
  });
  await db.exec(`UPDATE sales SET cost_total = $2, journal_entry_id = $3 WHERE id = $1`, [sale.id, costTotal, journalId]);
  await logActivity(db, ctx, 'sale.create', `Sale ${number} for ${priced.total}`, {
    entity: 'sale', entityId: sale.id, details: { total: priced.total, paid, due },
  });
  return sale.id;
}

export async function getSale(db: Db, ctx: Ctx, id: string) {
  const sale = await db.maybe(
    `SELECT s.*, c.name AS customer_name, c.phone AS customer_phone, c.address AS customer_address, c.code AS customer_code,
            w.name AS warehouse_name, u.name AS cashier_name, vu.name AS voided_by_name
     FROM sales s
     LEFT JOIN customers c ON c.id = s.customer_id
     JOIN warehouses w ON w.id = s.warehouse_id
     LEFT JOIN users u ON u.id = s.user_id
     LEFT JOIN users vu ON vu.id = s.voided_by
     WHERE s.id = $1`,
    [id],
  );
  if (!sale) throw notFound('Sale');
  assertWarehouseAccess(ctx, sale.warehouse_id);
  const items = await db.many(
    `SELECT i.id, i.product_id, i.qty, i.unit_price, i.discount, i.vat_rate, i.vat_amount, i.line_total, i.unit_cost,
            i.returned_qty, i.returned_amount, p.name AS product_name, p.sku, p.unit
     FROM sale_items i JOIN products p ON p.id = i.product_id WHERE i.sale_id = $1 ORDER BY p.name`,
    [id],
  );
  const payments = await db.many(
    `SELECT sp.amount, sp.created_at, a.name AS account_name, a.money_kind
     FROM sale_payments sp JOIN accounts a ON a.id = sp.account_id WHERE sp.sale_id = $1`,
    [id],
  );
  const collections = await db.many(
    `SELECT cp.number, cp.payment_date, al.amount, a.name AS account_name
     FROM customer_payment_allocations al
     JOIN customer_payments cp ON cp.id = al.payment_id
     JOIN accounts a ON a.id = cp.account_id
     WHERE al.sale_id = $1 ORDER BY cp.payment_date`,
    [id],
  );
  const returns = await db.many(
    `SELECT id, number, return_date, amount, refund_amount, due_reduction, restock, reason FROM sale_returns
     WHERE sale_id = $1 ORDER BY return_date`,
    [id],
  );
  return { ...sale, items, payments, collections, returns };
}

export async function voidSale(db: Db, ctx: Ctx, id: string, reason: string) {
  const sale = await db.maybe(`SELECT * FROM sales WHERE id = $1 FOR UPDATE`, [id]);
  if (!sale) throw notFound('Sale');
  assertWarehouseAccess(ctx, sale.warehouse_id);
  if (sale.status !== 'completed') throw conflict('This sale is already void');
  if (sale.returned_amount > 0) throw conflict('Sales with returns cannot be voided');
  const blockers = await db.maybe(
    `SELECT 1 FROM customer_payment_allocations WHERE sale_id = $1
     UNION ALL SELECT 1 FROM replacements WHERE sale_id = $1 LIMIT 1`,
    [id],
  );
  if (blockers) throw conflict('This sale has later collections or replacements and cannot be voided');

  const items = await db.many(`SELECT product_id, qty, unit_cost FROM sale_items WHERE sale_id = $1`, [id]);
  const products = await lockProducts(db, items.map((i) => i.product_id));
  for (const item of items) {
    const p = products.get(item.product_id)!;
    await averageIn(db, p, item.qty, item.unit_cost);
    await applyStock(
      db,
      ctx,
      {
        productId: p.id, warehouseId: sale.warehouse_id, qty: item.qty, unitCost: item.unit_cost, kind: 'sale_void',
        refType: 'sale', refId: id, refNumber: sale.number, note: reason,
      },
      { allowNegative: true },
    );
  }
  if (sale.journal_entry_id) {
    await reverseJournal(db, ctx, sale.journal_entry_id, `Void ${sale.number}: ${reason}`, 'sale_void', id);
  }
  await db.exec(
    `UPDATE sales SET status = 'void', due_amount = 0, voided_at = now(), voided_by = $2, void_reason = $3 WHERE id = $1`,
    [id, ctx.userId, reason],
  );
  await logActivity(db, ctx, 'sale.void', `Sale ${sale.number} voided: ${reason}`, { entity: 'sale', entityId: id });
}

export interface ReturnInput {
  saleId: string;
  items: { saleItemId: string; qty: number }[];
  restock: boolean;
  accountId: string | null;
  reason: string | null;
}

export async function createReturn(db: Db, ctx: Ctx, input: ReturnInput) {
  const sale = await db.maybe(`SELECT * FROM sales WHERE id = $1 FOR UPDATE`, [input.saleId]);
  if (!sale) throw notFound('Sale');
  assertWarehouseAccess(ctx, sale.warehouse_id);
  if (sale.status !== 'completed') throw conflict('Cannot return items from a void sale');

  const saleItems = await db.many(`SELECT * FROM sale_items WHERE sale_id = $1 FOR UPDATE`, [input.saleId]);
  const byId = new Map(saleItems.map((i) => [i.id, i]));
  const requested = new Map<string, number>();
  for (const r of input.items) requested.set(r.saleItemId, (requested.get(r.saleItemId) ?? 0) + r.qty);

  const lines: { item: any; qty: number; amount: number; vat: number }[] = [];
  for (const [saleItemId, qty] of requested) {
    const item = byId.get(saleItemId);
    if (!item) throw badRequest('A returned item does not belong to this sale');
    const remaining = Math.round((item.qty - item.returned_qty) * 1000) / 1000;
    if (qty > remaining) throw badRequest(`Only ${remaining} can still be returned for this item`);
    const amount = qty === remaining ? round2(item.line_total - item.returned_amount) : round2((item.line_total * qty) / item.qty);
    lines.push({ item, qty, amount, vat: Math.min(amount, round2((item.vat_amount * qty) / item.qty)) });
  }
  if (!lines.length) throw badRequest('Select at least one item to return');

  const amount = sum(lines.map((l) => l.amount));
  const vat = sum(lines.map((l) => l.vat));
  const exVat = round2(amount - vat);
  const dueReduction = Math.min(amount, sale.due_amount);
  const refund = round2(amount - dueReduction);
  if (refund > 0) await assertMoneyAccount(db, input.accountId, 'Refund account');
  const cost = input.restock ? sum(lines.map((l) => l.qty * l.item.unit_cost)) : 0;

  const number = await nextNumber(db, 'RET');
  const ret = await db.one<{ id: string }>(
    `INSERT INTO sale_returns (number, sale_id, warehouse_id, amount, amount_ex_vat, vat_amount, cost_amount,
                               due_reduction, refund_amount, account_id, restock, reason, user_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13) RETURNING id`,
    [number, sale.id, sale.warehouse_id, amount, exVat, vat, cost, dueReduction, refund, refund > 0 ? input.accountId : null,
      input.restock, input.reason, ctx.userId],
  );

  const products = input.restock ? await lockProducts(db, lines.map((l) => l.item.product_id)) : null;
  for (const l of lines) {
    await db.exec(
      `INSERT INTO sale_return_items (return_id, sale_id, sale_item_id, product_id, qty, amount, unit_cost)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [ret.id, sale.id, l.item.id, l.item.product_id, l.qty, l.amount, l.item.unit_cost],
    );
    await db.exec(
      `UPDATE sale_items SET returned_qty = returned_qty + $2, returned_amount = returned_amount + $3 WHERE id = $1`,
      [l.item.id, l.qty, l.amount],
    );
    if (products) {
      const p = products.get(l.item.product_id)!;
      await averageIn(db, p, l.qty, l.item.unit_cost);
      await applyStock(
        db,
        ctx,
        {
          productId: p.id, warehouseId: sale.warehouse_id, qty: l.qty, unitCost: l.item.unit_cost, kind: 'sale_return',
          refType: 'sale_return', refId: ret.id, refNumber: number, note: input.reason,
        },
        { allowNegative: true },
      );
    }
  }
  await db.exec(
    `UPDATE sales SET returned_amount = returned_amount + $2, due_amount = due_amount - $3 WHERE id = $1`,
    [sale.id, amount, dueReduction],
  );

  const acc = await systemAccounts(db);
  const journalId = await postJournal(db, ctx, {
    memo: `Return ${number} against ${sale.number}`,
    refType: 'sale_return',
    refId: ret.id,
    lines: [
      { accountId: acc.SALES_RETURNS, debit: exVat },
      { accountId: acc.VAT_PAYABLE, debit: vat },
      { accountId: acc.AR, credit: dueReduction },
      ...(refund > 0 ? [{ accountId: input.accountId!, credit: refund }] : []),
      { accountId: acc.INVENTORY, debit: cost },
      { accountId: acc.COGS, credit: cost },
    ],
  });
  await db.exec(`UPDATE sale_returns SET journal_entry_id = $2 WHERE id = $1`, [ret.id, journalId]);
  await logActivity(db, ctx, 'sale.return', `Return ${number} against ${sale.number} for ${amount}`, {
    entity: 'sale_return', entityId: ret.id, details: { amount, refund, dueReduction, restock: input.restock },
  });
  return { id: ret.id, number, amount, refund, dueReduction };
}

export interface ReplacementInput {
  saleId: string | null;
  customerId: string | null;
  warehouseId: string;
  returnedProductId: string;
  returnedQty: number;
  restockReturned: boolean;
  issuedProductId: string;
  issuedQty: number;
  chargeAmount: number;
  accountId: string | null;
  reason: string | null;
}

/** Warranty-style exchange: take back a (usually defective) item, issue another. */
export async function createReplacement(db: Db, ctx: Ctx, input: ReplacementInput) {
  await assertWarehouse(db, ctx, input.warehouseId);
  let customerId = input.customerId;
  let saleNumber: string | null = null;
  if (input.saleId) {
    const sale = await db.maybe(`SELECT id, number, customer_id, status FROM sales WHERE id = $1`, [input.saleId]);
    if (!sale) throw badRequest('Sale not found');
    if (sale.status !== 'completed') throw badRequest('Cannot replace items from a void sale');
    const sold = await db.maybe<{ qty: number }>(
      `SELECT sum(qty - returned_qty) AS qty FROM sale_items WHERE sale_id = $1 AND product_id = $2`,
      [sale.id, input.returnedProductId],
    );
    if (!sold?.qty) throw badRequest('The returned product was not sold on this invoice');
    customerId = customerId ?? sale.customer_id;
    saleNumber = sale.number;
  }
  if (customerId) {
    const c = await db.maybe(`SELECT id FROM customers WHERE id = $1`, [customerId]);
    if (!c) throw badRequest('Customer not found');
  }
  if (input.chargeAmount > 0) await assertMoneyAccount(db, input.accountId);
  const settings = await getSettings(db);
  const products = await lockProducts(db, [input.returnedProductId, input.issuedProductId]);
  const issued = products.get(input.issuedProductId)!;
  const returned = products.get(input.returnedProductId)!;
  const issuedCost = round2(input.issuedQty * issued.avg_cost);
  const returnedCost = input.restockReturned ? round2(input.returnedQty * returned.avg_cost) : 0;

  const number = await nextNumber(db, 'RPL');
  const rep = await db.one<{ id: string }>(
    `INSERT INTO replacements (number, sale_id, customer_id, warehouse_id, returned_product_id, returned_qty, restock_returned,
                               issued_product_id, issued_qty, issued_cost, charge_amount, account_id, reason, user_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14) RETURNING id`,
    [number, input.saleId, customerId, input.warehouseId, input.returnedProductId, input.returnedQty, input.restockReturned,
      input.issuedProductId, input.issuedQty, issuedCost, input.chargeAmount, input.chargeAmount > 0 ? input.accountId : null,
      input.reason, ctx.userId],
  );
  const ref = { refType: 'replacement', refId: rep.id, refNumber: number, note: input.reason };
  await applyStock(db, ctx, { productId: issued.id, warehouseId: input.warehouseId, qty: -input.issuedQty, unitCost: issued.avg_cost, kind: 'replacement_out', ...ref }, { allowNegative: settings.allow_negative_stock, productName: issued.name });
  if (input.restockReturned) {
    await applyStock(db, ctx, { productId: returned.id, warehouseId: input.warehouseId, qty: input.returnedQty, unitCost: returned.avg_cost, kind: 'replacement_in', ...ref }, { allowNegative: true });
  }

  const acc = await systemAccounts(db);
  const journalId = await postJournal(db, ctx, {
    memo: `Replacement ${number}${saleNumber ? ` for ${saleNumber}` : ''}`,
    refType: 'replacement',
    refId: rep.id,
    lines: [
      { accountId: acc.REPLACEMENT, debit: issuedCost },
      { accountId: acc.INVENTORY, credit: issuedCost },
      { accountId: acc.INVENTORY, debit: returnedCost },
      { accountId: acc.REPLACEMENT, credit: returnedCost },
      ...(input.chargeAmount > 0
        ? [{ accountId: input.accountId!, debit: input.chargeAmount }, { accountId: acc.SALES, credit: input.chargeAmount }]
        : []),
    ],
  });
  await db.exec(`UPDATE replacements SET journal_entry_id = $2 WHERE id = $1`, [rep.id, journalId]);
  await logActivity(db, ctx, 'sale.replacement', `Replacement ${number}: ${returned.name} → ${issued.name}`, {
    entity: 'replacement', entityId: rep.id,
  });
  return { id: rep.id, number };
}
