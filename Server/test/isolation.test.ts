/**
 * Sprint 1 acceptance gate: automated proof of tenant isolation.
 * Two independent businesses (A and B) are provisioned; every test tries to
 * reach B's data from A through the API, the database role, or both.
 */
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { appPool, withSystem, withTenant } from '../src/db/pool';
import { runLowStockJob } from '../src/jobs/lowStock';
import {
  adminClient, Client, login, makePlatformAdmin, makeProduct, makeTenant, moneyAccount, PASSWORD, startApp, uid,
} from './helpers';

let app: FastifyInstance;
let A: Client;
let B: Client;
const t: Record<string, any> = {};

beforeAll(async () => {
  app = await startApp();
  const tenantA = await makeTenant('alpha');
  const tenantB = await makeTenant('beta');
  t.tenantA = tenantA;
  t.tenantB = tenantB;
  A = await login(app, tenantA.ownerEmail);
  B = await login(app, tenantB.ownerEmail);

  const pa = await makeProduct(A, { name: `Alpha Rice ${uid()}`, qty: 50, cost: 40, price: 70, reorderLevel: 100 });
  const pb = await makeProduct(B, { name: `Beta Battery ${uid()}`, qty: 50, cost: 900, price: 1200 });
  Object.assign(t, {
    productA: pa.product, productB: pb.product, warehouseA: pa.warehouseId, warehouseB: pb.warehouseId,
    cashA: moneyAccount(pa.lookups), cashB: moneyAccount(pb.lookups), lookupsB: pb.lookups,
  });

  t.customerA = (await A.post('/api/customers', { name: 'Alpha Customer' })).body;
  t.customerB = (await B.post('/api/customers', { name: 'Beta Customer' })).body;

  const saleA = await A.post('/api/sales', {
    warehouseId: t.warehouseA, customerId: t.customerA.id, items: [{ productId: t.productA.id, qty: 2 }],
    payments: [{ accountId: t.cashA, amount: 40 }],
  });
  const saleB = await B.post('/api/sales', {
    warehouseId: t.warehouseB, customerId: t.customerB.id, items: [{ productId: t.productB.id, qty: 1 }],
    payments: [{ accountId: t.cashB, amount: 200 }],
  });
  expect(saleA.status).toBe(201);
  expect(saleB.status).toBe(201);
  t.saleA = saleA.body;
  t.saleB = saleB.body;
});

afterAll(async () => {
  await app.close();
  await appPool.end();
});

describe('Tenant A cannot read Tenant B records', () => {
  it('lists contain only own records', async () => {
    const products = (await A.get('/api/products?status=all&pageSize=500')).body.rows.map((p: any) => p.id);
    expect(products).toContain(t.productA.id);
    expect(products).not.toContain(t.productB.id);

    const customers = (await A.get('/api/customers?pageSize=500')).body.rows.map((c: any) => c.id);
    expect(customers).toContain(t.customerA.id);
    expect(customers).not.toContain(t.customerB.id);

    const sales = (await A.get('/api/sales?pageSize=500')).body.rows.map((s: any) => s.id);
    expect(sales).toContain(t.saleA.id);
    expect(sales).not.toContain(t.saleB.id);

    const accounts = (await A.get('/api/accounts')).body.map((a: any) => a.id);
    expect(accounts).not.toContain(t.cashB);
  });

  it('changing a record id in the URL does not bypass isolation', async () => {
    expect((await A.get(`/api/products/${t.productB.id}`)).status).toBe(404);
    expect((await A.get(`/api/sales/${t.saleB.id}`)).status).toBe(404);
    expect((await A.get(`/api/customers/${t.customerB.id}`)).status).toBe(404);
    expect((await A.get(`/api/customers/${t.customerB.id}/statement`)).status).toBe(404);
    expect((await A.get(`/api/accounts/${t.cashB}/ledger`)).status).toBe(404);
  });
});

