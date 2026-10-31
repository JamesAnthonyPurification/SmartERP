// ============================================================================
// FILE: src/backend/utils/auditLogger.js
// PURPOSE: System Audit Trail Logger for tracking all SME Staff & Admin actions
// ============================================================================

import { getDb } from '../../database/dbConnection.js';
import { nowFormatted } from './dateHelper.js';

export function recordAuditLog({
  tenantId = 'powercell',
  actorName = 'Admin',
  actorRole = 'Owner / Admin',
  moduleName = 'System',
  actionText = '',
  severity = 'info'
}) {
  const db = getDb();
  db.prepare(`
    INSERT INTO activity_logs (tenant_id, actor_name, actor_role, module, action_text, severity, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(tenantId, actorName, actorRole, moduleName, actionText, severity, nowFormatted());
}

export function getRecentAuditLogs(tenantId = 'powercell', limit = 50) {
  const db = getDb();
  return db
    .prepare('SELECT * FROM activity_logs WHERE tenant_id = ? ORDER BY id DESC LIMIT ?')
    .all(tenantId, limit);
}

