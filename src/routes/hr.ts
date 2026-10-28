import type { FastifyInstance } from 'fastify';
import { tenantRoutes } from '../auth/context';
import type { Db } from '../db/pool';
import { badRequest, conflict, notFound } from '../lib/errors';
import { round2 } from '../lib/money';
import { likePattern, parse, z, zBool, zDate, zId, zMoney, zMonth, zOpt, zOptId, zPaging } from '../lib/validate';
import { logActivity, nextNumber } from '../services/common';
import { assertMoneyAccount, postJournal, systemAccounts } from '../services/ledger';

const employeeSchema = z.object({
  code: zOpt(30),
  name: z.string().trim().min(2).max(160),
  phone: zOpt(40),
  email: zOpt(160),
  designation: zOpt(80),
  department: zOpt(80),
  joinDate: zDate.optional().nullable(),
  baseSalary: zMoney.default(0),
  warehouseId: zOptId,
  address: zOpt(400),
  isActive: zBool.default(true),
});

const zTime = z
  .union([z.string().regex(/^\d{2}:\d{2}(:\d{2})?$/), z.literal(''), z.null()])
  .optional()
  .transform((v) => v || null);

async function getRun(db: Db, id: string) {
  const run = await db.maybe(
    `SELECT r.*, a.name AS account_name, u.name AS user_name FROM payroll_runs r
     LEFT JOIN accounts a ON a.id = r.account_id LEFT JOIN users u ON u.id = r.user_id WHERE r.id = $1`,
    [id],
  );
  if (!run) throw notFound('Payroll run');
  const items = await db.many(
    `SELECT i.*, e.code, e.name, e.designation FROM payroll_items i JOIN employees e ON e.id = i.employee_id
     WHERE i.run_id = $1 ORDER BY e.name`,
    [id],
  );
  return { ...run, items };
}