describe('Tenant A cannot modify Tenant B records', () => {
  it('update and delete by foreign id return 404 and change nothing', async () => {
    const patch = await A.patch(`/api/products/${t.productB.id}`, { sku: 'HACK', name: 'Hacked', salePrice: 1 });
    expect(patch.status).toBe(404);
    expect((await A.del(`/api/products/${t.productB.id}`)).status).toBe(404);
    expect((await A.patch(`/api/customers/${t.customerB.id}`, { code: 'X', name: 'Hacked' })).status).toBe(404);
    expect((await A.post(`/api/sales/${t.saleB.id}/void`, { reason: 'attack' })).status).toBe(404);

    const stillB = await B.get(`/api/products/${t.productB.id}`);
    expect(stillB.body.name).toBe(t.productB.name);
    expect((await B.get(`/api/sales/${t.saleB.id}`)).body.status).toBe('completed');
  });
});

describe('Client-supplied tenant identifiers are ignored', () => {
  it('tenant ids in query, headers and body grant nothing', async () => {
    const res = await A.get(`/api/products?tenantId=${t.tenantB.id}&tenant_id=${t.tenantB.id}`, {
      'x-tenant-id': t.tenantB.id,
    });
    const ids = res.body.rows.map((p: any) => p.id);
    expect(ids).not.toContain(t.productB.id);

    const created = await A.post('/api/products', { name: `Injected ${uid()}`, salePrice: 10, tenantId: t.tenantB.id, tenant_id: t.tenantB.id });
    expect(created.status).toBe(201);
    expect((await B.get(`/api/products/${created.body.id}`)).status).toBe(404);
    expect((await A.get(`/api/products/${created.body.id}`)).status).toBe(200);
  });

  it('cannot switch the session into a business the user does not belong to', async () => {
    const res = await A.post('/api/auth/switch-tenant', { tenantId: t.tenantB.id });
    expect(res.status).toBe(403);
    const me = await A.get('/api/auth/me');
    expect(me.body.tenant.id).toBe(t.tenantA.id);
  });
});

describe('Cross-tenant references are rejected', () => {
  const sale = (over: Record<string, unknown>) => ({
    warehouseId: t.warehouseA, items: [{ productId: t.productA.id, qty: 1 }], payments: [{ accountId: t.cashA, amount: 70 }], ...over,
  });

  it('a sale cannot use another tenant’s product, customer, warehouse or account', async () => {
    expect((await A.post('/api/sales', sale({ items: [{ productId: t.productB.id, qty: 1 }], payments: [] }))).status).toBe(400);
    expect((await A.post('/api/sales', sale({ customerId: t.customerB.id }))).status).toBe(400);
    expect((await A.post('/api/sales', sale({ warehouseId: t.warehouseB }))).status).toBe(400);
    expect((await A.post('/api/sales', sale({ payments: [{ accountId: t.cashB, amount: 70 }] }))).status).toBe(400);
  });

  it('an inventory adjustment cannot change another tenant’s stock', async () => {
    const before = (await B.get(`/api/products/${t.productB.id}`)).body.stock[0].qty;
    const res = await A.post('/api/adjustments', {
      warehouseId: t.warehouseA, reason: 'count', items: [{ productId: t.productB.id, qtyChange: -10 }],
    });
    expect(res.status).toBe(400);
    const res2 = await A.post('/api/adjustments', {
      warehouseId: t.warehouseB, reason: 'count', items: [{ productId: t.productA.id, qtyChange: -1 }],
    });
    expect(res2.status).toBe(400);
    expect((await B.get(`/api/products/${t.productB.id}`)).body.stock[0].qty).toBe(before);
  });

  it('a customer payment cannot be allocated to another tenant’s invoice', async () => {
    const res = await A.post('/api/collections', {
      customerId: t.customerA.id, accountId: t.cashA, amount: 10, allocations: [{ docId: t.saleB.id, amount: 10 }],
    });
    expect(res.status).toBe(400);
    expect((await A.post('/api/collections', { customerId: t.customerB.id, accountId: t.cashA, amount: 10 })).status).toBe(400);
    expect((await B.get(`/api/sales/${t.saleB.id}`)).body.due_amount).toBe(t.saleB.due_amount);
  });

  it('returns, journals, transfers and payroll cannot touch another tenant', async () => {
    const itemB = t.saleB.items[0].id;
    expect((await A.post('/api/returns', { saleId: t.saleB.id, items: [{ saleItemId: itemB, qty: 1 }] })).status).toBe(404);
    expect((await A.post('/api/returns', { saleId: t.saleA.id, items: [{ saleItemId: itemB, qty: 1 }] })).status).toBe(400);

    const journal = await A.post('/api/journal', {
      date: '2026-01-01', memo: 'cross tenant', lines: [{ accountId: t.cashA, debit: 5 }, { accountId: t.cashB, credit: 5 }],
    });
    expect(journal.status).toBe(400);

    const transfer = await A.post('/api/fund-transfers', { fromAccountId: t.cashA, toAccountId: t.cashB, amount: 1 });
    expect(transfer.status).toBe(400);

    const empB = await B.post('/api/employees', { name: 'Beta Worker', baseSalary: 1000 });
    const att = await A.put('/api/attendance', { date: '2026-10-01', records: [{ employeeId: empB.body.id, status: 'present' }] });
    expect(att.status).toBe(400);
  });
});

