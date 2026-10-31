// ============================================================================
// FILE: src/backend/config/appConfig.js
// PURPOSE: Central Backend Configuration, Role Permissions & SME Constants
// ============================================================================

export const APP_CONFIG = {
  appName: 'SmartERP Multi-Tenant SME System',
  version: '2.4.0',
  defaultTenant: 'powercell',
  activePeriod: {
    start: '2026-10-01',
    end: '2026-10-31',
    defaultDate: '2026-10-31',
    monthLabel: 'October 2026'
  },
  currency: '৳',
  paginationLimit: 50
};

export const ROLE_PERMISSION_MAP = {
  'Super Admin (SmartERP SaaS)': 'ALL',
  'Owner / Admin': 'ALL',
  'Owner/Admin': 'ALL',
  'Cashier / POS': 'POS,CUSTOMERS,DUE,RETURNS,SALES_HISTORY',
  'Cashier/Sales': 'POS,CUSTOMERS,DUE,RETURNS,SALES_HISTORY',
  'Godown / Store': 'PRODUCTS,STOCK_IN,STOCK_ADJUST,WAREHOUSE,PRODUCTION',
  'Inventory/Warehouse': 'PRODUCTS,STOCK_IN,STOCK_ADJUST,WAREHOUSE,PRODUCTION',
  'Accounts / HR': 'FINANCE,BANK,ACCOUNTS,EMPLOYEES,ATTENDANCE,PAYROLL,REPORTS',
  'Accountant/HR': 'FINANCE,BANK,ACCOUNTS,EMPLOYEES,ATTENDANCE,PAYROLL,REPORTS'
};

export const ACTION_PERMISSION_REQUIREMENTS = {
  AUTH_LOGIN: 'PUBLIC',
  AUTH_REGISTER: 'PUBLIC',
  CREATE_SALE: 'POS',
  DELETE_SALE: 'SALES_HISTORY',
  ADD_PRODUCT: 'PRODUCTS',
  UPDATE_PRODUCT: 'PRODUCTS',
  DELETE_PRODUCT: 'PRODUCTS',
  STOCK_MOVEMENT: 'STOCK_IN',
  DELETE_STOCK_BATCH: 'STOCK_IN',
  ADD_CUSTOMER: 'CUSTOMERS',
  UPDATE_CUSTOMER: 'CUSTOMERS',
  DELETE_CUSTOMER: 'CUSTOMERS',
  COLLECT_DUE: 'DUE',
  DELETE_DUE_COLLECTION: 'DUE',
  CREATE_RETURN_OR_REPLACEMENT: 'RETURNS',
  DELETE_RETURN: 'RETURNS',
  ADD_FINANCE_TRX: 'FINANCE',
  DELETE_FINANCE_TRX: 'FINANCE',
  CREATE_PRODUCTION: 'PRODUCTION',
  DELETE_PRODUCTION: 'PRODUCTION',
  ADD_EMPLOYEE: 'EMPLOYEES',
  UPDATE_EMPLOYEE: 'EMPLOYEES',
  DELETE_EMPLOYEE: 'EMPLOYEES',
  MARK_ATTENDANCE: 'ATTENDANCE',
  PAY_SALARY: 'PAYROLL',
  UPDATE_TENANT_CONFIG: 'ALL'
};

