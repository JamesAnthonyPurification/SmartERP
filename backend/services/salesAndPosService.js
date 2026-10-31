// ============================================================================
// FILE: src/backend/services/salesAndPosService.js
// PURPOSE: Retail & Wholesale POS Billing, Invoice History, Returns & Warranty
// ============================================================================

import { getDb } from '../../database/dbConnection.js';
import { recordAuditLog } from '../utils/auditLogger.js';
import { todayISO, generateCode, generateYearlyCode } from '../utils/dateHelper.js';

export function createPosSale({ tenantId, actorName, actorRole, payload = {} }) {
  const db = getDb();
  const {
    customerId,
    customerName,
    customerPhone,
    saleType = 'Retail',
    items = [],
    discount = 0,
    vatAmount = 0,
    paidAmount = 0,
    paymentMethod = 'Cash',
    mfsTrxId = ''
  } = payload;

  let subtotal = 0;
  let totalCost = 0;

  for (const item of items) {
    const qty = Number(item.qty || 1);
    const price = Number(item.price || 0);
    const cost = Number(item.cost || 0);
    subtotal += qty * price;
    totalCost += qty * cost;

    db.prepare('UPDATE products SET stock_qty = MAX(0, stock_qty - ?) WHERE id = ? AND tenant_id = ?')
      .run(qty, item.productId, tenantId);
  }

  const totalAmount = Math.max(0, subtotal - Number(discount || 0) + Number(vatAmount || 0));
  const actualPaid = Math.min(totalAmount, Number(paidAmount || 0));
  const dueAmount = Math.max(0, totalAmount - actualPaid);
  const profitAmount = totalAmount - totalCost;
  const invoiceNo = generateYearlyCode('INV', 4);
  const saleDate = todayISO();

  db.prepare(`
    INSERT INTO sales (tenant_id, invoice_no, customer_id, customer_name, customer_phone, sale_type, subtotal, discount, vat_amount, total_amount, paid_amount, due_amount, profit_amount, payment_method, mfs_trx_id, sold_by, sale_date, items_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    tenantId,
    invoiceNo,
    customerId || null,
    customerName || 'Walk-in Retail Customer',
    customerPhone || '',
    saleType,
    subtotal,
    Number(discount || 0),
    Number(vatAmount || 0),
    totalAmount,
    actualPaid,
    dueAmount,
    profitAmount,
    paymentMethod,
    mfsTrxId,
    actorName,
    saleDate,
    JSON.stringify(items)
  );

  // Sync Customer Baki / Credit Ledger if a registered customer is linked
  if (customerId) {
    db.prepare(`
      UPDATE customers
      SET current_due = current_due + ?,
          total_purchased = total_purchased + ?,
          last_payment_date = ?
      WHERE id = ? AND tenant_id = ?
    `).run(dueAmount, totalAmount, saleDate, customerId, tenantId);
  }

  // Sync Finance Cashbook & Wallet Balance if payment was collected
  if (actualPaid > 0) {
    const targetType =
      paymentMethod === 'bKash'
        ? 'bKash'
        : paymentMethod === 'Nagad'
          ? 'Nagad'
          : paymentMethod === 'Bank'
            ? 'Bank'
            : 'Cash';

    const acc =
      db.prepare('SELECT * FROM finance_accounts WHERE tenant_id = ? AND account_name LIKE ? LIMIT 1').get(tenantId, `%${targetType}%`) ||
      db.prepare('SELECT * FROM finance_accounts WHERE tenant_id = ? LIMIT 1').get(tenantId);

    if (acc) {
      db.prepare('UPDATE finance_accounts SET balance = balance + ? WHERE id = ?').run(actualPaid, acc.id);
      db.prepare(`
        INSERT INTO finance_transactions (tenant_id, trx_code, trx_type, category, account_name, amount, description, trx_date)
        VALUES (?, ?, 'INCOME', 'POS & Wholesale Sales', ?, ?, ?, ?)
      `).run(
        tenantId,
        generateCode('TRX'),
        acc.account_name,
        actualPaid,
        `Sale Invoice ${invoiceNo} (${saleType}) - ${customerName || 'Walk-in Customer'}`,
        saleDate
      );
    }
  }

  recordAuditLog({
    tenantId,
    actorName,
    actorRole,
    moduleName: 'POS Sales',
    actionText: `Created ${saleType} Invoice ${invoiceNo} for ${customerName || 'Walk-in Customer'} (Total: ৳${totalAmount})`,
    severity: 'success'
  });

  return { ok: true, invoiceNo };
}

export function deleteSale({ tenantId, actorName, actorRole, payload = {} }) {
  const db = getDb();
  const { id } = payload;
  const sale = db.prepare('SELECT invoice_no FROM sales WHERE id = ? AND tenant_id = ?').get(id, tenantId);
  db.prepare('DELETE FROM sales WHERE id = ? AND tenant_id = ?').run(id, tenantId);

  recordAuditLog({
    tenantId,
    actorName,
    actorRole,
    moduleName: 'Manage Sales',
    actionText: `Deleted invoice record ${sale?.invoice_no || id}`,
    severity: 'warning'
  });

  return { ok: true };
}

export function createReturnOrReplacement({ tenantId, actorName, actorRole, payload = {} }) {
  const db = getDb();
  const {
    recordType = 'RETURN',
    invoiceNo = 'INV-2026-1001',
    customerName = 'Walk-in Customer',
    productId,
    serialNo = '',
    qty = 1,
    reason = 'Defective / Warranty Claim'
  } = payload;

  const product = db.prepare('SELECT * FROM products WHERE id = ? AND tenant_id = ?').get(productId, tenantId);
  const itemName = product ? product.name : 'Catalog Item';
  const itemPrice = product ? product.wholesale_price : 100;
  const claimNo = generateYearlyCode(recordType === 'REPLACEMENT' ? 'WR' : 'RT', 2);

  db.prepare(`
    INSERT INTO returns_replacements (tenant_id, claim_no, record_type, invoice_no, customer_name, product_id, product_name, serial_no, qty, amount, reason, status, created_date)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    tenantId,
    claimNo,
    recordType,
    invoiceNo,
    customerName,
    productId || 1,
    itemName,
    serialNo || `SN-${Math.floor(10000 + Math.random() * 89999)}`,
    Number(qty || 1),
    Number(qty || 1) * Number(itemPrice),
    reason,
    recordType === 'REPLACEMENT' ? 'Replaced from Warranty' : 'Completed',
    todayISO()
  );

  if (product) {
    if (recordType === 'RETURN') {
      db.prepare('UPDATE products SET stock_qty = stock_qty + ? WHERE id = ?').run(Number(qty || 1), product.id);
    } else {
      db.prepare('UPDATE products SET stock_qty = MAX(0, stock_qty - ?) WHERE id = ?').run(Number(qty || 1), product.id);
    }
  }

  recordAuditLog({
    tenantId,
    actorName,
    actorRole,
    moduleName: recordType === 'REPLACEMENT' ? 'Replacements' : 'Returns',
    actionText: `Logged ${recordType} ${claimNo} for ${itemName}`,
    severity: 'warning'
  });

  return { ok: true, claimNo };
}

export function deleteReturnRecord({ tenantId, actorName, actorRole, payload = {} }) {
  const db = getDb();
  const { id } = payload;
  db.prepare('DELETE FROM returns_replacements WHERE id = ? AND tenant_id = ?').run(id, tenantId);

  recordAuditLog({
    tenantId,
    actorName,
    actorRole,
    moduleName: 'Returns',
    actionText: `Deleted return/replacement record #${id}`,
    severity: 'warning'
  });

  return { ok: true };
}