describe('Reports, exports and dashboards are tenant-scoped', () => {
  it('sales report and CSV export contain only own data', async () => {
    const json = await A.get('/api/reports/sales?groupBy=product&from=2000-01-01&to=2100-01-01');
    const labels = json.body.rows.map((r: any) => r.label).join('|');
    expect(labels).toContain(t.productA.name);
    expect(labels).not.toContain(t.productB.name);

    const csv = await A.get('/api/reports/stock?format=csv');
    expect(csv.status).toBe(200);
    expect(csv.text).toContain(t.productA.name);
    expect(csv.text).not.toContain(t.productB.name);
  });

  it('dashboard totals equal own sales only', async () => {
    const dash = (await A.get('/api/dashboard')).body;
    expect(dash.profit.lifetime.sales).toBe(140);
    expect(dash.stock.total_products).toBeGreaterThan(0);
  });

  it('the trial balance only includes own journals', async () => {
    const tb = (await A.get('/api/reports/trial-balance')).body;
    expect(tb.totals.debit).toBe(tb.totals.credit);
    const inventory = tb.rows.find((r: any) => r.name === 'Inventory');
    expect(inventory.debit).toBeLessThan(50 * 40 + 1);
  });
});

describe('Background jobs execute in the correct tenant context', () => {
  it('low-stock job writes each tenant’s notifications only into that tenant', async () => {
    await B.patch(`/api/products/${t.productB.id}`, { ...t.productB, salePrice: 1200, reorderLevel: 1000, sku: t.productB.sku });
    await runLowStockJob();
    const notesA = (await A.get('/api/notifications')).body.map((n: any) => n.title).join('|');
    const notesB = (await B.get('/api/notifications')).body.map((n: any) => n.title).join('|');
    expect(notesA).toContain(t.productA.name);
    expect(notesA).not.toContain(t.productB.name);
    expect(notesB).toContain(t.productB.name);
    expect(notesB).not.toContain(t.productA.name);
  });
});

