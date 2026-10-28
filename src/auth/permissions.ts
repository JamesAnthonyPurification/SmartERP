/**
 * Tenant-scoped permission catalog. A role grants these only inside the
 * tenant that owns the role; platform administration is a separate flag on
 * the user identity and is never granted through a tenant role.
 */
export const PERMISSIONS = {
  'dashboard.view': 'View dashboard',
  'pos.sell': 'Sell at the POS terminal',
  'sales.view': 'View sales history and invoices',
  'sales.void': 'Void completed sales',
  'returns.manage': 'Process returns and replacements',
  'products.view': 'View products and categories',
  'products.manage': 'Create and edit products and categories',
  'inventory.view': 'View stock levels and movements',
  'inventory.receive': 'Receive stock (Stock In / purchases)',
  'inventory.adjust': 'Adjust and transfer stock',
  'production.manage': 'Record production runs',
  'warehouses.manage': 'Manage warehouses and branches',
  'customers.view': 'View customers',
  'customers.manage': 'Create and edit customers',
  'collections.manage': 'Collect customer dues',
  'suppliers.view': 'View suppliers',
  'suppliers.manage': 'Create and edit suppliers',
  'suppliers.pay': 'Pay suppliers',
  'finance.view': 'View accounts, journal and finance entries',
  'finance.manage': 'Record expenses, income, deposits and journals',
  'accounts.manage': 'Manage the chart of accounts',
  'reports.view': 'View and export reports and statements',
  'hr.view': 'View employees',
  'hr.manage': 'Manage employees',
  'attendance.manage': 'Mark attendance',
  'payroll.manage': 'Run and pay payroll',
  'users.manage': 'Manage users and roles',
  'settings.manage': 'Manage business settings',
  'audit.view': 'View activity logs',
} as const;

export type Permission = keyof typeof PERMISSIONS;
export const ALL_PERMISSIONS = Object.keys(PERMISSIONS) as Permission[];

/** '*' means every tenant permission, including ones added in later releases. */
export const WILDCARD = '*';

export function hasPermission(granted: Iterable<string>, needed: Permission): boolean {
  const set = granted instanceof Set ? granted : new Set(granted);
  return set.has(WILDCARD) || set.has(needed);
}

export const SYSTEM_ROLES: { name: string; description: string; permissions: string[] }[] = [
  { name: 'Owner', description: 'Full access to this business', permissions: [WILDCARD] },
  {
    name: 'Manager',
    description: 'Runs daily operations across all modules',
    permissions: ALL_PERMISSIONS.filter((p) => !['users.manage', 'settings.manage', 'accounts.manage'].includes(p)),
  },
  {
    name: 'Cashier',
    description: 'POS sales, customers and due collection',
    permissions: [
      'dashboard.view', 'pos.sell', 'sales.view', 'returns.manage', 'products.view',
      'customers.view', 'customers.manage', 'collections.manage',
    ],
  },
  {
    name: 'Storekeeper',
    description: 'Products, stock in, adjustments, transfers and production',
    permissions: [
      'dashboard.view', 'products.view', 'products.manage', 'inventory.view', 'inventory.receive',
      'inventory.adjust', 'production.manage', 'suppliers.view', 'suppliers.manage',
    ],
  },
  {
    name: 'Accountant',
    description: 'Finance, accounts, statements and reports',
    permissions: [
      'dashboard.view', 'sales.view', 'customers.view', 'collections.manage', 'suppliers.view',
      'suppliers.pay', 'finance.view', 'finance.manage', 'accounts.manage', 'reports.view',
      'inventory.view', 'products.view',
    ],
  },
  {
    name: 'HR Officer',
    description: 'Employees, attendance and payroll',
    permissions: ['dashboard.view', 'hr.view', 'hr.manage', 'attendance.manage', 'payroll.manage'],
  },
];
