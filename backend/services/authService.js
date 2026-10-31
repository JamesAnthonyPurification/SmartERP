// ============================================================================
// FILE: src/backend/services/authService.js
// PURPOSE: Authentication, Multi-Tenant Login & Role Registration Service
// ============================================================================

import { getDb } from '../../database/dbConnection.js';
import { recordAuditLog } from '../utils/auditLogger.js';

export function loginUser({ tenantId, payload = {} }) {
  const db = getDb();
  const { usernameOrEmail = '', password = '', selectedTenant = 'powercell' } = payload;
  const cleanId = usernameOrEmail.trim().toLowerCase();

  // 1. Check SmartERP SaaS Super Admin login
  if (selectedTenant === 'superadmin' || cleanId === 'superadmin') {
    const superUser = db.prepare(`
      SELECT * FROM users
      WHERE tenant_id = 'superadmin' AND (LOWER(username) = ? OR LOWER(email) = ?)
      LIMIT 1
    `).get(cleanId, cleanId);

    if (!superUser) {
      return { ok: false, error: 'Super Admin account not found. Use username: superadmin' };
    }
    if (superUser.password && superUser.password !== password) {
      return { ok: false, error: 'Invalid Super Admin password. Default password is: 123456' };
    }

    recordAuditLog({
      tenantId: 'powercell',
      actorName: superUser.name,
      actorRole: superUser.role,
      moduleName: 'Authentication',
      actionText: `${superUser.name} logged into SmartERP SaaS Super Admin Portal`,
      severity: 'info'
    });

    return { ok: true, user: superUser, tenantId: 'powercell', isSuperAdmin: true };
  }

  // 2. Check Tenant-Specific Role Login
  const user = db.prepare(`
    SELECT * FROM users
    WHERE tenant_id = ?
      AND (LOWER(username) = ? OR LOWER(email) = ?)
    LIMIT 1
  `).get(selectedTenant, cleanId, cleanId);

  if (!user) {
    return { ok: false, error: 'User not found for this SME workspace. Check username or role.' };
  }
  if (user.password && user.password !== password && user.pin !== password) {
    return { ok: false, error: 'Invalid password. Default demo password is: 123456' };
  }

  recordAuditLog({
    tenantId: selectedTenant,
    actorName: user.name,
    actorRole: user.role,
    moduleName: 'Authentication',
    actionText: `${user.name} (${user.role}) signed in to ${selectedTenant}`,
    severity: 'info'
  });

  return { ok: true, user, tenantId: selectedTenant, isSuperAdmin: false };
}

export function registerUser({ payload = {} }) {
  const db = getDb();
  const {
    name,
    username,
    email,
    password = '123456',
    phone = '',
    role = 'Owner / Admin',
    selectedTenant = 'powercell'
  } = payload;

  const targetTenant = selectedTenant === 'superadmin' ? 'powercell' : selectedTenant;

  const perms =
    role.includes('Owner') || role.includes('Admin')
      ? 'ALL'
      : role.includes('Cashier') || role.includes('POS')
        ? 'POS,CUSTOMERS,DUE,RETURNS,SALES_HISTORY'
        : role.includes('Store') || role.includes('Inventory') || role.includes('Godown')
          ? 'PRODUCTS,STOCK_IN,STOCK_ADJUST,WAREHOUSE,PRODUCTION'
          : 'FINANCE,BANK,ACCOUNTS,EMPLOYEES,ATTENDANCE,PAYROLL,REPORTS';

  const info = db.prepare(`
    INSERT INTO users (tenant_id, name, username, email, password, role, phone, pin, avatar_color, permissions)
    VALUES (?, ?, ?, ?, ?, ?, ?, '1234', '#0f7a43', ?)
  `).run(
    targetTenant,
    name,
    username.trim().toLowerCase(),
    email || `${username}@smarterp.com`,
    password,
    role,
    phone,
    perms
  );

  const createdUser = db.prepare('SELECT * FROM users WHERE id = ?').get(info.lastInsertRowid);

  recordAuditLog({
    tenantId: targetTenant,
    actorName: name,
    actorRole: role,
    moduleName: 'Authentication',
    actionText: `Registered new user account "${name}" (${role})`,
    severity: 'success'
  });

  return { ok: true, user: createdUser, tenantId: targetTenant, isSuperAdmin: false };
}

export function updateTenantConfiguration({ tenantId, actorName, actorRole, payload = {} }) {
  const db = getDb();
  const { name, subtitle, ownerName, phone, address, vatRate, monthlyRent } = payload;

  db.prepare(`
    UPDATE tenants
    SET name = COALESCE(?, name),
        subtitle = COALESCE(?, subtitle),
        owner_name = COALESCE(?, owner_name),
        phone = COALESCE(?, phone),
        address = COALESCE(?, address),
        vat_rate = COALESCE(?, vat_rate),
        monthly_rent = COALESCE(?, monthly_rent)
    WHERE id = ?
  `).run(name, subtitle, ownerName, phone, address, Number(vatRate ?? 0), Number(monthlyRent ?? 18000), tenantId);

  recordAuditLog({
    tenantId,
    actorName,
    actorRole,
    moduleName: 'Configuration',
    actionText: `Updated SME profile settings for ${name || tenantId}`,
    severity: 'info'
  });

  return { ok: true };
}

