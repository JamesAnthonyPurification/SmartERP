import type { Ctx } from '../auth/context';
import type { Db } from '../db/pool';
import { badRequest } from '../lib/errors';
import { round2 } from '../lib/money';
import { nextNumber } from './common';

export type SystemKey =
  | 'CASH' | 'BANK' | 'MOBILE' | 'AR' | 'INVENTORY' | 'AP' | 'VAT_PAYABLE' | 'EQUITY' | 'OPENING_EQUITY'
  | 'SALES' | 'SALES_RETURNS' | 'OTHER_INCOME' | 'COGS' | 'INV_ADJ' | 'REPLACEMENT' | 'SALARY';

type AccountSeed = {
  code: string;
  name: string;
  type: 'asset' | 'liability' | 'equity' | 'income' | 'expense';
  systemKey?: SystemKey;
  moneyKind?: 'cash' | 'bank' | 'mobile';
};

export const DEFAULT_ACCOUNTS: AccountSeed[] = [
  { code: '1000', name: 'Cash in Hand', type: 'asset', systemKey: 'CASH', moneyKind: 'cash' },
  { code: '1010', name: 'Bank Account', type: 'asset', systemKey: 'BANK', moneyKind: 'bank' },
  { code: '1020', name: 'Mobile Banking (bKash/Nagad)', type: 'asset', systemKey: 'MOBILE', moneyKind: 'mobile' },
  { code: '1100', name: 'Accounts Receivable', type: 'asset', systemKey: 'AR' },
  { code: '1200', name: 'Inventory', type: 'asset', systemKey: 'INVENTORY' },
  { code: '2000', name: 'Accounts Payable', type: 'liability', systemKey: 'AP' },
  { code: '2100', name: 'VAT Payable', type: 'liability', systemKey: 'VAT_PAYABLE' },
  { code: '3000', name: "Owner's Capital", type: 'equity', systemKey: 'EQUITY' },
  { code: '3100', name: 'Opening Balance Equity', type: 'equity', systemKey: 'OPENING_EQUITY' },
  { code: '4000', name: 'Sales Revenue', type: 'income', systemKey: 'SALES' },
  { code: '4100', name: 'Sales Returns', type: 'income', systemKey: 'SALES_RETURNS' },
  { code: '4900', name: 'Other Income', type: 'income', systemKey: 'OTHER_INCOME' },
  { code: '5000', name: 'Cost of Goods Sold', type: 'expense', systemKey: 'COGS' },
  { code: '5100', name: 'Inventory Adjustments', type: 'expense', systemKey: 'INV_ADJ' },
  { code: '5150', name: 'Replacement & Warranty', type: 'expense', systemKey: 'REPLACEMENT' },
  { code: '5200', name: 'Salaries & Wages', type: 'expense', systemKey: 'SALARY' },
  { code: '5300', name: 'Rent', type: 'expense' },
  { code: '5400', name: 'Utilities (Electricity, Gas, Water)', type: 'expense' },
  { code: '5500', name: 'Transport & Delivery', type: 'expense' },
  { code: '5600', name: 'Office Supplies', type: 'expense' },
  { code: '5700', name: 'Marketing', type: 'expense' },
  { code: '5900', name: 'Miscellaneous Expense', type: 'expense' },
];

export async function seedAccounts(db: Db) {
  for (const a of DEFAULT_ACCOUNTS) {
    await db.exec(
      `INSERT INTO accounts (code, name, type, system_key, is_money, money_kind) VALUES ($1, $2, $3, $4, $5, $6)`,
      [a.code, a.name, a.type, a.systemKey ?? null, !!a.moneyKind, a.moneyKind ?? null],
    );
  }
}

export async function systemAccounts(db: Db): Promise<Record<SystemKey, string>> {
  const rows = await db.many<{ system_key: SystemKey; id: string }>(
    `SELECT system_key, id FROM accounts WHERE system_key IS NOT NULL`,
  );
  return Object.fromEntries(rows.map((r) => [r.system_key, r.id])) as Record<SystemKey, string>;
}

