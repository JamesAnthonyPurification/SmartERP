// ============================================================================
// FILE: src/backend/services/customerKhataService.js
// PURPOSE: SME Customer Credit Ledger (Baki / Khata) & Due Recovery Service
// ============================================================================

import { getDb } from '../../database/dbConnection.js';
import { recordAuditLog } from '../utils/auditLogger.js';
import { todayISO, generateCode, generateYearlyCode } from '../utils/dateHelper.js';

export function addCustomer({ tenantId, actorName, actorRole, payload = {} }) {
  const db = getDb();
  const {
    name,
    shopName,
    phone,
    address,
    customerType = 'Wholesale',
    creditLimit = 50000,
    openingDue = 0,
    notes = ''
  } = payload;

  db.prepare(`
    INSERT INTO customers (tenant_id, name, shop_name, phone, address, customer_type, credit_limit, current_due, total_purchased, last_payment_date, trust_score, notes)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, 90, ?)
  `).run(
    tenantId,
    name,
    shopName || name,
    phone,
    address || 'Dhaka',
    customerType,
    Number(creditLimit || 50000),
    Number(openingDue || 0),
    todayISO(),
    notes
  );

  recordAuditLog({
    tenantId,
    actorName,
    actorRole,
    moduleName: 'Customers',
    actionText: `Registered ${customerType} customer "${shopName || name}"`,
    severity: 'info'
  });

  return { ok: true };
}

export function updateCustomer({ tenantId, actorName, actorRole, payload = {} }) {
  const db = getDb();
  const { id, name, shopName, phone, address, customerType, creditLimit, currentDue } = payload;

  db.prepare(`
    UPDATE customers
    SET name = ?,
        shop_name = ?,
        phone = ?,
        address = ?,
        customer_type = ?,
        credit_limit = ?,
        current_due = ?
    WHERE id = ? AND tenant_id = ?
  `).run(
    name,
    shopName || name,
    phone,
    address || '',
    customerType || 'Wholesale',
    Number(creditLimit || 0),
    Number(currentDue || 0),
    Number(id),
    tenantId
  );

  recordAuditLog({
    tenantId,
    actorName,
    actorRole,
    moduleName: 'Customers',
    actionText: `Updated customer "${shopName || name}" (Due: ৳${currentDue})`,
    severity: 'info'
  });

  return { ok: true };
}

export function deleteCustomer({ tenantId, actorName, actorRole, payload = {} }) {
  const db = getDb();
  const { id } = payload;
  const cust = db.prepare('SELECT shop_name, name FROM customers WHERE id = ? AND tenant_id = ?').get(id, tenantId);
  db.prepare('DELETE FROM customers WHERE id = ? AND tenant_id = ?').run(id, tenantId);

  recordAuditLog({
    tenantId,
    actorName,
    actorRole,
    moduleName: 'Customers',
    actionText: `Deleted customer "${cust?.shop_name || cust?.name || id}"`,
    severity: 'warning'
  });

  return { ok: true };
}

export function collectCustomerDue({ tenantId, actorName, actorRole, payload = {} }) {
  const db = getDb();
  const { customerId, amount, paymentMethod = 'Cash', referenceNote = 'Baki Khata Installment' } = payload;
  const customer = db.prepare('SELECT * FROM customers WHERE id = ? AND tenant_id = ?').get(customerId, tenantId);
  if (!customer) return { ok: false, error: 'Customer not found' };

  const paidAmt = Number(amount || 0);
  const receiptNo = generateYearlyCode('MR', 3);
  const dateStr = todayISO();

  db.prepare('UPDATE customers SET current_due = MAX(0, current_due - ?), last_payment_date = ? WHERE id = ?')
    .run(paidAmt, dateStr, customer.id);

  db.prepare(`
    INSERT INTO due_collections (tenant_id, receipt_no, customer_id, customer_name, amount, payment_method, reference_note, collected_by, collection_date)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    tenantId,
    receiptNo,
    customer.id,
    `${customer.shop_name || customer.name}`,
    paidAmt,
    paymentMethod,
    referenceNote,
    actorName,
    dateStr
  );

  const acc =
    db.prepare('SELECT * FROM finance_accounts WHERE tenant_id = ? AND account_name LIKE ? LIMIT 1').get(
      tenantId,
      `%${paymentMethod === 'Cash' ? 'Cash' : paymentMethod}%`
    ) || db.prepare('SELECT * FROM finance_accounts WHERE tenant_id = ? LIMIT 1').get(tenantId);

  if (acc) {
    db.prepare('UPDATE finance_accounts SET balance = balance + ? WHERE id = ?').run(paidAmt, acc.id);
    db.prepare(`
      INSERT INTO finance_transactions (tenant_id, trx_code, trx_type, category, account_name, amount, description, trx_date)
      VALUES (?, ?, 'DUE_COLLECTION', 'Customer Baki Recovery', ?, ?, ?, ?)
    `).run(
      tenantId,
      generateCode('TRX'),
      acc.account_name,
      paidAmt,
      `Baki collected from ${customer.shop_name || customer.name} (${receiptNo})`,
      dateStr
    );
  }

  recordAuditLog({
    tenantId,
    actorName,
    actorRole,
    moduleName: 'Collect Due',
    actionText: `Collected ৳${paidAmt} due from ${customer.shop_name || customer.name} via ${paymentMethod}`,
    severity: 'success'
  });

  return { ok: true, receiptNo };
}

export function deleteDueCollection({ tenantId, actorName, actorRole, payload = {} }) {
  const db = getDb();
  const { id } = payload;
  db.prepare('DELETE FROM due_collections WHERE id = ? AND tenant_id = ?').run(id, tenantId);

  recordAuditLog({
    tenantId,
    actorName,
    actorRole,
    moduleName: 'Collect Due',
    actionText: `Deleted money receipt record #${id}`,
    severity: 'warning'
  });

  return { ok: true };
}

