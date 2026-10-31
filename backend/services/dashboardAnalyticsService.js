// ============================================================================
// FILE: src/backend/services/dashboardAnalyticsService.js
// PURPOSE: Real-Time SME Tenant Data Aggregation & Dashboard KPI Calculations
// ============================================================================

import { getDb } from '../../database/dbConnection.js';
import { todayISO } from '../utils/dateHelper.js';

export function fetchCompleteTenantState(tenantId = 'powercell') {
  const db = getDb();

  const tenants = db.prepare('SELECT * FROM tenants').all();
  const activeTenant = db.prepare('SELECT * FROM tenants WHERE id = ?').get(tenantId) || tenants[0];
  const tid = activeTenant.id;

  const users = db.prepare('SELECT * FROM users WHERE tenant_id = ?').all(tid);
  const warehouses = db.prepare('SELECT * FROM warehouses WHERE tenant_id = ?').all(tid);
  const products = db.prepare('SELECT * FROM products WHERE tenant_id = ? ORDER BY id ASC').all(tid);
  const customers = db.prepare('SELECT * FROM customers WHERE tenant_id = ? ORDER BY current_due DESC').all(tid);
  const sales = db.prepare('SELECT * FROM sales WHERE tenant_id = ? ORDER BY id DESC').all(tid);
  const dueCollections = db.prepare('SELECT * FROM due_collections WHERE tenant_id = ? ORDER BY id DESC').all(tid);
  const stockBatches = db.prepare('SELECT * FROM stock_batches WHERE tenant_id = ? ORDER BY id DESC').all(tid);
  const returnsReplacements = db.prepare('SELECT * FROM returns_replacements WHERE tenant_id = ? ORDER BY id DESC').all(tid);
  const financeAccounts = db.prepare('SELECT * FROM finance_accounts WHERE tenant_id = ? ORDER BY id ASC').all(tid);
  const financeTransactions = db.prepare('SELECT * FROM finance_transactions WHERE tenant_id = ? ORDER BY id DESC').all(tid);
  const productionOrders = db.prepare('SELECT * FROM production_orders WHERE tenant_id = ? ORDER BY id DESC').all(tid);
  const employees = db.prepare('SELECT * FROM employees WHERE tenant_id = ? ORDER BY id ASC').all(tid);
  const attendance = db.prepare('SELECT * FROM attendance WHERE tenant_id = ? ORDER BY id DESC').all(tid);
  const payrollRecords = db.prepare('SELECT * FROM payroll_records WHERE tenant_id = ? ORDER BY id DESC').all(tid);
  const activityLogs = db.prepare('SELECT * FROM activity_logs WHERE tenant_id = ? ORDER BY id DESC LIMIT 50').all(tid);
  const monthlyRevenue = db.prepare('SELECT * FROM monthly_revenue WHERE tenant_id = ? ORDER BY month_key ASC').all(tid);

  const today = todayISO();
  const todaySalesRows = sales.filter((s) => s.sale_date === today);
  const todaySalesTotal = todaySalesRows.reduce((sum, s) => sum + Number(s.total_amount || 0), 0);
  const todayProfitTotal = todaySalesRows.reduce((sum, s) => sum + Number(s.profit_amount || 0), 0);
  const todayCostTotal = todaySalesTotal - todayProfitTotal;

  const currentMonthPrefix = today.slice(0, 7);
  const monthSalesRows = sales.filter((s) => (s.sale_date || '').startsWith(currentMonthPrefix));
  const monthSalesTotal = monthSalesRows.reduce((sum, s) => sum + Number(s.total_amount || 0), 0);
  const monthVatTotal = monthSalesRows.reduce((sum, s) => sum + Number(s.vat_amount || 0), 0);
  const monthProfitTotal = monthSalesRows.reduce((sum, s) => sum + Number(s.profit_amount || 0), 0);
  const monthCostTotal = monthSalesTotal - monthProfitTotal;

  const yearSalesTotal = sales.reduce((sum, s) => sum + Number(s.total_amount || 0), 0);
  const yearProfitTotal = sales.reduce((sum, s) => sum + Number(s.profit_amount || 0), 0);
  const yearCostTotal = yearSalesTotal - yearProfitTotal;

  const activeProducts = products.filter((p) => p.stock_qty > 0);
  const outOfStockProducts = products.filter((p) => p.stock_qty <= 0);
  const lowStockProducts = products.filter((p) => p.stock_qty > 0 && p.stock_qty <= p.alert_qty);
  const totalUnitsInStock = products.reduce((sum, p) => sum + Number(p.stock_qty || 0), 0);
  const totalStockValue = products.reduce(
    (sum, p) => sum + Number(p.stock_qty || 0) * Number(p.purchase_price || 0),
    0
  );

  const totalCustomerDue = customers.reduce((sum, c) => sum + Number(c.current_due || 0), 0);
  const totalCashAndBank = financeAccounts.reduce((sum, a) => sum + Number(a.balance || 0), 0);
  const profitMarginPct = yearSalesTotal > 0 ? ((yearProfitTotal / yearSalesTotal) * 100).toFixed(1) : '0.0';

  return {
    tenants,
    activeTenant,
    users,
    warehouses,
    products,
    customers,
    sales,
    dueCollections,
    stockBatches,
    returnsReplacements,
    financeAccounts,
    financeTransactions,
    productionOrders,
    employees,
    attendance,
    payrollRecords,
    activityLogs,
    monthlyRevenue,
    summary: {
      todaySalesTotal,
      todayInvoicesCount: todaySalesRows.length,
      todayProfitTotal,
      todayCostTotal,
      weekSalesTotal: todaySalesTotal,
      monthSalesTotal,
      monthVatTotal,
      monthProfitTotal,
      monthCostTotal,
      yearSalesTotal,
      yearInvoicesCount: sales.length,
      yearProfitTotal,
      yearCostTotal,
      activeProductsCount: activeProducts.length,
      totalProductsCount: products.length,
      totalUnitsInStock,
      totalStockValue,
      outOfStockCount: outOfStockProducts.length,
      lowStockCount: lowStockProducts.length,
      profitMarginPct,
      totalCustomerDue,
      totalCashAndBank
    }
  };
}