/** Validates that the account is an active cash/bank/mobile account of this tenant. */
export async function assertMoneyAccount(db: Db, accountId: string | null | undefined, label = 'Payment account') {
  if (!accountId) throw badRequest(`${label} is required`);
  const row = await db.maybe(`SELECT id, name FROM accounts WHERE id = $1 AND is_money AND is_active`, [accountId]);
  if (!row) throw badRequest(`${label} not found`);
  return row as { id: string; name: string };
}

export interface JournalLine {
  accountId: string;
  debit?: number;
  credit?: number;
  memo?: string | null;
}

export interface JournalInput {
  date?: string | null;
  memo: string;
  refType?: string;
  refId?: string | null;
  reversesId?: string | null;
  lines: JournalLine[];
  /** Automatic postings are netted per account; manual entries keep each line. */
  net?: boolean;
}

/**
 * Posts a balanced journal entry. The deferred constraint trigger on
 * journal_lines re-checks the balance at commit.
 */
export async function postJournal(db: Db, ctx: Ctx, input: JournalInput): Promise<string | null> {
  let lines: { accountId: string; debit: number; credit: number; memo: string | null }[];
  if (input.net !== false) {
    const net = new Map<string, number>();
    for (const l of input.lines) {
      net.set(l.accountId, round2((net.get(l.accountId) ?? 0) + (l.debit ?? 0) - (l.credit ?? 0)));
    }
    lines = [...net]
      .filter(([, v]) => v !== 0)
      .map(([accountId, v]) => ({ accountId, debit: v > 0 ? v : 0, credit: v < 0 ? -v : 0, memo: null }));
  } else {
    lines = input.lines
      .map((l) => ({ accountId: l.accountId, debit: round2(l.debit ?? 0), credit: round2(l.credit ?? 0), memo: l.memo ?? null }))
      .filter((l) => l.debit > 0 || l.credit > 0);
  }
  if (!lines.length) return null;

  const debit = round2(lines.reduce((a, l) => a + l.debit, 0));
  const credit = round2(lines.reduce((a, l) => a + l.credit, 0));
  if (debit !== credit) throw badRequest(`Journal entry is not balanced (debit ${debit}, credit ${credit})`);

  const number = await nextNumber(db, 'JE');
  const entry = await db.one<{ id: string }>(
    `INSERT INTO journal_entries (number, entry_date, memo, ref_type, ref_id, reverses_id, user_id)
     VALUES ($1, COALESCE($2::date, app_tenant_today()), $3, $4, $5, $6, $7) RETURNING id`,
    [number, input.date ?? null, input.memo, input.refType ?? null, input.refId ?? null, input.reversesId ?? null, ctx.userId || null],
  );
  await db.exec(
    `INSERT INTO journal_lines (entry_id, account_id, debit, credit, memo)
     SELECT $1, a, d, c, m FROM unnest($2::uuid[], $3::numeric[], $4::numeric[], $5::text[]) AS t(a, d, c, m)`,
    [entry.id, lines.map((l) => l.accountId), lines.map((l) => l.debit), lines.map((l) => l.credit), lines.map((l) => l.memo)],
  );
  return entry.id;
}

/** Posts the mirror image of an entry (used for voids). */
export async function reverseJournal(db: Db, ctx: Ctx, entryId: string, memo: string, refType: string, refId: string) {
  const lines = await db.many<{ account_id: string; debit: number; credit: number }>(
    `SELECT account_id, debit, credit FROM journal_lines WHERE entry_id = $1`,
    [entryId],
  );
  return postJournal(db, ctx, {
    memo,
    refType,
    refId,
    reversesId: entryId,
    lines: lines.map((l) => ({ accountId: l.account_id, debit: l.credit, credit: l.debit })),
  });
}

/** Signed balance convention: assets/expenses are debit-normal, the rest credit-normal. */
export const NORMAL_DEBIT_TYPES = ['asset', 'expense'];
