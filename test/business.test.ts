import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { appPool } from '../src/db/pool';
import { Client, login, makeProduct, makeTenant, moneyAccount, startApp, uid } from './helpers';

let app: FastifyInstance;
let C: Client;
let lookups: any;
let warehouseId: string;
let cash: string;

const stockOf = async (productId: string) => (await C.get(`/api/products/${productId}`)).body.stock[0].qty;
const expectBalancedBooks = async () => {
  const tb = (await C.get('/api/reports/trial-balance')).body;
  expect(tb.totals.debit).toBe(tb.totals.credit);
  const bs = (await C.get('/api/reports/balance-sheet')).body;
  expect(bs.balanced).toBe(true);
};

beforeAll(async () => {
  app = await startApp();
  const tenant = await makeTenant('biz');
  C = await login(app, tenant.ownerEmail);
  lookups = (await C.get('/api/lookups')).body;
  warehouseId = lookups.warehouses[0].id;
  cash = moneyAccount(lookups);
  // Opening cash so expenses and refunds have funds.
  await C.post('/api/journal', {
    date: lookups.settings.today, memo: 'Opening cash',
    lines: [{ accountId: cash, debit: 100000 }, { accountId: moneyAccount(lookups, 'EQUITY'), credit: 100000 }],
  });
});

afterAll(async () => {
  await app.close();
  await appPool.end();
});

describe('POS sales', () => {
  it('sells, reduces stock, records profit and keeps the books balanced', async () => {
    const { product } = await makeProduct(C, { qty: 10, cost: 50, price: 80, vatRate: 5 });
    const res = await C.post('/api/sales', {
      warehouseId, items: [{ productId: product.id, qty: 3 }], discount: 10,
      payments: [{ accountId: cash, amount: 241.5 }],
    });
    expect(res.status).toBe(201);
    expect(res.body.subtotal).toBe(240);
    expect(res.body.vat_amount).toBe(11.5);
    expect(res.body.total).toBe(241.5);
    expect(res.body.due_amount).toBe(0);
    expect(res.body.cost_total).toBe(150);
    expect(res.body.number).toMatch(/^INV-\d{6}$/);
    expect(await stockOf(product.id)).toBe(7);
    await expectBalancedBooks();
  });

  it('rejects overselling and leaves stock untouched', async () => {
    const { product } = await makeProduct(C, { qty: 2 });
    const res = await C.post('/api/sales', { warehouseId, items: [{ productId: product.id, qty: 5 }], payments: [{ accountId: cash, amount: 500 }] });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/Insufficient stock/);
    expect(await stockOf(product.id)).toBe(2);
  });

  it('never oversells under concurrent checkouts', async () => {
    const { product } = await makeProduct(C, { qty: 5, price: 10 });
    const attempts = await Promise.all(
      Array.from({ length: 12 }, () =>
        C.post('/api/sales', { warehouseId, items: [{ productId: product.id, qty: 1 }], payments: [{ accountId: cash, amount: 10 }] }),
      ),
    );
    expect(attempts.filter((r) => r.status === 201)).toHaveLength(5);
    expect(await stockOf(product.id)).toBe(0);
  });

  it('requires a customer for credit sales and enforces the credit limit', async () => {
    const { product } = await makeProduct(C, { qty: 20, price: 100 });
    const noCustomer = await C.post('/api/sales', { warehouseId, items: [{ productId: product.id, qty: 1 }], payments: [] });
    expect(noCustomer.status).toBe(400);
    const customer = (await C.post('/api/customers', { name: `Limited ${uid()}`, creditLimit: 150 })).body;
    const ok = await C.post('/api/sales', { warehouseId, customerId: customer.id, items: [{ productId: product.id, qty: 1 }], payments: [] });
    expect(ok.status).toBe(201);
    const over = await C.post('/api/sales', { warehouseId, customerId: customer.id, items: [{ productId: product.id, qty: 1 }], payments: [] });
    expect(over.status).toBe(400);
    expect(over.body.message).toMatch(/Credit limit/);
  });
});

