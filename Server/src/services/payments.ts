import type { Ctx } from '../auth/context';
import type { Db } from '../db/pool';
import { badRequest } from '../lib/errors';
import { round2 } from '../lib/money';
import { logActivity, nextNumber } from './common';
import { assertMoneyAccount, postJournal, systemAccounts } from './ledger';

interface OpenDoc {
  id: string;
  number: string;
  due_amount: number;
}

/** FIFO allocation (oldest first) unless the user picked documents explicitly. */
function allocate(open: OpenDoc[], amount: number, explicit?: { docId: string; amount: number }[] | null) {
  const totalDue = round2(open.reduce((a, d) => a + d.due_amount, 0));
  if (amount > totalDue) throw badRequest(`Amount exceeds the total outstanding (${totalDue})`);
  const result: { id: string; amount: number }[] = [];
  if (explicit?.length) {
    const byId = new Map(open.map((d) => [d.id, d]));
    let allocated = 0;
    for (const e of explicit) {
      const doc = byId.get(e.docId);
      if (!doc) throw badRequest('An allocation refers to a document that is not outstanding for this party');
      if (e.amount > doc.due_amount) throw badRequest(`Allocation exceeds the due on ${doc.number}`);
      result.push({ id: doc.id, amount: e.amount });
      allocated = round2(allocated + e.amount);
    }
    if (allocated !== amount) throw badRequest('Allocations must add up to the payment amount');
    return result;
  }
  let remaining = amount;
  for (const doc of open) {
    if (remaining <= 0) break;
    const take = round2(Math.min(remaining, doc.due_amount));
    result.push({ id: doc.id, amount: take });
    remaining = round2(remaining - take);
  }
  return result;
}

export interface PaymentInput {
  partyId: string;
  accountId: string;
  amount: number;
  paymentDate?: string | null;
  note: string | null;
  allocations?: { docId: string; amount: number }[] | null;
}

/** Due collection from a customer, applied to that customer's open invoices. */
export async function createCustomerPayment(db: Db, ctx: Ctx, input: PaymentInput) {
  const customer = await db.maybe(`SELECT id, name FROM customers WHERE id = $1`, [input.partyId]);
  if (!customer) throw badRequest('Customer not found');
  await assertMoneyAccount(db, input.accountId);
  const open = await db.many<OpenDoc>(
    `SELECT id, number, due_amount FROM sales
     WHERE customer_id = $1 AND status = 'completed' AND due_amount > 0
     ORDER BY sale_date, id FOR UPDATE`,
    [customer.id],
  );
  const allocations = allocate(open, input.amount, input.allocations);
  const number = await nextNumber(db, 'RCV');
  const payment = await db.one<{ id: string; payment_date: string }>(
    `INSERT INTO customer_payments (number, customer_id, account_id, amount, payment_date, note, user_id)
     VALUES ($1, $2, $3, $4, COALESCE($5::date, app_tenant_today()), $6, $7) RETURNING id, payment_date`,
    [number, customer.id, input.accountId, input.amount, input.paymentDate ?? null, input.note, ctx.userId],
  );
  for (const a of allocations) {
    // customer_id in the allocation makes the DB enforce "same customer".
    await db.exec(
      `INSERT INTO customer_payment_allocations (payment_id, sale_id, customer_id, amount) VALUES ($1, $2, $3, $4)`,
      [payment.id, a.id, customer.id, a.amount],
    );
    await db.exec(`UPDATE sales SET due_amount = due_amount - $2 WHERE id = $1`, [a.id, a.amount]);
  }
  const acc = await systemAccounts(db);
  const journalId = await postJournal(db, ctx, {
    date: payment.payment_date,
    memo: `Due collection ${number} from ${customer.name}`,
    refType: 'customer_payment',
    refId: payment.id,
    lines: [
      { accountId: input.accountId, debit: input.amount },
      { accountId: acc.AR, credit: input.amount },
    ],
  });
  await db.exec(`UPDATE customer_payments SET journal_entry_id = $2 WHERE id = $1`, [payment.id, journalId]);
  await logActivity(db, ctx, 'collection.create', `Collected ${input.amount} from ${customer.name} (${number})`, {
    entity: 'customer_payment', entityId: payment.id, details: { allocations },
  });
  return { id: payment.id, number, allocations };
}

/** Payment to a supplier, applied to that supplier's unpaid purchases. */
export async function createSupplierPayment(db: Db, ctx: Ctx, input: PaymentInput) {
  const supplier = await db.maybe(`SELECT id, name FROM suppliers WHERE id = $1`, [input.partyId]);
  if (!supplier) throw badRequest('Supplier not found');
  await assertMoneyAccount(db, input.accountId);
  const open = await db.many<OpenDoc>(
    `SELECT id, number, due_amount FROM purchases
     WHERE supplier_id = $1 AND due_amount > 0 ORDER BY purchase_date, id FOR UPDATE`,
    [supplier.id],
  );
  const allocations = allocate(open, input.amount, input.allocations);
  const number = await nextNumber(db, 'PAY');
  const payment = await db.one<{ id: string; payment_date: string }>(
    `INSERT INTO supplier_payments (number, supplier_id, account_id, amount, payment_date, note, user_id)
     VALUES ($1, $2, $3, $4, COALESCE($5::date, app_tenant_today()), $6, $7) RETURNING id, payment_date`,
    [number, supplier.id, input.accountId, input.amount, input.paymentDate ?? null, input.note, ctx.userId],
  );
  for (const a of allocations) {
    await db.exec(
      `INSERT INTO supplier_payment_allocations (payment_id, purchase_id, supplier_id, amount) VALUES ($1, $2, $3, $4)`,
      [payment.id, a.id, supplier.id, a.amount],
    );
    await db.exec(`UPDATE purchases SET due_amount = due_amount - $2 WHERE id = $1`, [a.id, a.amount]);
  }
  const acc = await systemAccounts(db);
  const journalId = await postJournal(db, ctx, {
    date: payment.payment_date,
    memo: `Supplier payment ${number} to ${supplier.name}`,
    refType: 'supplier_payment',
    refId: payment.id,
    lines: [
      { accountId: acc.AP, debit: input.amount },
      { accountId: input.accountId, credit: input.amount },
    ],
  });
  await db.exec(`UPDATE supplier_payments SET journal_entry_id = $2 WHERE id = $1`, [payment.id, journalId]);
  await logActivity(db, ctx, 'supplier.payment', `Paid ${input.amount} to ${supplier.name} (${number})`, {
    entity: 'supplier_payment', entityId: payment.id, details: { allocations },
  });
  return { id: payment.id, number, allocations };
}
