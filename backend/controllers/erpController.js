// ============================================================================
// FILE: src/backend/controllers/erpController.js
// PURPOSE: Central Backend Controller & Action Router for SmartERP
// Orchestrates Request Validation, Role Access Guard & Modular Domain Services
// ============================================================================

import { verifyRolePermission } from '../middleware/authGuard.js';
import { validateActionPayload } from '../validators/requestValidator.js';
import { fetchCompleteTenantState } from '../services/dashboardAnalyticsService.js';
import { loginUser, registerUser, updateTenantConfiguration } from '../services/authService.js';
import {
  addProduct,
  updateProduct,
  deleteProduct,
  recordStockMovement,
  deleteStockBatch,
  createProductionBatch,
  deleteProductionBatch
} from '../services/inventoryService.js';
import {
  createPosSale,
  deleteSale,
  createReturnOrReplacement,
  deleteReturnRecord
} from '../services/salesAndPosService.js';
import {
  addCustomer,
  updateCustomer,
  deleteCustomer,
  collectCustomerDue,
  deleteDueCollection
} from '../services/customerKhataService.js';
import { addFinanceTransaction, deleteFinanceTransaction } from '../services/financeService.js';
import {
  addEmployee,
  updateEmployee,
  deleteEmployee,
  markEmployeeAttendance,
  disburseEmployeeSalary
} from '../services/hrPayrollService.js';

// ----------------------------------------------------------------------------
// 1. FETCH ALL ERP DATA & LIVE DASHBOARD SUMMARY FOR A TENANT
// ----------------------------------------------------------------------------
export function getTenantErpData(tenantId = 'powercell') {
  return fetchCompleteTenantState(tenantId);
}

// ----------------------------------------------------------------------------
// 2. ROUTE & EXECUTE ALL MUTATIONS (AUTH, CREATE, UPDATE/EDIT, DELETE)
// ----------------------------------------------------------------------------
const ACTION_HANDLERS = {
  // Authentication & Tenant Config
  AUTH_LOGIN: loginUser,
  AUTH_REGISTER: registerUser,
  UPDATE_TENANT_CONFIG: updateTenantConfiguration,

  // Inventory, Stock Batches & Light Production BOM
  ADD_PRODUCT: addProduct,
  UPDATE_PRODUCT: updateProduct,
  DELETE_PRODUCT: deleteProduct,
  STOCK_MOVEMENT: recordStockMovement,
  DELETE_STOCK_BATCH: deleteStockBatch,
  CREATE_PRODUCTION: createProductionBatch,
  DELETE_PRODUCTION: deleteProductionBatch,

  // Retail & Wholesale POS Billing, Returns & Warranty Replacements
  CREATE_SALE: createPosSale,
  DELETE_SALE: deleteSale,
  CREATE_RETURN_OR_REPLACEMENT: createReturnOrReplacement,
  DELETE_RETURN: deleteReturnRecord,

  // Customer Baki / Khata Credit Ledger & Due Collection
  ADD_CUSTOMER: addCustomer,
  UPDATE_CUSTOMER: updateCustomer,
  DELETE_CUSTOMER: deleteCustomer,
  COLLECT_DUE: collectCustomerDue,
  DELETE_DUE_COLLECTION: deleteDueCollection,

  // SME Finance Cashbook & Bank Deposit
  ADD_FINANCE_TRX: addFinanceTransaction,
  DELETE_FINANCE_TRX: deleteFinanceTransaction,

  // Employees, Attendance & Payroll
  ADD_EMPLOYEE: addEmployee,
  UPDATE_EMPLOYEE: updateEmployee,
  DELETE_EMPLOYEE: deleteEmployee,
  MARK_ATTENDANCE: markEmployeeAttendance,
  PAY_SALARY: disburseEmployeeSalary
};

export function handleErpAction(body = {}) {
  const {
    action,
    tenantId = 'powercell',
    actorName = 'Admin',
    actorRole = 'Owner / Admin',
    payload = {}
  } = body;

  // Step 1: Validate Request Payload
  const validation = validateActionPayload(action, payload);
  if (!validation.valid) {
    return { ok: false, error: validation.error };
  }

  // Step 2: Check Role-Based Access Control (RBAC)
  const access = verifyRolePermission(action, actorRole);
  if (!access.allowed) {
    return { ok: false, error: access.reason };
  }

  // Step 3: Dispatch to Dedicated Domain Service
  const handler = ACTION_HANDLERS[action];
  if (!handler) {
    return { ok: false, error: `Unsupported backend action: ${action}` };
  }

  return handler({
    tenantId,
    actorName,
    actorRole,
    payload
  });
}
