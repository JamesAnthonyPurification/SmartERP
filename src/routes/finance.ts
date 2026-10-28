import type { FastifyInstance } from 'fastify';
import { tenantRoutes } from '../auth/context';
import type { Db } from '../db/pool';
import { badRequest, notFound } from '../lib/errors';
import { round2 } from '../lib/money';
import { likePattern, parse, z, zBool, zDate, zId, zMoney, zOpt, zPaging, zPositiveMoney } from '../lib/validate';
import { logActivity, nextNumber, resolveRange } from '../services/common';
import { assertMoneyAccount, postJournal } from '../services/ledger';

const BALANCE_SQL = `CASE WHEN a.type IN ('asset', 'expense')
  THEN COALESCE(b.debit, 0) - COALESCE(b.credit, 0) ELSE COALESCE(b.credit, 0) - COALESCE(b.debit, 0) END`;

export async function accountBalance(db: Db, accountId: string): Promise<number> {
  const row = await db.one<{ balance: number }>(
    `SELECT ${BALANCE_SQL} AS balance FROM accounts a
     LEFT JOIN (SELECT account_id, sum(debit) AS debit, sum(credit) AS credit FROM journal_lines
                WHERE account_id = $1 GROUP BY account_id) b ON b.account_id = a.id
     WHERE a.id = $1`,
    [accountId],
  );
  return row.balance;
}

async function assertCashAvailable(db: Db, accountId: string, amount: number) {
  const acc = await db.one(`SELECT name, money_kind FROM accounts WHERE id = $1`, [accountId]);
  if (acc.money_kind !== 'cash') return;
  const balance = await accountBalance(db, accountId);
  if (amount > balance) throw badRequest(`Insufficient balance in ${acc.name} (available ${round2(balance)})`);
}

const zListRange = zPaging.extend({ from: zDate.optional(), to: zDate.optional() });

