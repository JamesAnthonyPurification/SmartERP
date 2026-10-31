// ============================================================================
// FILE: src/backend/utils/dateHelper.js
// PURPOSE: Date, Timestamp, and Document Code Generators for SmartERP
// ============================================================================

import { APP_CONFIG } from '../config/appConfig.js';

export function nowFormatted() {
  return new Date().toLocaleString('en-US', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: true
  });
}

export function todayISO() {
  const now = new Date().toISOString().slice(0, 10);
  return now.startsWith('2026-10') ? now : APP_CONFIG.activePeriod.defaultDate;
}

export function generateCode(prefix = 'DOC') {
  const randomDigits = Math.floor(1000 + Math.random() * 9000);
  return `${prefix}-${randomDigits}`;
}

export function generateYearlyCode(prefix = 'INV') {
  const year = new Date().getFullYear();
  const randomDigits = Math.floor(1000 + Math.random() * 9000);
  return `${prefix}-${year}-${randomDigits}`;
}

