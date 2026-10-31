// ============================================================================
// FILE: src/backend/services/inventoryService.js
// PURPOSE: Products Catalog, Stock Batches, Adjustments & Light Production BOM
// ============================================================================

import { getDb } from '../../database/dbConnection.js';
import { recordAuditLog } from '../utils/auditLogger.js';
import { todayISO, generateCode } from '../utils/dateHelper.js';

export function addProduct({ tenantId, actorName, actorRole, payload = {} }) {
  const db = getDb();
  const {
    sku,
    barcode,
    name,
    nameBn,
    category,
    unit = 'Pcs',
    purchasePrice,
    retailPrice,
    wholesalePrice,
    minWholesaleQty = 5,
    stockQty = 0,
    alertQty = 10,
    warrantyMonths = 0,
    expiryDate = null,
    supplierName = 'Direct Supplier'
  } = payload;

  db.prepare(`
    INSERT INTO products (tenant_id, sku, barcode, name, name_bn, category, unit, purchase_price, retail_price, wholesale_price, min_wholesale_qty, stock_qty, alert_qty, warranty_months, expiry_date, warehouse_id, supplier_name)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)
  `).run(
    tenantId,
    sku || `SKU-${Math.floor(100 + Math.random() * 900)}`,
    barcode || `894${Math.floor(1000000 + Math.random() * 9000000)}`,
    name,
    nameBn || '',
    category || 'General',
    unit,
    Number(purchasePrice || 0),
    Number(retailPrice || 0),
    Number(wholesalePrice || retailPrice || 0),
    Number(minWholesaleQty || 5),
    Number(stockQty || 0),
    Number(alertQty || 10),
    Number(warrantyMonths || 0),
    expiryDate || null,
    supplierName
  );

  recordAuditLog({
    tenantId,
    actorName,
    actorRole,
    moduleName: 'Products',
    actionText: `Added product "${name}" (Stock: ${stockQty} ${unit})`,
    severity: 'success'
  });

  return { ok: true };
}

export function updateProduct({ tenantId, actorName, actorRole, payload = {} }) {
  const db = getDb();
  const {
    id,
    sku,
    name,
    nameBn,
    category,
    unit,
    purchasePrice,
    wholesalePrice,
    retailPrice,
    stockQty,
    warrantyMonths
  } = payload;

  db.prepare(`
    UPDATE products
    SET sku = ?,
        name = ?,
        name_bn = ?,
        category = ?,
        unit = ?,
        purchase_price = ?,
        wholesale_price = ?,
        retail_price = ?,
        stock_qty = ?,
        warranty_months = ?
    WHERE id = ? AND tenant_id = ?
  `).run(
    sku,
    name,
    nameBn || '',
    category || 'General',
    unit || 'Pcs',
    Number(purchasePrice || 0),
    Number(wholesalePrice || 0),
    Number(retailPrice || 0),
    Number(stockQty || 0),
    Number(warrantyMonths || 0),
    Number(id),
    tenantId
  );

  recordAuditLog({
    tenantId,
    actorName,
    actorRole,
    moduleName: 'Products',
    actionText: `Updated product "${name}" (Stock: ${stockQty}, Wholesale: ৳${wholesalePrice}, Retail: ৳${retailPrice})`,
    severity: 'info'
  });

  return { ok: true };
}

export function deleteProduct({ tenantId, actorName, actorRole, payload = {} }) {
  const db = getDb();
  const { id } = payload;
  const prod = db.prepare('SELECT name FROM products WHERE id = ? AND tenant_id = ?').get(id, tenantId);
  db.prepare('DELETE FROM products WHERE id = ? AND tenant_id = ?').run(id, tenantId);

  recordAuditLog({
    tenantId,
    actorName,
    actorRole,
    moduleName: 'Products',
    actionText: `Deleted product "${prod?.name || id}" from catalog`,
    severity: 'warning'
  });

  return { ok: true };
}

