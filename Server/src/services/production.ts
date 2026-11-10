import type { Ctx } from '../auth/context';
import type { Db } from '../db/pool';
import { badRequest } from '../lib/errors';
import { round2, round4 } from '../lib/money';
import { getSettings, logActivity, nextNumber } from './common';
import { applyStock, assertWarehouse, averageIn, lockProducts } from './inventory';
import { assertMoneyAccount, postJournal, systemAccounts } from './ledger';

export interface ProductionInput {
  warehouseId: string;
  outputProductId: string;
  outputQty: number;
  inputs: { productId: string; qty: number }[];
  extraCost: number;
  accountId: string | null;
  note: string | null;
}

/**
 * Consumes raw materials at moving-average cost and receives the finished
 * product at (materials + conversion cost) / output quantity.
 */
export async function postProduction(db: Db, ctx: Ctx, input: ProductionInput) {
  if (input.inputs.some((i) => i.productId === input.outputProductId)) {
    throw badRequest('The finished product cannot also be a raw material');
  }
  await assertWarehouse(db, ctx, input.warehouseId);
  if (input.extraCost > 0) await assertMoneyAccount(db, input.accountId, 'Account for extra cost');
  const settings = await getSettings(db);
  const products = await lockProducts(db, [input.outputProductId, ...input.inputs.map((i) => i.productId)]);
  const number = await nextNumber(db, 'PRD');
  const order = await db.one<{ id: string }>(
    `INSERT INTO production_orders (number, warehouse_id, output_product_id, output_qty, extra_cost, account_id, note, user_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
    [number, input.warehouseId, input.outputProductId, input.outputQty, input.extraCost,
      input.extraCost > 0 ? input.accountId : null, input.note, ctx.userId],
  );
  const ref = { refType: 'production', refId: order.id, refNumber: number };

  let materials = 0;
  for (const item of input.inputs) {
    const p = products.get(item.productId)!;
    materials += item.qty * p.avg_cost;
    await applyStock(
      db,
      ctx,
      { productId: p.id, warehouseId: input.warehouseId, qty: -item.qty, unitCost: p.avg_cost, kind: 'production_out', ...ref },
      { allowNegative: settings.allow_negative_stock, productName: p.name },
    );
    await db.exec(`INSERT INTO production_inputs (production_order_id, product_id, qty, unit_cost) VALUES ($1, $2, $3, $4)`, [
      order.id, p.id, item.qty, p.avg_cost,
    ]);
  }
  materials = round2(materials);
  const unitCost = round4((materials + input.extraCost) / input.outputQty);
  const output = products.get(input.outputProductId)!;
  await averageIn(db, output, input.outputQty, unitCost);
  await applyStock(
    db,
    ctx,
    { productId: output.id, warehouseId: input.warehouseId, qty: input.outputQty, unitCost, kind: 'production_in', ...ref },
    { allowNegative: true },
  );

  let journalId: string | null = null;
  if (input.extraCost > 0) {
    const acc = await systemAccounts(db);
    journalId = await postJournal(db, ctx, {
      memo: `Production ${number} conversion cost`,
      refType: 'production',
      refId: order.id,
      lines: [{ accountId: acc.INVENTORY, debit: input.extraCost }, { accountId: input.accountId!, credit: input.extraCost }],
    });
  }
  await db.exec(`UPDATE production_orders SET materials_cost = $2, unit_cost = $3, journal_entry_id = $4 WHERE id = $1`, [
    order.id, materials, unitCost, journalId,
  ]);
  await logActivity(db, ctx, 'production.create', `Production ${number}: ${input.outputQty} ${output.unit} ${output.name}`, {
    entity: 'production', entityId: order.id,
  });
  return { id: order.id, number, unitCost, materialsCost: materials };
}
