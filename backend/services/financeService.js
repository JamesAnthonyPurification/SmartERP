// ============================================================================
// FILE: src/backend/services/financeService.js
// PURPOSE: SME Cashbook (Galla), MFS Wallets (bKash/Nagad) & Bank Deposits
// ============================================================================

import { getDb } from '../../database/dbConnection.js';
import { recordAuditLog } from '../utils/auditLogger.js';
import { todayISO, generateCode } from '../utils/dateHelper.js';

export function addFinanceTransaction({ tenantId, actorName, actorRole, payload = {} }) {
  const db = getDb();
  const {
    trxType = 'EXPENSE',
    category = 'Daily Shop Expense',
    accountName,
    amount = 0,
    description = ''
  } = payload;

  const amt = Number(amount || 0);
  const trxCode = generateCode('TRX');
  const dateStr = todayISO();

  const acc =
    db.prepare('SELECT * FROM finance_accounts WHERE tenant_id = ? AND account_name = ?').get(tenantId, accountName) ||
    db.prepare('SELECT * FROM finance_accounts WHERE tenant_id = ? LIMIT 1').get(tenantId);

  if (acc) {
    if (trxType === 'INCOME' || trxType === 'BANK_DEPOSIT') {
      db.prepare('UPDATE finance_accounts SET balance = balance + ? WHERE id = ?').run(amt, acc.id);
    } else {
      db.prepare('UPDATE finance_accounts SET balance = MAX(0, balance - ?) WHERE id = ?').run(amt, acc.id);
    }

    // For BANK_DEPOSIT, deduct the cash transferred out of the Showroom Cash Drawer (Galla)
    if (trxType === 'BANK_DEPOSIT') {
      const cashAcc = db
        .prepare("SELECT * FROM finance_accounts WHERE tenant_id = ? AND account_type = 'Cash Drawer' LIMIT 1")
        .get(tenantId);
      if (cashAcc && cashAcc.id !== acc.id) {
        db.prepare('UPDATE finance_accounts SET balance = MAX(0, balance - ?) WHERE id = ?').run(amt, cashAcc.id);
      }
    }
  }

  db.prepare(`
    INSERT INTO finance_transactions (tenant_id, trx_code, trx_type, category, account_name, amount, description, trx_date)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(tenantId, trxCode, trxType, category, acc ? acc.account_name : accountName, amt, description, dateStr);

  recordAuditLog({
    tenantId,
    actorName,
    actorRole,
    moduleName: 'Finance & Accounts',
    actionText: `Recorded ${trxType} (${category}) of ৳${amt}`,
    severity: 'info'
  });

  return { ok: true, trxCode };
}

export function deleteFinanceTransaction({ tenantId, actorName, actorRole, payload = {} }) {
  const db = getDb();
  const { id } = payload;
  db.prepare('DELETE FROM finance_transactions WHERE id = ? AND tenant_id = ?').run(id, tenantId);

  recordAuditLog({
    tenantId,
    actorName,
    actorRole,
    moduleName: 'Finance & Accounts',
    actionText: `Deleted cashbook voucher #${id}`,
    severity: 'warning'
  });

  return { ok: true };
}