export function recordStockMovement({ tenantId, actorName, actorRole, payload = {} }) {
  const db = getDb();
  const {
    productId,
    movementType = 'STOCK_IN',
    qty = 1,
    unitCost = 0,
    supplierOrReason = 'Regular Supplier Restock',
    warehouseName = 'Main Showroom & Godown'
  } = payload;

  const product = db.prepare('SELECT * FROM products WHERE id = ? AND tenant_id = ?').get(productId, tenantId);
  if (!product) return { ok: false, error: 'Product not found' };

  const numericQty = Number(qty || 0);
  const signedQty = movementType === 'ADJUST_DAMAGE' ? -Math.abs(numericQty) : Math.abs(numericQty);

  db.prepare('UPDATE products SET stock_qty = MAX(0, stock_qty + ?), purchase_price = ? WHERE id = ?')
    .run(signedQty, Number(unitCost || product.purchase_price), product.id);

  const batchCode = generateCode(movementType === 'STOCK_IN' ? 'BATCH' : 'ADJ');
  db.prepare(`
    INSERT INTO stock_batches (tenant_id, batch_code, product_id, product_name, movement_type, qty, unit_cost, supplier_or_reason, warehouse_name, created_date)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    tenantId,
    batchCode,
    product.id,
    product.name,
    movementType,
    signedQty,
    Number(unitCost || product.purchase_price),
    supplierOrReason,
    warehouseName,
    todayISO()
  );

  recordAuditLog({
    tenantId,
    actorName,
    actorRole,
    moduleName: 'Stock Management',
    actionText: `${movementType}: ${signedQty > 0 ? '+' : ''}${signedQty} units of "${product.name}" (${batchCode})`,
    severity: 'success'
  });

  return { ok: true, batchCode };
}

export function deleteStockBatch({ tenantId, actorName, actorRole, payload = {} }) {
  const db = getDb();
  const { id } = payload;
  db.prepare('DELETE FROM stock_batches WHERE id = ? AND tenant_id = ?').run(id, tenantId);

  recordAuditLog({
    tenantId,
    actorName,
    actorRole,
    moduleName: 'Stock Management',
    actionText: `Deleted stock batch record #${id}`,
    severity: 'warning'
  });

  return { ok: true };
}

export function createProductionBatch({ tenantId, actorName, actorRole, payload = {} }) {
  const db = getDb();
  const { finishedProductId, targetQty = 20, rawMaterialsText = '', rawCost = 1000, laborPackagingCost = 200 } = payload;
  const product = db.prepare('SELECT * FROM products WHERE id = ? AND tenant_id = ?').get(finishedProductId, tenantId);
  if (!product) return { ok: false, error: 'Target product not found' };

  const qty = Number(targetQty || 1);
  const totalProdCost = Number(rawCost || 0) + Number(laborPackagingCost || 0);
  const unitCost = Number((totalProdCost / qty).toFixed(2));
  const batchNo = `MFG-2026-${Math.floor(10 + Math.random() * 89)}`;

  db.prepare(`
    INSERT INTO production_orders (tenant_id, batch_no, finished_product_id, finished_product_name, target_qty, raw_materials_text, raw_cost, labor_packaging_cost, unit_production_cost, status, production_date)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'Completed', ?)
  `).run(tenantId, batchNo, product.id, product.name, qty, rawMaterialsText, Number(rawCost), Number(laborPackagingCost), unitCost, todayISO());

  db.prepare('UPDATE products SET stock_qty = stock_qty + ?, purchase_price = ? WHERE id = ?')
    .run(qty, unitCost, product.id);

  db.prepare(`
    INSERT INTO stock_batches (tenant_id, batch_code, product_id, product_name, movement_type, qty, unit_cost, supplier_or_reason, warehouse_name, created_date)
    VALUES (?, ?, ?, ?, 'PRODUCTION_IN', ?, ?, ?, 'In-House Production Unit', ?)
  `).run(tenantId, batchNo, product.id, product.name, qty, unitCost, `Manufactured (${rawMaterialsText})`, todayISO());

  recordAuditLog({
    tenantId,
    actorName,
    actorRole,
    moduleName: 'Production',
    actionText: `Completed batch ${batchNo}: +${qty} units of "${product.name}"`,
    severity: 'success'
  });

  return { ok: true, batchNo };
}

export function deleteProductionBatch({ tenantId, actorName, actorRole, payload = {} }) {
  const db = getDb();
  const { id } = payload;
  db.prepare('DELETE FROM production_orders WHERE id = ? AND tenant_id = ?').run(id, tenantId);

  recordAuditLog({
    tenantId,
    actorName,
    actorRole,
    moduleName: 'Production',
    actionText: `Deleted production batch record #${id}`,
    severity: 'warning'
  });

  return { ok: true };
}