export default async function financeRoutes(app: FastifyInstance) {
  const r = tenantRoutes(app);

  // ---- Chart of accounts ----------------------------------------------
  r.get('/api/accounts', ['finance.view', 'accounts.manage'], ({ db }) =>
    db.many(
      `SELECT a.*, COALESCE(b.debit, 0) AS total_debit, COALESCE(b.credit, 0) AS total_credit, ${BALANCE_SQL} AS balance
       FROM accounts a
       LEFT JOIN (SELECT account_id, sum(debit) AS debit, sum(credit) AS credit FROM journal_lines GROUP BY account_id) b
         ON b.account_id = a.id
       ORDER BY a.code`,
    ),
  );

  const accountSchema = z.object({
    code: z.string().trim().regex(/^[0-9A-Za-z-]{1,12}$/, 'Use up to 12 letters/digits'),
    name: z.string().trim().min(2).max(120),
    type: z.enum(['asset', 'liability', 'equity', 'income', 'expense']),
    moneyKind: z.enum(['cash', 'bank', 'mobile']).nullable().optional(),
    bankName: zOpt(120),
    accountNumber: zOpt(60),
    isActive: zBool.default(true),
  });

  r.post('/api/accounts', 'accounts.manage', async ({ db, ctx, body, reply }) => {
    const b = parse(accountSchema, body);
    if (b.moneyKind && b.type !== 'asset') throw badRequest('Cash, bank and mobile accounts must be asset accounts');
    const row = await db.one(
      `INSERT INTO accounts (code, name, type, is_money, money_kind, bank_name, account_number, is_active)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
      [b.code, b.name, b.type, !!b.moneyKind, b.moneyKind ?? null, b.bankName, b.accountNumber, b.isActive],
    );
    await logActivity(db, ctx, 'account.create', `Account ${b.code} ${b.name} created`, { entity: 'account', entityId: row.id });
    reply.code(201);
    return row;
  });

  r.patch('/api/accounts/:id', 'accounts.manage', async ({ db, ctx, body, params }) => {
    const { id } = parse(z.object({ id: zId }), params);
    const b = parse(accountSchema.pick({ name: true, bankName: true, accountNumber: true, isActive: true }), body);
    const acc = await db.maybe(`SELECT system_key FROM accounts WHERE id = $1`, [id]);
    if (!acc) throw notFound('Account');
    if (acc.system_key && !b.isActive) throw badRequest('System accounts cannot be deactivated');
    const row = await db.one(
      `UPDATE accounts SET name = $2, bank_name = $3, account_number = $4, is_active = $5 WHERE id = $1 RETURNING *`,
      [id, b.name, b.bankName, b.accountNumber, b.isActive],
    );
    await logActivity(db, ctx, 'account.update', `Account ${row.code} updated`, { entity: 'account', entityId: id });
    return row;
  });

  r.get('/api/accounts/:id/ledger', ['finance.view', 'reports.view'], async ({ db, params, query }) => {
    const { id } = parse(z.object({ id: zId }), params);
    const q = parse(z.object({ from: zDate.optional(), to: zDate.optional() }), query);
    const account = await db.maybe(`SELECT id, code, name, type FROM accounts WHERE id = $1`, [id]);
    if (!account) throw notFound('Account');
    const range = await resolveRange(db, q.from, q.to);
    const sign = ['asset', 'expense'].includes(account.type) ? 1 : -1;
    const { opening } = await db.one(
      `SELECT COALESCE(sum(l.debit - l.credit), 0) * $3 AS opening
       FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id
       WHERE l.account_id = $1 AND e.entry_date < $2`,
      [id, range.from, sign],
    );
    const lines = await db.many(
      `SELECT e.id AS entry_id, e.number, e.entry_date, e.memo, e.ref_type, l.debit, l.credit, l.memo AS line_memo
       FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id
       WHERE l.account_id = $1 AND e.entry_date BETWEEN $2 AND $3
       ORDER BY e.entry_date, e.created_at`,
      [id, range.from, range.to],
    );
    let balance = round2(opening);
    const rows = lines.map((l) => {
      balance = round2(balance + sign * (l.debit - l.credit));
      return { ...l, balance };
    });
    return { account, ...range, opening: round2(opening), closing: balance, rows };
  });

  // ---- Journal --------------------------------------------------------
  r.get('/api/journal', 'finance.view', async ({ db, query }) => {
    const q = parse(zListRange, query);
    const rows = await db.many(
      `SELECT e.id, e.number, e.entry_date, e.memo, e.ref_type, e.created_at, u.name AS user_name,
              (SELECT json_agg(json_build_object('account', a.code || ' ' || a.name, 'debit', l.debit, 'credit', l.credit, 'memo', l.memo)
                               ORDER BY l.debit DESC)
               FROM journal_lines l JOIN accounts a ON a.id = l.account_id WHERE l.entry_id = e.id) AS lines,
              count(*) OVER () AS total_count
       FROM journal_entries e LEFT JOIN users u ON u.id = e.user_id
       WHERE ($1::text IS NULL OR e.memo ILIKE $1 OR e.number ILIKE $1)
         AND ($2::date IS NULL OR e.entry_date >= $2) AND ($3::date IS NULL OR e.entry_date <= $3)
       ORDER BY e.entry_date DESC, e.created_at DESC LIMIT $4 OFFSET $5`,
      [likePattern(q.q), q.from ?? null, q.to ?? null, q.pageSize, (q.page - 1) * q.pageSize],
    );
    return { rows, total: rows[0]?.total_count ?? 0 };
  });

  r.post('/api/journal', 'finance.manage', async ({ db, ctx, body, reply }) => {
    const b = parse(
      z.object({
        date: zDate,
        memo: z.string().trim().min(3).max(300),
        lines: z
          .array(z.object({ accountId: zId, debit: zMoney.default(0), credit: zMoney.default(0), memo: zOpt(200) }))
          .min(2)
          .max(50),
      }),
      body,
    );
    if (b.lines.some((l) => (l.debit > 0) === (l.credit > 0))) {
      throw badRequest('Each line needs either a debit or a credit amount');
    }
    const ids = [...new Set(b.lines.map((l) => l.accountId))];
    const { n } = await db.one(`SELECT count(*) AS n FROM accounts WHERE id = ANY($1::uuid[]) AND is_active`, [ids]);
    if (n !== ids.length) throw badRequest('One or more accounts were not found');
    const id = await postJournal(db, ctx, { date: b.date, memo: b.memo, refType: 'manual', lines: b.lines, net: false });
    await logActivity(db, ctx, 'journal.create', `Manual journal: ${b.memo}`, { entity: 'journal_entry', entityId: id });
    reply.code(201);
    return { id };
  });

  // ---- Expenses & other income ----------------------------------------
  r.get('/api/finance', 'finance.view', async ({ db, query }) => {
    const q = parse(zListRange.extend({ kind: z.enum(['expense', 'income', 'all']).default('all') }), query);
    const rows = await db.many(
      `SELECT f.id, f.number, f.kind, f.entry_date, f.amount, f.party, f.reference, f.note, f.created_at,
              ca.name AS category_name, ma.name AS account_name, u.name AS user_name,
              count(*) OVER () AS total_count, sum(f.amount) OVER () AS sum_amount
       FROM finance_entries f
       JOIN accounts ca ON ca.id = f.category_account_id
       JOIN accounts ma ON ma.id = f.money_account_id
       LEFT JOIN users u ON u.id = f.user_id
       WHERE ($1 = 'all' OR f.kind = $1) AND ($2::text IS NULL OR f.party ILIKE $2 OR f.note ILIKE $2 OR ca.name ILIKE $2)
         AND ($3::date IS NULL OR f.entry_date >= $3) AND ($4::date IS NULL OR f.entry_date <= $4)
       ORDER BY f.entry_date DESC, f.created_at DESC LIMIT $5 OFFSET $6`,
      [q.kind, likePattern(q.q), q.from ?? null, q.to ?? null, q.pageSize, (q.page - 1) * q.pageSize],
    );
    return { rows, total: rows[0]?.total_count ?? 0, sumAmount: rows[0]?.sum_amount ?? 0 };
  });

  r.post('/api/finance', 'finance.manage', async ({ db, ctx, body, reply }) => {
    const b = parse(
      z.object({
        kind: z.enum(['expense', 'income']),
        date: zDate.optional().nullable(),
        categoryAccountId: zId,
        moneyAccountId: zId,
        amount: zPositiveMoney,
        party: zOpt(160),
        reference: zOpt(80),
        note: zOpt(500),
      }),
      body,
    );
    const category = await db.maybe(`SELECT id, name, type FROM accounts WHERE id = $1 AND is_active`, [b.categoryAccountId]);
    if (!category || category.type !== b.kind) throw badRequest(`Choose an ${b.kind} category`);
    await assertMoneyAccount(db, b.moneyAccountId);
    if (b.kind === 'expense') await assertCashAvailable(db, b.moneyAccountId, b.amount);
    const number = await nextNumber(db, b.kind === 'expense' ? 'EXP' : 'INC');
    const row = await db.one(
      `INSERT INTO finance_entries (number, kind, entry_date, category_account_id, money_account_id, amount, party, reference, note, user_id)
       VALUES ($1, $2, COALESCE($3::date, app_tenant_today()), $4, $5, $6, $7, $8, $9, $10) RETURNING id, entry_date`,
      [number, b.kind, b.date ?? null, b.categoryAccountId, b.moneyAccountId, b.amount, b.party, b.reference, b.note, ctx.userId],
    );
    const lines =
      b.kind === 'expense'
        ? [{ accountId: b.categoryAccountId, debit: b.amount }, { accountId: b.moneyAccountId, credit: b.amount }]
        : [{ accountId: b.moneyAccountId, debit: b.amount }, { accountId: b.categoryAccountId, credit: b.amount }];
    const journalId = await postJournal(db, ctx, {
      date: row.entry_date,
      memo: `${b.kind === 'expense' ? 'Expense' : 'Income'} ${number}: ${category.name}${b.party ? ` — ${b.party}` : ''}`,
      refType: 'finance_entry',
      refId: row.id,
      lines,
    });
    await db.exec(`UPDATE finance_entries SET journal_entry_id = $2 WHERE id = $1`, [row.id, journalId]);
    await logActivity(db, ctx, `finance.${b.kind}`, `${b.kind === 'expense' ? 'Expense' : 'Income'} ${number}: ${b.amount}`, {
      entity: 'finance_entry', entityId: row.id,
    });
    reply.code(201);
    return { id: row.id, number };
  });

  // ---- Bank deposits / fund transfers ---------------------------------
  r.get('/api/fund-transfers', 'finance.view', async ({ db, query }) => {
    const q = parse(zListRange, query);
    const rows = await db.many(
      `SELECT t.id, t.number, t.transfer_date, t.amount, t.reference, t.note, t.created_at,
              fa.name AS from_name, ta.name AS to_name, ta.money_kind AS to_kind, u.name AS user_name,
              count(*) OVER () AS total_count
       FROM fund_transfers t
       JOIN accounts fa ON fa.id = t.from_account_id
       JOIN accounts ta ON ta.id = t.to_account_id
       LEFT JOIN users u ON u.id = t.user_id
       WHERE ($1::date IS NULL OR t.transfer_date >= $1) AND ($2::date IS NULL OR t.transfer_date <= $2)
       ORDER BY t.transfer_date DESC, t.created_at DESC LIMIT $3 OFFSET $4`,
      [q.from ?? null, q.to ?? null, q.pageSize, (q.page - 1) * q.pageSize],
    );
    return { rows, total: rows[0]?.total_count ?? 0 };
  });

  r.post('/api/fund-transfers', 'finance.manage', async ({ db, ctx, body, reply }) => {
    const b = parse(
      z.object({
        fromAccountId: zId,
        toAccountId: zId,
        amount: zPositiveMoney,
        date: zDate.optional().nullable(),
        reference: zOpt(80),
        note: zOpt(300),
      }),
      body,
    );
    if (b.fromAccountId === b.toAccountId) throw badRequest('Choose two different accounts');
    const from = await assertMoneyAccount(db, b.fromAccountId, 'Source account');
    const to = await assertMoneyAccount(db, b.toAccountId, 'Destination account');
    await assertCashAvailable(db, b.fromAccountId, b.amount);
    const number = await nextNumber(db, 'TRN');
    const row = await db.one(
      `INSERT INTO fund_transfers (number, from_account_id, to_account_id, amount, transfer_date, reference, note, user_id)
       VALUES ($1, $2, $3, $4, COALESCE($5::date, app_tenant_today()), $6, $7, $8) RETURNING id, transfer_date`,
      [number, b.fromAccountId, b.toAccountId, b.amount, b.date ?? null, b.reference, b.note, ctx.userId],
    );
    const journalId = await postJournal(db, ctx, {
      date: row.transfer_date,
      memo: `Transfer ${number}: ${from.name} → ${to.name}`,
      refType: 'fund_transfer',
      refId: row.id,
      lines: [{ accountId: b.toAccountId, debit: b.amount }, { accountId: b.fromAccountId, credit: b.amount }],
    });
    await db.exec(`UPDATE fund_transfers SET journal_entry_id = $2 WHERE id = $1`, [row.id, journalId]);
    await logActivity(db, ctx, 'finance.transfer', `Transfer ${number}: ${b.amount} ${from.name} → ${to.name}`, {
      entity: 'fund_transfer', entityId: row.id,
    });
    reply.code(201);
    return { id: row.id, number };
  });
}
