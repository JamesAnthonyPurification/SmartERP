// ============================================================================
// FILE: src/backend/middleware/authGuard.js
// PURPOSE: Role-Based Access Control (RBAC) & Tenant Isolation Guard
// ============================================================================

import { ROLE_PERMISSION_MAP, ACTION_PERMISSION_REQUIREMENTS } from '../config/appConfig.js';

export function verifyRolePermission(actorRole = 'Owner / Admin', action = '') {
  const requiredPerm = ACTION_PERMISSION_REQUIREMENTS[action];
  if (!requiredPerm || requiredPerm === 'PUBLIC') {
    return { allowed: true };
  }

  const rolePerms = ROLE_PERMISSION_MAP[actorRole] || 'ALL';
  if (rolePerms === 'ALL') {
    return { allowed: true };
  }

  const allowedList = rolePerms.split(',').map((p) => p.trim());
  if (allowedList.includes(requiredPerm)) {
    return { allowed: true };
  }

  return {
    allowed: false,
    reason: `Role "${actorRole}" does not have permission (${requiredPerm}) to execute ${action}.`
  };
}

