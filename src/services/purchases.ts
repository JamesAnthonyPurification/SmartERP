import type { Ctx } from '../auth/context';
import type { Db } from '../db/pool';
import { badRequest } from '../lib/errors';
import { round2, sum } from '../lib/money';
import { getSettings, logActivity, nextNumber } from './common';
import { applyStock, assertWarehouse, averageIn, lockProducts } from './inventory';
import { assertMoneyAccount, postJournal, systemAccounts } from './ledger';

export interface PurchaseInput {
  supplierId: string | null;
  warehouseId: string;
  purchaseDate?: string | null;
  reference?: string | null;
  note?: string | null;
  items: { productId: string; qty: number; unitCost: number }[];
  paidAmount: number;
  accountId: string | null;
}

/** Stock In: receives goods, updates moving-average cost and posts the payable. */
export async function createPurchase(db: Db, ctx: Ctx, input: PurchaseInput) {
  await assertWarehouse(db, ctx, input.warehouseId);
  if (input.supplierId) {
    const s = await db.maybe(`SELECT id FROM suppliers WHERE id = $1 AND is_active`, [input.supplierId]);
    if (!s) throw badRequest('Supplier not found');
  }
  const products = await lockProducts(db, input.items.map((i) => i.productId));
  const lines = input.items.map((i) => ({ ...i, lineTotal: round2(i.qty * i.unitCost) }));
  const total = sum(lines.map((l) => l.lineTotal));
  if (input.paidAmount > total) throw badRequest('Paid amount cannot exceed the purchase total');
  const due = round2(total - input.paidAmount);
  if (due > 0 && !input.supplierId) throw badRequest('Select a supplier for a purchase on credit');
  if (input.paidAmount > 0) await assertMoneyAccount(db, input.accountId);
  const settings = await getSettings(db);

  const number = await nextNumber(db, 'PUR');
  const purchase = await db.one<{ id: string; purchase_date: string }>(
    `INSERT INTO purchases (number, supplier_id, warehouse_id, purchase_date, reference, total, paid_amount, due_amount, note, user_id)
     VALUES ($1, $2, $3, COALESCE($4::date, app_tenant_today()), $5, $6, $7, $8, $9, $10)
     RETURNING id, purchase_date`,
    [number, input.supplierId, input.warehouseId, input.purchaseDate ?? null, input.reference ?? null, total,
      input.paidAmount, due, input.note ?? null, ctx.userId],
  );

  for (const line of lines) {
    const p = products.get(line.productId)!;
    await db.exec(
      `INSERT INTO purchase_items (purchase_id, product_id, qty, unit_cost, line_total) VALUES ($1, $2, $3, $4, $5)`,
      [purchase.id, p.id, line.qty, line.unitCost, line.lineTotal],
    );
    await averageIn(db, p, line.qty, line.unitCost);
    await applyStock(
      db,
      ctx,
      {
        productId: p.id, warehouseId: input.warehouseId, qty: line.qty, unitCost: line.unitCost, kind: 'purchase',
        refType: 'purchase', refId: purchase.id, refNumber: number,
      },
      { allowNegative: settings.allow_negative_stock, productName: p.name },
    );
    await db.exec(`UPDATE products SET purchase_price = $2 WHERE id = $1`, [p.id, line.unitCost]);
  }

  const acc = await systemAccounts(db);
  const journalId = await postJournal(db, ctx, {
    date: purchase.purchase_date,
    memo: `Stock in ${number}`,
    refType: 'purchase',
    refId: purchase.id,
    lines: [
      { accountId: acc.INVENTORY, debit: total },
      ...(input.paidAmount > 0 ? [{ accountId: input.accountId!, credit: input.paidAmount }] : []),
      { accountId: acc.AP, credit: due },
    ],
  });
  if (journalId) await db.exec(`UPDATE purchases SET journal_entry_id = $2 WHERE id = $1`, [purchase.id, journalId]);
  await logActivity(db, ctx, 'purchase.create', `Stock in ${number} for ${total}`, {
    entity: 'purchase', entityId: purchase.id, details: { total, paid: input.paidAmount, items: lines.length },
  });
  return purchase.id;
}
