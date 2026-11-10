import type { FastifyInstance } from 'fastify';
import { tenantRoutes } from '../auth/context';
import type { Db } from '../db/pool';
import { sendCsv } from '../lib/csv';
import { round2 } from '../lib/money';
import { parse, z, zDate, zOptId, zRange } from '../lib/validate';
import { localDateRange, resolveRange } from '../services/common';

/** Sales and returns as signed events on local dates (returns reduce sales). */
const EVENTS_CTE = `
  ev AS (
    SELECT (s.sale_date AT TIME ZONE app_tenant_tz())::date AS day, s.total AS gross, s.vat_amount AS vat,
           s.subtotal - s.discount AS revenue, s.cost_total AS cost, 1 AS invoices
    FROM sales s WHERE s.status = 'completed'
    UNION ALL
    SELECT (r.return_date AT TIME ZONE app_tenant_tz())::date, -r.amount, -r.vat_amount, -r.amount_ex_vat, -r.cost_amount, 0
    FROM sale_returns r
  )`;

const pct = (current: number, previous: number) =>
  previous > 0 ? round2(((current - previous) / previous) * 100) : null;

async function trialBalance(db: Db, from: string | null, to: string) {
  return db.many<{ id: string; code: string; name: string; type: string; system_key: string | null; debit: number; credit: number }>(
    `SELECT a.id, a.code, a.name, a.type, a.system_key,
            COALESCE(sum(l.debit), 0) AS debit, COALESCE(sum(l.credit), 0) AS credit
     FROM accounts a
     LEFT JOIN journal_lines l ON l.account_id = a.id
       AND l.entry_id IN (SELECT id FROM journal_entries WHERE ($1::date IS NULL OR entry_date >= $1) AND entry_date <= $2)
     GROUP BY a.id ORDER BY a.code`,
    [from, to],
  );
}

