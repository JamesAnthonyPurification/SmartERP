// ============================================================================
// FILE: src/backend/services/hrPayrollService.js
// PURPOSE: SME Employees Directory, Daily Attendance & Salary Disbursement
// ============================================================================

import { getDb } from '../../database/dbConnection.js';
import { recordAuditLog } from '../utils/auditLogger.js';
import { todayISO, generateCode } from '../utils/dateHelper.js';

export function addEmployee({ tenantId, actorName, actorRole, payload = {} }) {
  const db = getDb();
  const {
    name,
    designation,
    phone,
    baseSalary = 15000,
    dailyAllowance = 100,
    commissionRate = 1.0
  } = payload;

  const empCode = `EMP-${Math.floor(105 + Math.random() * 890)}`;
  const info = db.prepare(`
    INSERT INTO employees (tenant_id, emp_code, name, designation, phone, base_salary, daily_allowance, commission_rate, advance_taken, joining_date, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, 'Active')
  `).run(
    tenantId,
    empCode,
    name,
    designation,
    phone,
    Number(baseSalary),
    Number(dailyAllowance),
    Number(commissionRate),
    todayISO()
  );

  // Automatically create an October 2026 Payroll row so the Payroll sheet stays in sync
  db.prepare(`
    INSERT INTO payroll_records (tenant_id, employee_id, employee_name, designation, month_label, present_days, base_salary, overtime_bonus, sales_commission, advance_deduction, net_payable, payment_status, paid_date)
    VALUES (?, ?, ?, ?, 'October 2026', 26, ?, 0, 0, 0, ?, 'Pending', null)
  `).run(tenantId, info.lastInsertRowid, name, designation, Number(baseSalary), Number(baseSalary));

  recordAuditLog({
    tenantId,
    actorName,
    actorRole,
    moduleName: 'Employees',
    actionText: `Added staff member ${name} (${designation})`,
    severity: 'success'
  });

  return { ok: true };
}

export function updateEmployee({ tenantId, actorName, actorRole, payload = {} }) {
  const db = getDb();
  const { id, name, designation, phone, baseSalary, advanceTaken } = payload;

  db.prepare(`
    UPDATE employees
    SET name = ?, designation = ?, phone = ?, base_salary = ?, advance_taken = ?
    WHERE id = ? AND tenant_id = ?
  `).run(name, designation, phone, Number(baseSalary || 0), Number(advanceTaken || 0), Number(id), tenantId);

  // Sync corresponding Payroll sheet row for this employee
  db.prepare(`
    UPDATE payroll_records
    SET employee_name = ?,
        designation = ?,
        base_salary = ?,
        advance_deduction = ?,
        net_payable = MAX(0, ? + overtime_bonus + sales_commission - ?)
    WHERE employee_id = ? AND tenant_id = ?
  `).run(
    name,
    designation,
    Number(baseSalary || 0),
    Number(advanceTaken || 0),
    Number(baseSalary || 0),
    Number(advanceTaken || 0),
    Number(id),
    tenantId
  );

  recordAuditLog({
    tenantId,
    actorName,
    actorRole,
    moduleName: 'Employees',
    actionText: `Updated employee ${name} (Salary: ৳${baseSalary}, Advance: ৳${advanceTaken})`,
    severity: 'info'
  });

  return { ok: true };
}

export function deleteEmployee({ tenantId, actorName, actorRole, payload = {} }) {
  const db = getDb();
  const { id } = payload;
  db.prepare('DELETE FROM employees WHERE id = ? AND tenant_id = ?').run(id, tenantId);
  db.prepare('DELETE FROM payroll_records WHERE employee_id = ? AND tenant_id = ?').run(id, tenantId);
  db.prepare('DELETE FROM attendance WHERE employee_id = ? AND tenant_id = ?').run(id, tenantId);

  recordAuditLog({
    tenantId,
    actorName,
    actorRole,
    moduleName: 'Employees',
    actionText: `Removed employee record #${id}`,
    severity: 'warning'
  });

  return { ok: true };
}

export function markEmployeeAttendance({ tenantId, actorName, actorRole, payload = {} }) {
  const db = getDb();
  const { employeeId, status = 'Present', checkIn = '09:00 AM', overtimeHours = 0 } = payload;
  const emp = db.prepare('SELECT * FROM employees WHERE id = ? AND tenant_id = ?').get(employeeId, tenantId);
  if (!emp) return { ok: false, error: 'Employee not found' };

  const attDate = todayISO();
  db.prepare(`
    INSERT INTO attendance (tenant_id, employee_id, employee_name, att_date, status, check_in, overtime_hours)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(tenant_id, employee_id, att_date)
    DO UPDATE SET status = excluded.status, check_in = excluded.check_in, overtime_hours = excluded.overtime_hours
  `).run(tenantId, emp.id, emp.name, attDate, status, checkIn, Number(overtimeHours || 0));

  recordAuditLog({
    tenantId,
    actorName,
    actorRole,
    moduleName: 'Attendance',
    actionText: `Marked ${emp.name} as ${status}`,
    severity: 'info'
  });

  return { ok: true };
}

export function disburseEmployeeSalary({ tenantId, actorName, actorRole, payload = {} }) {
  const db = getDb();
  const { payrollId } = payload;
  const rec = db.prepare('SELECT * FROM payroll_records WHERE id = ? AND tenant_id = ?').get(payrollId, tenantId);

  if (rec && rec.payment_status !== 'Paid') {
    const dateStr = todayISO();
    db.prepare("UPDATE payroll_records SET payment_status = 'Paid', paid_date = ? WHERE id = ?").run(dateStr, rec.id);

    // Deduct from Cash Drawer or Bank and post Expense Voucher in Finance Cashbook
    const acc = db.prepare('SELECT * FROM finance_accounts WHERE tenant_id = ? ORDER BY balance DESC LIMIT 1').get(tenantId);
    if (acc) {
      db.prepare('UPDATE finance_accounts SET balance = MAX(0, balance - ?) WHERE id = ?').run(Number(rec.net_payable), acc.id);
      db.prepare(`
        INSERT INTO finance_transactions (tenant_id, trx_code, trx_type, category, account_name, amount, description, trx_date)
        VALUES (?, ?, 'EXPENSE', 'Staff Salary & Payroll', ?, ?, ?, ?)
      `).run(
        tenantId,
        generateCode('TRX'),
        acc.account_name,
        Number(rec.net_payable),
        `Paid October 2026 Salary to ${rec.employee_name} (${rec.designation})`,
        dateStr
      );
    }

    recordAuditLog({
      tenantId,
      actorName,
      actorRole,
      moduleName: 'Payroll',
      actionText: `Disbursed salary ৳${rec.net_payable} to ${rec.employee_name}`,
      severity: 'success'
    });
  }

  return { ok: true };
}