export default async function hrRoutes(app: FastifyInstance) {
  const r = tenantRoutes(app);

  // ---- Employees ------------------------------------------------------
  r.get('/api/employees', ['hr.view', 'attendance.manage', 'payroll.manage'], async ({ db, query }) => {
    const q = parse(zPaging.extend({ status: z.enum(['active', 'all']).default('active') }), query);
    const rows = await db.many(
      `SELECT e.*, w.name AS warehouse_name, count(*) OVER () AS total_count
       FROM employees e LEFT JOIN warehouses w ON w.id = e.warehouse_id
       WHERE ($1::text IS NULL OR e.name ILIKE $1 OR e.code ILIKE $1 OR e.phone ILIKE $1 OR e.designation ILIKE $1)
         AND ($2 = 'all' OR e.is_active)
       ORDER BY e.name LIMIT $3 OFFSET $4`,
      [likePattern(q.q), q.status, q.pageSize, (q.page - 1) * q.pageSize],
    );
    return { rows, total: rows[0]?.total_count ?? 0 };
  });

  r.post('/api/employees', 'hr.manage', async ({ db, ctx, body, reply }) => {
    const b = parse(employeeSchema, body);
    const code = b.code ?? (await nextNumber(db, 'EMP', 'E', 4));
    const row = await db.one(
      `INSERT INTO employees (code, name, phone, email, designation, department, join_date, base_salary, warehouse_id, address, is_active)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING *`,
      [code, b.name, b.phone, b.email, b.designation, b.department, b.joinDate ?? null, b.baseSalary, b.warehouseId, b.address, b.isActive],
    );
    await logActivity(db, ctx, 'employee.create', `Employee ${b.name} added`, { entity: 'employee', entityId: row.id });
    reply.code(201);
    return row;
  });

  r.patch('/api/employees/:id', 'hr.manage', async ({ db, ctx, body, params }) => {
    const { id } = parse(z.object({ id: zId }), params);
    const b = parse(employeeSchema.extend({ code: z.string().trim().min(1).max(30) }), body);
    const row = await db.maybe(
      `UPDATE employees SET code = $2, name = $3, phone = $4, email = $5, designation = $6, department = $7, join_date = $8,
         base_salary = $9, warehouse_id = $10, address = $11, is_active = $12 WHERE id = $1 RETURNING *`,
      [id, b.code, b.name, b.phone, b.email, b.designation, b.department, b.joinDate ?? null, b.baseSalary, b.warehouseId, b.address, b.isActive],
    );
    if (!row) throw notFound('Employee');
    await logActivity(db, ctx, 'employee.update', `Employee ${b.name} updated`, { entity: 'employee', entityId: id });
    return row;
  });

  // ---- Attendance -----------------------------------------------------
  r.get('/api/attendance', ['attendance.manage', 'hr.view'], async ({ db, query }) => {
    const q = parse(z.object({ date: zDate.optional() }), query);
    const { date } = await db.one(`SELECT COALESCE($1::date, app_tenant_today())::text AS date`, [q.date ?? null]);
    const rows = await db.many(
      `SELECT e.id AS employee_id, e.code, e.name, e.designation, a.status, a.check_in, a.check_out, a.note
       FROM employees e LEFT JOIN attendance a ON a.employee_id = e.id AND a.work_date = $1
       WHERE e.is_active ORDER BY e.name`,
      [date],
    );
    return { date, rows };
  });

  r.put('/api/attendance', 'attendance.manage', async ({ db, ctx, body }) => {
    const b = parse(
      z.object({
        date: zDate,
        records: z
          .array(
            z.object({
              employeeId: zId,
              status: z.enum(['present', 'absent', 'late', 'half_day', 'leave', 'holiday']),
              checkIn: zTime,
              checkOut: zTime,
              note: zOpt(200),
            }),
          )
          .min(1)
          .max(1000),
      }),
      body,
    );
    const ids = [...new Set(b.records.map((x) => x.employeeId))];
    const { n } = await db.one(`SELECT count(*) AS n FROM employees WHERE id = ANY($1::uuid[])`, [ids]);
    if (n !== ids.length) throw badRequest('One or more employees were not found');
    for (const rec of b.records) {
      await db.exec(
        `INSERT INTO attendance (employee_id, work_date, status, check_in, check_out, note, updated_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (tenant_id, employee_id, work_date) DO UPDATE SET status = EXCLUDED.status,
           check_in = EXCLUDED.check_in, check_out = EXCLUDED.check_out, note = EXCLUDED.note,
           updated_by = EXCLUDED.updated_by, updated_at = now()`,
        [rec.employeeId, b.date, rec.status, rec.checkIn, rec.checkOut, rec.note, ctx.userId],
      );
    }
    await logActivity(db, ctx, 'attendance.mark', `Attendance saved for ${b.date} (${b.records.length} employees)`, {
      entity: 'attendance',
    });
    return { ok: true, saved: b.records.length };
  });

  r.get('/api/attendance/summary', ['attendance.manage', 'hr.view', 'payroll.manage'], async ({ db, query }) => {
    const { month } = parse(z.object({ month: zMonth }), query);
    return db.many(
      `SELECT e.id AS employee_id, e.code, e.name,
              count(*) FILTER (WHERE a.status = 'present') AS present,
              count(*) FILTER (WHERE a.status = 'late') AS late,
              count(*) FILTER (WHERE a.status = 'half_day') AS half_day,
              count(*) FILTER (WHERE a.status = 'absent') AS absent,
              count(*) FILTER (WHERE a.status = 'leave') AS leave,
              count(*) FILTER (WHERE a.status = 'holiday') AS holiday
       FROM employees e
       LEFT JOIN attendance a ON a.employee_id = e.id AND to_char(a.work_date, 'YYYY-MM') = $1
       WHERE e.is_active GROUP BY e.id ORDER BY e.name`,
      [month],
    );
  });

  // ---- Payroll --------------------------------------------------------
  r.get('/api/payroll/runs', 'payroll.manage', ({ db }) =>
    db.many(
      `SELECT r.id, r.period, r.status, r.total, r.paid_date, r.created_at, a.name AS account_name,
              (SELECT count(*) FROM payroll_items i WHERE i.run_id = r.id) AS employees
       FROM payroll_runs r LEFT JOIN accounts a ON a.id = r.account_id ORDER BY r.period DESC`,
    ),
  );

  r.get('/api/payroll/runs/:id', 'payroll.manage', async ({ db, params }) => {
    const { id } = parse(z.object({ id: zId }), params);
    return getRun(db, id);
  });

  r.post('/api/payroll/runs', 'payroll.manage', async ({ db, ctx, body, reply }) => {
    const b = parse(z.object({ period: zMonth, deductAbsences: zBool.default(true) }), body);
    const run = await db.one<{ id: string }>(
      `INSERT INTO payroll_runs (period, user_id) VALUES ($1, $2) RETURNING id`,
      [b.period, ctx.userId],
    );
    const employees = await db.many(
      `WITH m AS (SELECT to_date($1 || '-01', 'YYYY-MM-DD') AS start)
       SELECT e.id, e.base_salary,
              extract(day FROM (m.start + interval '1 month - 1 day'))::int AS days,
              COALESCE(sum(CASE a.status WHEN 'absent' THEN 1 WHEN 'half_day' THEN 0.5 ELSE 0 END), 0) AS absent_days
       FROM employees e CROSS JOIN m
       LEFT JOIN attendance a ON a.employee_id = e.id AND to_char(a.work_date, 'YYYY-MM') = $1
       WHERE e.is_active AND (e.join_date IS NULL OR e.join_date <= m.start + interval '1 month - 1 day')
       GROUP BY e.id, m.start`,
      [b.period],
    );
    if (!employees.length) throw badRequest('There are no active employees to pay');
    let total = 0;
    for (const e of employees) {
      const deduction = b.deductAbsences ? Math.min(e.base_salary, round2((e.base_salary / e.days) * e.absent_days)) : 0;
      const net = round2(e.base_salary - deduction);
      total += net;
      await db.exec(
        `INSERT INTO payroll_items (run_id, employee_id, base_salary, days_in_month, absent_days, deduction, net_pay)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [run.id, e.id, e.base_salary, e.days, e.absent_days, deduction, net],
      );
    }
    await db.exec(`UPDATE payroll_runs SET total = $2 WHERE id = $1`, [run.id, round2(total)]);
    await logActivity(db, ctx, 'payroll.create', `Payroll draft for ${b.period}`, { entity: 'payroll_run', entityId: run.id });
    reply.code(201);
    return getRun(db, run.id);
  });

  r.patch('/api/payroll/runs/:id/items/:employeeId', 'payroll.manage', async ({ db, ctx, params, body }) => {
    const p = parse(z.object({ id: zId, employeeId: zId }), params);
    const b = parse(z.object({ bonus: zMoney.default(0), deduction: zMoney.default(0) }), body);
    const run = await db.maybe(`SELECT status FROM payroll_runs WHERE id = $1 FOR UPDATE`, [p.id]);
    if (!run) throw notFound('Payroll run');
    if (run.status !== 'draft') throw conflict('This payroll has already been paid');
    const item = await db.maybe(`SELECT base_salary FROM payroll_items WHERE run_id = $1 AND employee_id = $2`, [p.id, p.employeeId]);
    if (!item) throw notFound('Payroll line');
    const net = round2(item.base_salary - b.deduction + b.bonus);
    if (net < 0) throw badRequest('Net pay cannot be negative');
    await db.exec(
      `UPDATE payroll_items SET bonus = $3, deduction = $4, net_pay = $5 WHERE run_id = $1 AND employee_id = $2`,
      [p.id, p.employeeId, b.bonus, b.deduction, net],
    );
    await db.exec(
      `UPDATE payroll_runs SET total = (SELECT COALESCE(sum(net_pay), 0) FROM payroll_items WHERE run_id = $1) WHERE id = $1`,
      [p.id],
    );
    await logActivity(db, ctx, 'payroll.adjust', 'Payroll line adjusted', { entity: 'payroll_run', entityId: p.id, details: b });
    return getRun(db, p.id);
  });

  r.post('/api/payroll/runs/:id/pay', 'payroll.manage', async ({ db, ctx, params, body }) => {
    const { id } = parse(z.object({ id: zId }), params);
    const b = parse(z.object({ accountId: zId, date: zDate.optional().nullable() }), body);
    const run = await db.maybe(`SELECT * FROM payroll_runs WHERE id = $1 FOR UPDATE`, [id]);
    if (!run) throw notFound('Payroll run');
    if (run.status !== 'draft') throw conflict('This payroll has already been paid');
    if (run.total <= 0) throw badRequest('Nothing to pay');
    await assertMoneyAccount(db, b.accountId);
    const acc = await systemAccounts(db);
    const journalId = await postJournal(db, ctx, {
      date: b.date ?? null,
      memo: `Payroll ${run.period}`,
      refType: 'payroll',
      refId: id,
      lines: [{ accountId: acc.SALARY, debit: run.total }, { accountId: b.accountId, credit: run.total }],
    });
    await db.exec(
      `UPDATE payroll_runs SET status = 'paid', account_id = $2, paid_date = COALESCE($3::date, app_tenant_today()),
         journal_entry_id = $4 WHERE id = $1`,
      [id, b.accountId, b.date ?? null, journalId],
    );
    await logActivity(db, ctx, 'payroll.pay', `Payroll ${run.period} paid: ${run.total}`, { entity: 'payroll_run', entityId: id });
    return getRun(db, id);
  });

  r.del('/api/payroll/runs/:id', 'payroll.manage', async ({ db, ctx, params }) => {
    const { id } = parse(z.object({ id: zId }), params);
    const run = await db.maybe(`SELECT period, status FROM payroll_runs WHERE id = $1`, [id]);
    if (!run) throw notFound('Payroll run');
    if (run.status !== 'draft') throw conflict('Paid payroll cannot be deleted');
    await db.exec(`DELETE FROM payroll_runs WHERE id = $1`, [id]);
    await logActivity(db, ctx, 'payroll.delete', `Payroll draft ${run.period} deleted`, { entity: 'payroll_run', entityId: id });
    return { ok: true };
  });
}