describe('Authentication and platform boundaries', () => {
  it('unauthenticated users cannot access tenant resources', async () => {
    const anon = new Client(app, null);
    expect((await anon.get('/api/products')).status).toBe(401);
    expect((await anon.get('/api/dashboard')).status).toBe(401);
    expect((await new Client(app, 'forged-token').get('/api/products')).status).toBe(401);
  });

  it('tenant administrators cannot use platform functions', async () => {
    expect((await A.get('/api/platform/tenants')).status).toBe(403);
    expect((await A.post('/api/platform/tenants', { name: 'Evil', slug: `evil-${uid()}`, ownerEmail: 'e@e.com', ownerName: 'E' })).status).toBe(403);
    expect((await A.patch(`/api/platform/tenants/${t.tenantB.id}`, { status: 'suspended' })).status).toBe(403);
  });

  it('platform admins manage tenants but cannot read tenant business data', async () => {
    const P = await login(app, await makePlatformAdmin());
    const tenants = (await P.get('/api/platform/tenants')).body.map((x: any) => x.id);
    expect(tenants).toEqual(expect.arrayContaining([t.tenantA.id, t.tenantB.id]));
    expect((await P.get('/api/products')).status).toBe(403);

    expect((await P.patch(`/api/platform/tenants/${t.tenantB.id}`, { status: 'suspended' })).status).toBe(200);
    expect((await B.get('/api/products')).status).toBe(403);
    expect((await P.patch(`/api/platform/tenants/${t.tenantB.id}`, { status: 'active' })).status).toBe(200);
    expect((await B.get('/api/products')).status).toBe(200);
  });

  it('a user in two businesses sees only the selected business', async () => {
    const email = `shared-${uid()}@both.test`;
    const rolesA = (await A.get('/api/roles')).body;
    const rolesB = (await B.get('/api/roles')).body;
    const cashierA = rolesA.find((r: any) => r.name === 'Manager').id;
    const cashierB = rolesB.find((r: any) => r.name === 'Manager').id;
    expect((await A.post('/api/users', { email, name: 'Shared', password: PASSWORD, roleId: cashierA })).status).toBe(201);
    // B cannot attach A's role id to its own member.
    expect((await B.post('/api/users', { email, name: 'Shared', roleId: cashierA })).status).toBe(400);
    expect((await B.post('/api/users', { email, name: 'Shared', roleId: cashierB })).status).toBe(201);

    const U = await login(app, email, PASSWORD, t.tenantA.slug);
    let ids = (await U.get('/api/products?pageSize=500')).body.rows.map((p: any) => p.id);
    expect(ids).toContain(t.productA.id);
    expect(ids).not.toContain(t.productB.id);

    expect((await U.post('/api/auth/switch-tenant', { tenantId: t.tenantB.id })).status).toBe(200);
    ids = (await U.get('/api/products?pageSize=500')).body.rows.map((p: any) => p.id);
    expect(ids).toContain(t.productB.id);
    expect(ids).not.toContain(t.productA.id);

    // A cannot reset the password of a user who also belongs to B.
    const member = (await A.get('/api/users')).body.find((m: any) => m.email === email);
    expect((await A.post(`/api/users/${member.id}/reset-password`, { password: 'NewPass123' })).status).toBe(403);
  });
});

