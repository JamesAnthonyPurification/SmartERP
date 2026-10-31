// ============================================================================
// FILE: src/backend/tools/dbTool.js
// PURPOSE: Node.js Backend CLI Utility for Database Inspection, Backup & Reset
// USAGE:
//   npm.cmd run db:status   -> Inspects SQLite tables & record counts per SME tenant
//   npm.cmd run db:backup   -> Exports full JSON snapshot to data/backups/
//   npm.cmd run db:reset    -> Drops & re-seeds clean October 2026 SME dataset
// ============================================================================

import fs from 'node:fs';
import path from 'node:path';
import { getDb } from '../../database/dbConnection.js';
import { CREATE_TABLES_SQL } from '../../database/schema.js';
import { seedInitialData } from '../../database/seedData.js';

const command = (process.argv[2] || 'status').toLowerCase();

const TABLES = [
  'tenants',
  'users',
  'warehouses',
  'products',
  'customers',
  'sales',
  'due_collections',
  'stock_batches',
  'returns_replacements',
  'finance_accounts',
  'finance_transactions',
  'production_orders',
  'employees',
  'attendance',
  'payroll_records',
  'activity_logs',
  'monthly_revenue'
];

function printBanner(title) {
  console.log('======================================================================');
  console.log(` SMARTERP BACKEND CLI TOOL — ${title}`);
  console.log('======================================================================');
}

function runStatus() {
  const db = getDb();
  printBanner('DATABASE STATUS & TENANT METRICS');

  const tenants = db.prepare('SELECT id, name, category, owner_name FROM tenants').all();
  console.log('\nRegistered SME Tenants:');
  for (const t of tenants) {
    const prodCount = db.prepare('SELECT COUNT(*) as c FROM products WHERE tenant_id = ?').get(t.id).c;
    const saleCount = db.prepare('SELECT COUNT(*) as c FROM sales WHERE tenant_id = ?').get(t.id).c;
    const custCount = db.prepare('SELECT COUNT(*) as c FROM customers WHERE tenant_id = ?').get(t.id).c;
    const empCount = db.prepare('SELECT COUNT(*) as c FROM employees WHERE tenant_id = ?').get(t.id).c;
    console.log(
      `  • [${t.id}] ${t.name} (${t.category}) -> Products: ${prodCount} | Sales: ${saleCount} | Customers: ${custCount} | Staff: ${empCount}`
    );
  }

  console.log('\nSQLite Table Row Counts:');
  for (const table of TABLES) {
    const count = db.prepare(`SELECT COUNT(*) as c FROM ${table}`).get().c;
    console.log(`  - ${table.padEnd(24, ' ')} : ${count} rows`);
  }
  console.log('======================================================================\n');
}

function runBackup() {
  const db = getDb();
  printBanner('DATABASE JSON SNAPSHOT BACKUP');

  const backupDir = path.join(process.cwd(), 'data', 'backups');
  if (!fs.existsSync(backupDir)) {
    fs.mkdirSync(backupDir, { recursive: true });
  }

  const snapshot = {
    exportedAt: new Date().toISOString(),
    application: 'SmartERP Multi-Tenant POS & ERP for SMEs',
    tables: {}
  };

  for (const table of TABLES) {
    snapshot.tables[table] = db.prepare(`SELECT * FROM ${table}`).all();
  }

  const fileName = `smarterp-backup-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
  const fullPath = path.join(backupDir, fileName);
  fs.writeFileSync(fullPath, JSON.stringify(snapshot, null, 2), 'utf8');

  console.log(`Backup saved successfully to: ${fullPath}`);
  console.log('======================================================================\n');
}

function runReset() {
  const db = getDb();
  printBanner('RESET & RE-SEED OCTOBER 2026 SME DATASET');

  db.exec('PRAGMA foreign_keys = OFF;');
  for (const table of [...TABLES].reverse()) {
    db.exec(`DROP TABLE IF EXISTS ${table};`);
  }
  db.exec('PRAGMA foreign_keys = ON;');

  db.exec(CREATE_TABLES_SQL);
  seedInitialData(db);

  console.log('All 17 tables recreated and re-seeded with October 01-31, 2026 SME data.');
  runStatus();
}

if (command === 'status') {
  runStatus();
} else if (command === 'backup') {
  runBackup();
} else if (command === 'reset') {
  runReset();
} else {
  console.log(`Unknown command "${command}". Use: status | backup | reset`);
}