describe('Due collection', () => {
  it('allocates oldest invoices first and rejects overpayment', async () => {
    const { product } = await makeProduct(C, { qty: 20, price: 100 });
    const customer = (await C.post('/api/customers', { name: `Due ${uid()}` })).body;
    const s1 = (await C.post('/api/sales', { warehouseId, customerId: customer.id, items: [{ productId: product.id, qty: 1 }], payments: [] })).body;
    const s2 = (await C.post('/api/sales', { warehouseId, customerId: customer.id, items: [{ productId: product.id, qty: 2 }], payments: [] })).body;

    expect((await C.post('/api/collections', { customerId: customer.id, accountId: cash, amount: 301 })).status).toBe(400);
    const pay = await C.post('/api/collections', { customerId: customer.id, accountId: cash, amount: 150 });
    expect(pay.status).toBe(201);
    expect((await C.get(`/api/sales/${s1.id}`)).body.due_amount).toBe(0);
    expect((await C.get(`/api/sales/${s2.id}`)).body.due_amount).toBe(150);

    const statement = (await C.get(`/api/customers/${customer.id}/statement`)).body;
    expect(statement.closing).toBe(150);
    await expectBalancedBooks();
  });
});

describe('Returns, replacements and voids', () => {
  it('a partial return restocks, reduces due first, then refunds', async () => {
    const { product } = await makeProduct(C, { qty: 10, cost: 40, price: 100 });
    const customer = (await C.post('/api/customers', { name: `Ret ${uid()}` })).body;
    const sale = (await C.post('/api/sales', {
      warehouseId, customerId: customer.id, items: [{ productId: product.id, qty: 4 }], payments: [{ accountId: cash, amount: 300 }],
    })).body;
    expect(sale.due_amount).toBe(100);

    const ret = await C.post('/api/returns', { saleId: sale.id, items: [{ saleItemId: sale.items[0].id, qty: 2 }], accountId: cash });
    expect(ret.status).toBe(201);
    expect(ret.body.amount).toBe(200);
    expect(ret.body.dueReduction).toBe(100);
    expect(ret.body.refund).toBe(100);
    expect(await stockOf(product.id)).toBe(8);

    const tooMany = await C.post('/api/returns', { saleId: sale.id, items: [{ saleItemId: sale.items[0].id, qty: 3 }], accountId: cash });
    expect(tooMany.status).toBe(400);
    expect((await C.post(`/api/sales/${sale.id}/void`, { reason: 'test void' })).status).toBe(409);
    await expectBalancedBooks();
  });

  it('voiding restores stock and reverses the journal', async () => {
    const { product } = await makeProduct(C, { qty: 5, price: 100 });
    const sale = (await C.post('/api/sales', { warehouseId, items: [{ productId: product.id, qty: 3 }], payments: [{ accountId: cash, amount: 300 }] })).body;
    expect(await stockOf(product.id)).toBe(2);
    const v = await C.post(`/api/sales/${sale.id}/void`, { reason: 'Customer cancelled' });
    expect(v.status).toBe(200);
    expect(v.body.status).toBe('void');
    expect(await stockOf(product.id)).toBe(5);
    expect((await C.post(`/api/sales/${sale.id}/void`, { reason: 'again please' })).status).toBe(409);
    await expectBalancedBooks();
  });

  it('a replacement issues a new unit and writes off the defective one', async () => {
    const { product } = await makeProduct(C, { qty: 5, cost: 900, price: 1200 });
    const sale = (await C.post('/api/sales', { warehouseId, items: [{ productId: product.id, qty: 1 }], payments: [{ accountId: cash, amount: 1200 }] })).body;
    const rep = await C.post('/api/replacements', {
      saleId: sale.id, warehouseId, returnedProductId: product.id, returnedQty: 1, issuedProductId: product.id, issuedQty: 1, reason: 'Dead cell',
    });
    expect(rep.status).toBe(201);
    expect(await stockOf(product.id)).toBe(3);
    await expectBalancedBooks();
  });
});