describe('Role-based access control inside a tenant', () => {
  it('a cashier cannot manage settings, users or void sales', async () => {
    const roles = (await A.get('/api/roles')).body;
    const cashierRole = roles.find((r: any) => r.name === 'Cashier').id;
    const email = `cashier-${uid()}@alpha.test`;
    await A.post('/api/users', { email, name: 'Cashier', password: PASSWORD, roleId: cashierRole });
    const C = await login(app, email);
    expect((await C.get('/api/users')).status).toBe(403);
    expect((await C.put('/api/settings', {})).status).toBe(403);
    expect((await C.post(`/api/sales/${t.saleA.id}/void`, { reason: 'not allowed' })).status).toBe(403);
    expect((await C.get('/api/reports/profit-loss')).status).toBe(403);
    expect((await C.get('/api/pos/products?warehouseId=' + t.warehouseA)).status).toBe(200);
  });

  it('users cannot grant permissions they do not hold', async () => {
    const role = await A.post('/api/roles', { name: `Supervisor ${uid()}`, permissions: ['users.manage', 'pos.sell'] });
    const email = `sup-${uid()}@alpha.test`;
    await A.post('/api/users', { email, name: 'Supervisor', password: PASSWORD, roleId: role.body.id });
    const S = await login(app, email);
    const escalate = await S.post('/api/roles', { name: `Boss ${uid()}`, permissions: ['settings.manage'] });
    expect(escalate.status).toBe(403);
    const owner = (await S.get('/api/roles')).body.find((r: any) => r.name === 'Owner');
    const grantOwner = await S.post("/api/users", { email: `x-${uid()}@a.test`, name: "Xavier", password: PASSWORD, roleId: owner.id });
    expect(grantOwner.body.message ?? "").toMatch(/cannot grant/);
    expect(grantOwner.status).toBe(403);
  });

  it('branch-scoped users cannot operate on other warehouses', async () => {
    const wh = await A.post('/api/warehouses', { code: `BR${uid().slice(0, 4)}`.toUpperCase(), name: 'Branch 2' });
    const roles = (await A.get('/api/roles')).body;
    const email = `branch-${uid()}@alpha.test`;
    await A.post('/api/users', {
      email, name: 'Branch Cashier', password: PASSWORD, roleId: roles.find((r: any) => r.name === 'Cashier').id, warehouseIds: [wh.body.id],
    });
    const S = await login(app, email);
    const res = await S.post('/api/sales', { warehouseId: t.warehouseA, items: [{ productId: t.productA.id, qty: 1 }], payments: [{ accountId: t.cashA, amount: 70 }] });
    expect(res.status).toBe(403);
    expect((await S.get(`/api/sales/${t.saleA.id}`)).status).toBe(403);
  });
});

describe('Database-level enforcement (defence in depth)', () => {
  it('without a tenant context the app role sees no tenant rows', async () => {
    const n = await withSystem((db) => db.one(`SELECT count(*) AS n FROM products`));
    expect(n.n).toBe(0);
  });

  it('RLS blocks reads and writes of another tenant even with a hand-written query', async () => {
    const ctx = { tenantId: t.tenantA.id, userId: '' };
    const found = await withTenant(ctx, (db) => db.maybe(`SELECT id FROM products WHERE id = $1`, [t.productB.id]));
    expect(found).toBeNull();
    const updated = await withTenant(ctx, (db) => db.exec(`UPDATE products SET name = 'x' WHERE id = $1`, [t.productB.id]));
    expect(updated).toBe(0);
    await expect(
      withTenant(ctx, (db) => db.exec(`INSERT INTO categories (tenant_id, name) VALUES ($1, 'smuggled')`, [t.tenantB.id])),
    ).rejects.toMatchObject({ code: '42501' });
  });

  it('composite foreign keys reject cross-tenant links even when RLS is bypassed', async () => {
    const c = await adminClient();
    try {
      await expect(
        c.query(
          `INSERT INTO sale_items (tenant_id, sale_id, product_id, qty, unit_price, line_total) VALUES ($1, $2, $3, 1, 1, 1)`,
          [t.tenantA.id, t.saleA.id, t.productB.id],
        ),
      ).rejects.toMatchObject({ code: '23503' });
      await expect(
        c.query(`INSERT INTO sale_payments (tenant_id, sale_id, account_id, amount) VALUES ($1, $2, $3, 1)`, [
          t.tenantA.id, t.saleA.id, t.cashB,
        ]),
      ).rejects.toMatchObject({ code: '23503' });
      await expect(
        c.query(
          `INSERT INTO sales (tenant_id, number, customer_id, warehouse_id, subtotal, total)
           VALUES ($1, 'X-1', $2, $3, 0, 0)`,
          [t.tenantA.id, t.customerB.id, t.warehouseA],
        ),
      ).rejects.toMatchObject({ code: '23503' });
    } finally {
      await c.end();
    }
  });
});