export default async function reportRoutes(app: FastifyInstance) {
  const r = tenantRoutes(app);

  // ---- Dashboard ------------------------------------------------------
  r.get('/api/dashboard', 'dashboard.view', async ({ db }) => {
    const p = await db.one(
      `WITH b AS (
         SELECT app_tenant_today() AS today,
                app_tenant_today() - ((extract(dow FROM app_tenant_today())::int + 1) % 7) AS week_start,
                date_trunc('month', app_tenant_today())::date AS month_start,
                date_trunc('year', app_tenant_today())::date AS year_start
       ), ${EVENTS_CTE}
       SELECT b.today::text AS today,
         COALESCE(sum(gross) FILTER (WHERE day = b.today), 0) AS today_sales,
         COALESCE(sum(invoices) FILTER (WHERE day = b.today), 0) AS today_invoices,
         COALESCE(sum(gross) FILTER (WHERE day = b.today - 1), 0) AS prev_today_sales,
         COALESCE(sum(gross) FILTER (WHERE day >= b.week_start), 0) AS week_sales,
         COALESCE(sum(gross) FILTER (WHERE day >= b.week_start - 7 AND day <= b.today - 7), 0) AS prev_week_sales,
         COALESCE(sum(gross) FILTER (WHERE day >= b.month_start), 0) AS month_sales,
         COALESCE(sum(vat) FILTER (WHERE day >= b.month_start), 0) AS month_vat,
         COALESCE(sum(invoices) FILTER (WHERE day >= b.month_start), 0) AS month_invoices,
         COALESCE(sum(gross) FILTER (WHERE day >= (b.month_start - interval '1 month')::date
                                       AND day <= (b.today - interval '1 month')::date), 0) AS prev_month_sales,
         COALESCE(sum(gross) FILTER (WHERE day >= b.year_start), 0) AS year_sales,
         COALESCE(sum(invoices) FILTER (WHERE day >= b.year_start), 0) AS year_invoices,
         COALESCE(sum(gross) FILTER (WHERE day >= (b.year_start - interval '1 year')::date
                                       AND day <= (b.today - interval '1 year')::date), 0) AS prev_year_sales,
         COALESCE(sum(revenue) FILTER (WHERE day = b.today), 0) AS today_revenue,
         COALESCE(sum(cost) FILTER (WHERE day = b.today), 0) AS today_cost,
         COALESCE(sum(revenue) FILTER (WHERE day >= b.month_start), 0) AS month_revenue,
         COALESCE(sum(cost) FILTER (WHERE day >= b.month_start), 0) AS month_cost,
         COALESCE(sum(revenue) FILTER (WHERE day >= b.year_start), 0) AS year_revenue,
         COALESCE(sum(cost) FILTER (WHERE day >= b.year_start), 0) AS year_cost,
         COALESCE(sum(revenue), 0) AS life_revenue,
         COALESCE(sum(cost), 0) AS life_cost
       FROM b LEFT JOIN ev ON true
       GROUP BY b.today, b.week_start, b.month_start, b.year_start`,
    );

    const stock = await db.one(
      `SELECT count(*) FILTER (WHERE p.is_active) AS total_products,
              COALESCE(sum(GREATEST(s.qty, 0)), 0) AS units,
              COALESCE(round(sum(GREATEST(s.qty, 0) * p.avg_cost), 2), 0) AS stock_value,
              count(*) FILTER (WHERE p.is_active AND COALESCE(s.qty, 0) <= 0) AS out_of_stock,
              count(*) FILTER (WHERE p.is_active AND s.qty > 0 AND s.qty <= p.reorder_level) AS low_stock
       FROM products p LEFT JOIN (SELECT product_id, sum(qty) AS qty FROM stock_levels GROUP BY product_id) s
         ON s.product_id = p.id`,
    );

    const months = await db.many<{ month: string; sales: number; profit: number }>(
      `WITH ${EVENTS_CTE}
       SELECT to_char(day, 'YYYY-MM') AS month, sum(gross) AS sales, sum(revenue - cost) AS profit
       FROM ev WHERE day >= (date_trunc('month', app_tenant_today()) - interval '11 months')::date
       GROUP BY 1 ORDER BY 1`,
    );
    const byMonth = new Map(months.map((m) => [m.month, m]));
    const [y, m] = p.today.split('-').map(Number);
    const monthly = Array.from({ length: 12 }, (_, i) => {
      const d = new Date(Date.UTC(y, m - 1 - (11 - i), 1));
      const key = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
      return { month: key, sales: byMonth.get(key)?.sales ?? 0, profit: round2(byMonth.get(key)?.profit ?? 0) };
    });

    const topProducts = await db.many(
      `SELECT p.id, p.name, p.unit, sum(i.qty - i.returned_qty) AS qty, sum(i.line_total - i.returned_amount) AS revenue
       FROM sale_items i JOIN sales s ON s.id = i.sale_id JOIN products p ON p.id = i.product_id
       WHERE s.status = 'completed' AND s.sale_date >= now() - interval '30 days'
       GROUP BY p.id, p.name, p.unit HAVING sum(i.qty - i.returned_qty) > 0
       ORDER BY revenue DESC LIMIT 6`,
    );
    const lowStock = await db.many(
      `SELECT p.id, p.name, p.unit, p.reorder_level, COALESCE(s.qty, 0) AS qty
       FROM products p LEFT JOIN (SELECT product_id, sum(qty) AS qty FROM stock_levels GROUP BY product_id) s ON s.product_id = p.id
       WHERE p.is_active AND COALESCE(s.qty, 0) <= p.reorder_level
       ORDER BY COALESCE(s.qty, 0), p.name LIMIT 8`,
    );
    const recentSales = await db.many(
      `SELECT s.id, s.number, s.sale_date, s.total, s.due_amount, s.status, c.name AS customer_name
       FROM sales s LEFT JOIN customers c ON c.id = s.customer_id ORDER BY s.sale_date DESC LIMIT 6`,
    );
    const balances = await db.one(
      `SELECT (SELECT COALESCE(sum(due_amount), 0) FROM sales WHERE status = 'completed') AS receivable,
              (SELECT COALESCE(sum(due_amount), 0) FROM purchases) AS payable,
              (SELECT COALESCE(sum(amount), 0) FROM finance_entries
                WHERE kind = 'expense' AND entry_date >= date_trunc('month', app_tenant_today())) AS month_expenses`,
    );
    const money = await db.many(
      `SELECT a.id, a.name, a.money_kind, COALESCE(sum(l.debit - l.credit), 0) AS balance
       FROM accounts a LEFT JOIN journal_lines l ON l.account_id = a.id
       WHERE a.is_money AND a.is_active GROUP BY a.id ORDER BY a.code`,
    );

    const profit = (rev: number, cost: number) => ({ sales: round2(rev), cost: round2(cost), profit: round2(rev - cost) });
    return {
      today: p.today,
      sales: {
        today: { total: p.today_sales, invoices: p.today_invoices, change: pct(p.today_sales, p.prev_today_sales) },
        week: { total: p.week_sales, change: pct(p.week_sales, p.prev_week_sales) },
        month: { total: p.month_sales, vat: p.month_vat, invoices: p.month_invoices, change: pct(p.month_sales, p.prev_month_sales) },
        year: { total: p.year_sales, invoices: p.year_invoices, change: pct(p.year_sales, p.prev_year_sales) },
      },
      profit: {
        today: profit(p.today_revenue, p.today_cost),
        month: profit(p.month_revenue, p.month_cost),
        year: profit(p.year_revenue, p.year_cost),
        lifetime: profit(p.life_revenue, p.life_cost),
        margin: p.life_revenue > 0 ? round2(((p.life_revenue - p.life_cost) / p.life_revenue) * 100) : 0,
      },
      stock,
      balances,
      money,
      monthly,
      topProducts,
      lowStock,
      recentSales,
    };
  });

  // ---- Sales report ---------------------------------------------------
  r.get('/api/reports/sales', 'reports.view', async ({ db, query, reply }) => {
    const q = parse(
      zRange.extend({
        groupBy: z.enum(['day', 'month', 'customer', 'cashier', 'warehouse', 'product', 'category']).default('day'),
        warehouseId: zOptId,
      }),
      query,
    );
    const range = await resolveRange(db, q.from, q.to);
    let rows: any[];
    if (q.groupBy === 'product' || q.groupBy === 'category') {
      const key = q.groupBy === 'product' ? `p.name || ' (' || p.sku || ')'` : `COALESCE(c.name, 'Uncategorised')`;
      rows = await db.many(
        `SELECT ${key} AS label, count(DISTINCT s.id) AS invoices, sum(i.qty - i.returned_qty) AS qty,
                round(sum(i.line_total - i.returned_amount), 2) AS net_sales,
                round(sum((i.line_total - i.vat_amount) * (i.qty - i.returned_qty) / i.qty), 2) AS revenue,
                round(sum((i.qty - i.returned_qty) * i.unit_cost), 2) AS cost
         FROM sale_items i
         JOIN sales s ON s.id = i.sale_id
         JOIN products p ON p.id = i.product_id
         LEFT JOIN categories c ON c.id = p.category_id
         WHERE s.status = 'completed' AND ${localDateRange('s.sale_date', 1, 2)}
           AND ($3::uuid IS NULL OR s.warehouse_id = $3)
         GROUP BY 1 ORDER BY net_sales DESC`,
        [range.from, range.to, q.warehouseId],
      );
    } else {
      const keys: Record<string, string> = {
        day: `to_char(s.sale_date AT TIME ZONE app_tenant_tz(), 'YYYY-MM-DD')`,
        month: `to_char(s.sale_date AT TIME ZONE app_tenant_tz(), 'YYYY-MM')`,
        customer: `COALESCE(cu.name, 'Walk-in customer')`,
        cashier: `COALESCE(u.name, '—')`,
        warehouse: `w.name`,
      };
      rows = await db.many(
        `SELECT ${keys[q.groupBy]} AS label, count(*) AS invoices,
                sum(s.subtotal) AS subtotal, sum(s.discount) AS discount, sum(s.vat_amount) AS vat,
                sum(s.total) AS gross_sales, sum(s.returned_amount) AS returns,
                sum(s.total - s.returned_amount) AS net_sales, sum(s.due_amount) AS due,
                round(sum(s.subtotal - s.discount - COALESCE(rt.ex_vat, 0)), 2) AS revenue,
                round(sum(s.cost_total - COALESCE(rt.cost, 0)), 2) AS cost
         FROM sales s
         LEFT JOIN customers cu ON cu.id = s.customer_id
         LEFT JOIN users u ON u.id = s.user_id
         JOIN warehouses w ON w.id = s.warehouse_id
         LEFT JOIN LATERAL (SELECT sum(amount_ex_vat) AS ex_vat, sum(cost_amount) AS cost FROM sale_returns WHERE sale_id = s.id) rt ON true
         WHERE s.status = 'completed' AND ${localDateRange('s.sale_date', 1, 2)}
           AND ($3::uuid IS NULL OR s.warehouse_id = $3)
         GROUP BY 1 ORDER BY 1`,
        [range.from, range.to, q.warehouseId],
      );
    }
    rows = rows.map((row) => ({ ...row, profit: round2(row.revenue - row.cost) }));
    const totals = rows.reduce(
      (t, row) => ({
        invoices: t.invoices + Number(row.invoices),
        net_sales: round2(t.net_sales + row.net_sales),
        revenue: round2(t.revenue + row.revenue),
        cost: round2(t.cost + row.cost),
        profit: round2(t.profit + row.profit),
      }),
      { invoices: 0, net_sales: 0, revenue: 0, cost: 0, profit: 0 },
    );
    if (q.format === 'csv') {
      return sendCsv(reply, `sales-${q.groupBy}-${range.from}-${range.to}.csv`, [
        { key: 'label', label: q.groupBy },
        { key: 'invoices', label: 'Invoices' },
        ...(rows[0]?.qty !== undefined ? [{ key: 'qty', label: 'Qty' }] : []),
        { key: 'net_sales', label: 'Net sales (incl. VAT)' },
        { key: 'revenue', label: 'Revenue (ex. VAT)' },
        { key: 'cost', label: 'Cost' },
        { key: 'profit', label: 'Gross profit' },
      ], rows);
    }
    return { ...range, groupBy: q.groupBy, rows, totals };
  });

  // ---- Profit & loss (from the general ledger) ------------------------
  r.get('/api/reports/profit-loss', ['reports.view', 'finance.view'], async ({ db, query, reply }) => {
    const q = parse(zRange, query);
    const range = await resolveRange(db, q.from, q.to);
    const tb = await trialBalance(db, range.from, range.to);
    const income = tb
      .filter((a) => a.type === 'income' && (a.debit || a.credit))
      .map((a) => ({ code: a.code, name: a.name, system_key: a.system_key, amount: round2(a.credit - a.debit) }));
    const expenses = tb
      .filter((a) => a.type === 'expense' && (a.debit || a.credit))
      .map((a) => ({ code: a.code, name: a.name, system_key: a.system_key, amount: round2(a.debit - a.credit) }));
    const totalIncome = round2(income.reduce((s, a) => s + a.amount, 0));
    const totalExpenses = round2(expenses.reduce((s, a) => s + a.amount, 0));
    const salesNet = round2(income.filter((a) => ['SALES', 'SALES_RETURNS'].includes(a.system_key ?? '')).reduce((s, a) => s + a.amount, 0));
    const cogs = round2(expenses.filter((a) => a.system_key === 'COGS').reduce((s, a) => s + a.amount, 0));
    const result = {
      ...range,
      income,
      expenses,
      totalIncome,
      totalExpenses,
      netSales: salesNet,
      cogs,
      grossProfit: round2(salesNet - cogs),
      netProfit: round2(totalIncome - totalExpenses),
    };
    if (q.format === 'csv') {
      const rows = [
        ...income.map((a) => ({ section: 'Income', ...a })),
        ...expenses.map((a) => ({ section: 'Expense', ...a })),
        { section: 'Net profit', code: '', name: '', amount: result.netProfit },
      ];
      return sendCsv(reply, `profit-loss-${range.from}-${range.to}.csv`, [
        { key: 'section', label: 'Section' }, { key: 'code', label: 'Code' }, { key: 'name', label: 'Account' }, { key: 'amount', label: 'Amount' },
      ], rows);
    }
    return result;
  });

  // ---- Balance sheet & trial balance ----------------------------------
  r.get('/api/reports/balance-sheet', ['reports.view', 'finance.view'], async ({ db, query }) => {
    const q = parse(z.object({ asOf: zDate.optional() }), query);
    const { asOf } = await db.one(`SELECT COALESCE($1::date, app_tenant_today())::text AS "asOf"`, [q.asOf ?? null]);
    const tb = await trialBalance(db, null, asOf);
    const section = (type: string, debitNormal: boolean) =>
      tb
        .filter((a) => a.type === type && (a.debit || a.credit))
        .map((a) => ({ code: a.code, name: a.name, amount: round2(debitNormal ? a.debit - a.credit : a.credit - a.debit) }));
    const assets = section('asset', true);
    const liabilities = section('liability', false);
    const equity = section('equity', false);
    const earnings = round2(
      tb.filter((a) => a.type === 'income').reduce((s, a) => s + a.credit - a.debit, 0) -
        tb.filter((a) => a.type === 'expense').reduce((s, a) => s + a.debit - a.credit, 0),
    );
    equity.push({ code: '', name: 'Retained earnings (current)', amount: earnings });
    const total = (rows: { amount: number }[]) => round2(rows.reduce((s, a) => s + a.amount, 0));
    return {
      asOf,
      assets,
      liabilities,
      equity,
      totalAssets: total(assets),
      totalLiabilities: total(liabilities),
      totalEquity: total(equity),
      balanced: total(assets) === round2(total(liabilities) + total(equity)),
    };
  });

  r.get('/api/reports/trial-balance', ['reports.view', 'finance.view'], async ({ db, query, reply }) => {
    const q = parse(zRange.extend({ asOf: zDate.optional() }), query);
    const { asOf } = await db.one(`SELECT COALESCE($1::date, app_tenant_today())::text AS "asOf"`, [q.asOf ?? null]);
    const rows = (await trialBalance(db, null, asOf))
      .filter((a) => a.debit || a.credit)
      .map((a) => {
        const net = round2(a.debit - a.credit);
        return { code: a.code, name: a.name, type: a.type, debit: net > 0 ? net : 0, credit: net < 0 ? -net : 0 };
      });
    const totals = {
      debit: round2(rows.reduce((s, a) => s + a.debit, 0)),
      credit: round2(rows.reduce((s, a) => s + a.credit, 0)),
    };
    if (q.format === 'csv') {
      return sendCsv(reply, `trial-balance-${asOf}.csv`, [
        { key: 'code', label: 'Code' }, { key: 'name', label: 'Account' }, { key: 'type', label: 'Type' },
        { key: 'debit', label: 'Debit' }, { key: 'credit', label: 'Credit' },
      ], rows);
    }
    return { asOf, rows, totals };
  });

  // ---- Stock valuation ------------------------------------------------
  r.get('/api/reports/stock', ['reports.view', 'inventory.view'], async ({ db, ctx, query, reply }) => {
    const q = parse(zRange.extend({ warehouseId: zOptId }), query);
    const rows = await db.many(
      `SELECT p.sku, p.name, COALESCE(c.name, '') AS category, p.unit, p.reorder_level, p.avg_cost, p.sale_price,
              COALESCE(s.qty, 0) AS qty, round(GREATEST(COALESCE(s.qty, 0), 0) * p.avg_cost, 2) AS cost_value,
              round(GREATEST(COALESCE(s.qty, 0), 0) * p.sale_price, 2) AS sale_value,
              CASE WHEN COALESCE(s.qty, 0) <= 0 THEN 'Out of stock'
                   WHEN COALESCE(s.qty, 0) <= p.reorder_level THEN 'Low' ELSE 'OK' END AS status
       FROM products p
       LEFT JOIN categories c ON c.id = p.category_id
       LEFT JOIN (SELECT product_id, sum(qty) AS qty FROM stock_levels
                  WHERE ($1::uuid IS NULL OR warehouse_id = $1) AND ($2::uuid[] IS NULL OR warehouse_id = ANY($2))
                  GROUP BY product_id) s ON s.product_id = p.id
       WHERE p.is_active ORDER BY p.name`,
      [q.warehouseId, ctx.warehouseIds],
    );
    if (q.format === 'csv') {
      return sendCsv(reply, 'stock-valuation.csv', [
        { key: 'sku', label: 'SKU' }, { key: 'name', label: 'Product' }, { key: 'category', label: 'Category' },
        { key: 'unit', label: 'Unit' }, { key: 'qty', label: 'Qty' }, { key: 'avg_cost', label: 'Avg cost' },
        { key: 'cost_value', label: 'Cost value' }, { key: 'sale_value', label: 'Sale value' }, { key: 'status', label: 'Status' },
      ], rows);
    }
    return {
      rows,
      totals: {
        qty: round2(rows.reduce((s, r) => s + Math.max(r.qty, 0), 0)),
        costValue: round2(rows.reduce((s, r) => s + r.cost_value, 0)),
        saleValue: round2(rows.reduce((s, r) => s + r.sale_value, 0)),
      },
    };
  });

  // ---- Purchases & expenses -------------------------------------------
  r.get('/api/reports/purchases', 'reports.view', async ({ db, query, reply }) => {
    const q = parse(zRange.extend({ groupBy: z.enum(['supplier', 'product', 'day']).default('supplier') }), query);
    const range = await resolveRange(db, q.from, q.to);
    const key = { supplier: `COALESCE(s.name, 'No supplier')`, product: `pr.name`, day: `p.purchase_date::text` }[q.groupBy];
    const rows = await db.many(
      `SELECT ${key} AS label, count(DISTINCT p.id) AS purchases, sum(i.qty) AS qty, sum(i.line_total) AS amount
       FROM purchases p JOIN purchase_items i ON i.purchase_id = p.id JOIN products pr ON pr.id = i.product_id
       LEFT JOIN suppliers s ON s.id = p.supplier_id
       WHERE p.purchase_date BETWEEN $1 AND $2 GROUP BY 1 ORDER BY amount DESC`,
      [range.from, range.to],
    );
    if (q.format === 'csv') {
      return sendCsv(reply, `purchases-${range.from}-${range.to}.csv`, [
        { key: 'label', label: q.groupBy }, { key: 'purchases', label: 'Purchases' }, { key: 'qty', label: 'Qty' }, { key: 'amount', label: 'Amount' },
      ], rows);
    }
    return { ...range, rows, total: round2(rows.reduce((s, r) => s + r.amount, 0)) };
  });

  r.get('/api/reports/expenses', ['reports.view', 'finance.view'], async ({ db, query, reply }) => {
    const q = parse(zRange, query);
    const range = await resolveRange(db, q.from, q.to);
    const rows = await db.many(
      `SELECT a.code, a.name, count(*) AS entries, sum(f.amount) AS amount
       FROM finance_entries f JOIN accounts a ON a.id = f.category_account_id
       WHERE f.kind = 'expense' AND f.entry_date BETWEEN $1 AND $2 GROUP BY a.code, a.name ORDER BY amount DESC`,
      [range.from, range.to],
    );
    if (q.format === 'csv') {
      return sendCsv(reply, `expenses-${range.from}-${range.to}.csv`, [
        { key: 'code', label: 'Code' }, { key: 'name', label: 'Category' }, { key: 'entries', label: 'Entries' }, { key: 'amount', label: 'Amount' },
      ], rows);
    }
    return { ...range, rows, total: round2(rows.reduce((s, r) => s + r.amount, 0)) };
  });

  // ---- Receivables / payables with ageing -----------------------------
  r.get('/api/reports/receivables', ['reports.view', 'collections.manage'], async ({ db, query, reply }) => {
    const q = parse(zRange, query);
    const rows = await db.many(
      `SELECT c.code, c.name, c.phone, count(*) AS invoices, sum(s.due_amount) AS due,
              sum(s.due_amount) FILTER (WHERE age <= 30) AS d0_30,
              sum(s.due_amount) FILTER (WHERE age BETWEEN 31 AND 60) AS d31_60,
              sum(s.due_amount) FILTER (WHERE age BETWEEN 61 AND 90) AS d61_90,
              sum(s.due_amount) FILTER (WHERE age > 90) AS d90_plus,
              min(s.sale_date) AS oldest
       FROM (SELECT *, app_tenant_today() - (sale_date AT TIME ZONE app_tenant_tz())::date AS age FROM sales
             WHERE status = 'completed' AND due_amount > 0) s
       JOIN customers c ON c.id = s.customer_id
       GROUP BY c.id ORDER BY due DESC`,
    );
    if (q.format === 'csv') {
      return sendCsv(reply, 'receivables.csv', [
        { key: 'code', label: 'Code' }, { key: 'name', label: 'Customer' }, { key: 'phone', label: 'Phone' },
        { key: 'invoices', label: 'Invoices' }, { key: 'd0_30', label: '0-30 days' }, { key: 'd31_60', label: '31-60' },
        { key: 'd61_90', label: '61-90' }, { key: 'd90_plus', label: '90+' }, { key: 'due', label: 'Total due' },
      ], rows);
    }
    return { rows, total: round2(rows.reduce((s, r) => s + r.due, 0)) };
  });

  r.get('/api/reports/payables', ['reports.view', 'suppliers.pay'], async ({ db, query, reply }) => {
    const q = parse(zRange, query);
    const rows = await db.many(
      `SELECT s.code, s.name, s.phone, count(*) AS purchases, sum(p.due_amount) AS due, min(p.purchase_date) AS oldest
       FROM purchases p JOIN suppliers s ON s.id = p.supplier_id WHERE p.due_amount > 0
       GROUP BY s.id ORDER BY due DESC`,
    );
    if (q.format === 'csv') {
      return sendCsv(reply, 'payables.csv', [
        { key: 'code', label: 'Code' }, { key: 'name', label: 'Supplier' }, { key: 'phone', label: 'Phone' },
        { key: 'purchases', label: 'Purchases' }, { key: 'due', label: 'Payable' },
      ], rows);
    }
    return { rows, total: round2(rows.reduce((s, r) => s + r.due, 0)) };
  });

  // ---- Daily cash summary ("day close") -------------------------------
  r.get('/api/reports/day-summary', ['reports.view', 'finance.view'], async ({ db, query }) => {
    const q = parse(z.object({ date: zDate.optional() }), query);
    const { date } = await db.one(`SELECT COALESCE($1::date, app_tenant_today())::text AS date`, [q.date ?? null]);
    const sales = await db.one(
      `SELECT count(*) FILTER (WHERE status = 'completed') AS invoices,
              COALESCE(sum(total) FILTER (WHERE status = 'completed'), 0) AS total,
              COALESCE(sum(paid_amount) FILTER (WHERE status = 'completed'), 0) AS paid,
              COALESCE(sum(due_amount) FILTER (WHERE status = 'completed'), 0) AS due,
              count(*) FILTER (WHERE status = 'void') AS voided
       FROM sales WHERE ${localDateRange('sale_date', 1, 1)}`,
      [date],
    );
    const accounts = await db.many(
      `SELECT a.name, a.money_kind,
              COALESCE(sum(l.debit - l.credit) FILTER (WHERE e.entry_date < $1), 0) AS opening,
              COALESCE(sum(l.debit) FILTER (WHERE e.entry_date = $1), 0) AS money_in,
              COALESCE(sum(l.credit) FILTER (WHERE e.entry_date = $1), 0) AS money_out,
              COALESCE(sum(l.debit - l.credit) FILTER (WHERE e.entry_date <= $1), 0) AS closing
       FROM accounts a
       LEFT JOIN journal_lines l ON l.account_id = a.id
       LEFT JOIN journal_entries e ON e.id = l.entry_id
       WHERE a.is_money GROUP BY a.id ORDER BY a.code`,
      [date],
    );
    const movements = await db.many(
      `SELECT e.number, e.memo, e.ref_type, a.name AS account, l.debit AS money_in, l.credit AS money_out
       FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id JOIN accounts a ON a.id = l.account_id
       WHERE a.is_money AND e.entry_date = $1 ORDER BY e.created_at`,
      [date],
    );
    return { date, sales, accounts, movements };
  });
}