describe('Purchasing and stock', () => {
  it('stock in updates moving-average cost and supplier payable', async () => {
    const { product } = await makeProduct(C, { qty: 10, cost: 50 });
    const supplier = (await C.post('/api/suppliers', { name: `Sup ${uid()}` })).body;
    const p = await C.post('/api/purchases', {
      supplierId: supplier.id, warehouseId, items: [{ productId: product.id, qty: 10, unitCost: 70 }], paidAmount: 300, accountId: cash,
    });
    expect(p.status).toBe(201);
    expect(p.body.due_amount).toBe(400);
    const detail = (await C.get(`/api/products/${product.id}`)).body;
    expect(detail.avg_cost).toBe(60);
    expect(detail.stock[0].qty).toBe(20);

    const pay = await C.post(`/api/suppliers/${supplier.id}/payments`, { accountId: cash, amount: 400 });
    expect(pay.status).toBe(201);
    const st = (await C.get(`/api/suppliers/${supplier.id}/statement`)).body;
    expect(st.closing).toBe(0);
    await expectBalancedBooks();
  });

  it('transfers between warehouses and blocks negative transfers', async () => {
    const { product } = await makeProduct(C, { qty: 6 });
    const wh2 = (await C.post('/api/warehouses', { code: `W${uid().slice(0, 5)}`.toUpperCase(), name: 'Second' })).body;
    const ok = await C.post('/api/transfers', { fromWarehouseId: warehouseId, toWarehouseId: wh2.id, items: [{ productId: product.id, qty: 4 }] });
    expect(ok.status).toBe(201);
    const bad = await C.post('/api/transfers', { fromWarehouseId: warehouseId, toWarehouseId: wh2.id, items: [{ productId: product.id, qty: 4 }] });
    expect(bad.status).toBe(400);
    const stock = (await C.get(`/api/products/${product.id}`)).body.stock;
    expect(stock.find((s: any) => s.warehouse_id === wh2.id).qty).toBe(4);
  });

  it('production consumes materials and costs the finished good', async () => {
    const flour = (await makeProduct(C, { qty: 100, cost: 10 })).product;
    const oil = (await makeProduct(C, { qty: 10, cost: 200 })).product;
    const snack = (await makeProduct(C, { price: 50 })).product;
    const res = await C.post('/api/production', {
      warehouseId, outputProductId: snack.id, outputQty: 50,
      inputs: [{ productId: flour.id, qty: 20 }, { productId: oil.id, qty: 2 }], extraCost: 100, accountId: cash,
    });
    expect(res.status).toBe(201);
    expect(res.body.materialsCost).toBe(600);
    expect(res.body.unitCost).toBe(14);
    expect(await stockOf(snack.id)).toBe(50);
    expect(await stockOf(flour.id)).toBe(80);
    await expectBalancedBooks();
  });
});

describe('Finance and payroll', () => {
  it('records expenses, bank deposits and a P&L that matches the ledger', async () => {
    const rent = lookups.accounts.find((a: any) => a.name === 'Rent').id;
    expect((await C.post('/api/finance', { kind: 'expense', categoryAccountId: rent, moneyAccountId: cash, amount: 5000 })).status).toBe(201);
    const bank = moneyAccount(lookups, 'BANK');
    expect((await C.post('/api/fund-transfers', { fromAccountId: cash, toAccountId: bank, amount: 1000 })).status).toBe(201);
    expect((await C.post('/api/fund-transfers', { fromAccountId: cash, toAccountId: bank, amount: 10_000_000 })).status).toBe(400);
    const pl = (await C.get('/api/reports/profit-loss')).body;
    expect(pl.expenses.find((e: any) => e.name === 'Rent').amount).toBe(5000);
    await expectBalancedBooks();
  });

  it('builds a payroll draft from attendance and pays it once', async () => {
    const emp = (await C.post('/api/employees', { name: 'Worker One', baseSalary: 30000 })).body;
    await C.put('/api/attendance', { date: '2026-09-02', records: [{ employeeId: emp.id, status: 'absent' }] });
    const run = await C.post('/api/payroll/runs', { period: '2026-09', deductAbsences: true });
    expect(run.status).toBe(201);
    const line = run.body.items.find((i: any) => i.employee_id === emp.id);
    expect(line.deduction).toBe(1000);
    expect(line.net_pay).toBe(29000);
    expect((await C.post('/api/payroll/runs', { period: '2026-09' })).status).toBe(409);
    const paid = await C.post(`/api/payroll/runs/${run.body.id}/pay`, { accountId: cash });
    expect(paid.body.status).toBe('paid');
    expect((await C.post(`/api/payroll/runs/${run.body.id}/pay`, { accountId: cash })).status).toBe(409);
    await expectBalancedBooks();
  });

  it('records an activity log trail', async () => {
    const logs = (await C.get('/api/activity?pageSize=200')).body.rows.map((r: any) => r.action);
    expect(logs).toEqual(expect.arrayContaining(['sale.create', 'sale.void', 'purchase.create', 'payroll.pay', 'auth.login']));
  });
});
