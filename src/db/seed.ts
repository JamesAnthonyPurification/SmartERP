import pg from 'pg';
import type { Ctx } from '../auth/context';
import { buildApp } from '../app';
import { config } from '../config';
import { hashPassword } from '../lib/password';
import { postJournal } from '../services/ledger';
import { postProduction } from '../services/production';
import { createPurchase } from '../services/purchases';
import { createSale, priceSale } from '../services/sales';
import { createCustomerPayment } from '../services/payments';
import { createTenant } from '../services/tenants';
import { appPool, Db, withPlatform, withTenant } from './pool';
import { migrate } from './migrate';

const DEMO_PASSWORD = process.env.DEMO_PASSWORD ?? 'Demo@12345';

// Deterministic pseudo-random numbers so every seed produces the same data.
let state = 20261027;
const rand = () => ((state = (state * 1103515245 + 12345) % 2147483648) / 2147483648);
const pick = <T>(arr: T[]) => arr[Math.floor(rand() * arr.length)];
const between = (min: number, max: number) => Math.floor(min + rand() * (max - min + 1));

interface DemoTenant {
  name: string;
  slug: string;
  businessType: string;
  address: string;
  phone: string;
  owner: { email: string; name: string };
  staff: { email: string; name: string; role: string }[];
  categories: string[];
  products: { name: string; category: string; unit: string; cost: number; price: number; reorder: number; stock: number; vat?: number }[];
  customers: { name: string; phone: string; creditLimit?: number }[];
  suppliers: { name: string; phone: string }[];
  employees: { name: string; designation: string; salary: number }[];
  branches: { code: string; name: string; kind: string }[];
}

const AMAR_FOOD: DemoTenant = {
  name: 'Amar Food',
  slug: 'amar-food',
  businessType: 'Food processing & distribution',
  address: 'Plot 12, BSCIC Industrial Area, Tongi, Gazipur',
  phone: '+880 1711-000111',
  owner: { email: 'owner@amarfood.com', name: 'Rahim Uddin' },
  staff: [
    { email: 'manager@amarfood.com', name: 'Karim Hossain', role: 'Manager' },
    { email: 'cashier@amarfood.com', name: 'Nusrat Jahan', role: 'Cashier' },
    { email: 'store@amarfood.com', name: 'Jamal Mia', role: 'Storekeeper' },
    { email: 'accounts@amarfood.com', name: 'Farhana Akter', role: 'Accountant' },
  ],
  categories: ['Rice & Grains', 'Oil & Ghee', 'Spices', 'Snacks', 'Raw Materials', 'Beverages'],
  products: [
    { name: 'Miniket Rice 5kg', category: 'Rice & Grains', unit: 'bag', cost: 360, price: 410, reorder: 20, stock: 120 },
    { name: 'Chinigura Aromatic Rice 1kg', category: 'Rice & Grains', unit: 'pack', cost: 135, price: 160, reorder: 30, stock: 150 },
    { name: 'Moshur Dal 1kg', category: 'Rice & Grains', unit: 'pack', cost: 118, price: 140, reorder: 30, stock: 140 },
    { name: 'Soybean Oil 5L', category: 'Oil & Ghee', unit: 'bottle', cost: 820, price: 905, reorder: 15, stock: 60 },
    { name: 'Mustard Oil 1L', category: 'Oil & Ghee', unit: 'bottle', cost: 245, price: 290, reorder: 20, stock: 80 },
    { name: 'Turmeric Powder 200g', category: 'Spices', unit: 'pack', cost: 62, price: 85, reorder: 40, stock: 200, vat: 5 },
    { name: 'Chili Powder 200g', category: 'Spices', unit: 'pack', cost: 70, price: 95, reorder: 40, stock: 180, vat: 5 },
    { name: 'Amar Chanachur 250g', category: 'Snacks', unit: 'pack', cost: 0, price: 60, reorder: 50, stock: 0, vat: 5 },
    { name: 'Gram Flour (Besan) 1kg', category: 'Raw Materials', unit: 'kg', cost: 95, price: 120, reorder: 50, stock: 300 },
    { name: 'Peanuts 1kg', category: 'Raw Materials', unit: 'kg', cost: 160, price: 190, reorder: 30, stock: 150 },
    { name: 'Packaging Pouch 250g', category: 'Raw Materials', unit: 'pcs', cost: 3, price: 5, reorder: 500, stock: 3000 },
    { name: 'Mango Juice 250ml', category: 'Beverages', unit: 'pcs', cost: 22, price: 30, reorder: 100, stock: 6, vat: 5 },
  ],
  customers: [
    { name: 'Rahman General Store', phone: '01711000201', creditLimit: 50000 },
    { name: 'Mollah Traders', phone: '01811000202', creditLimit: 80000 },
    { name: 'Shapla Super Shop', phone: '01911000203', creditLimit: 100000 },
    { name: 'Hasan Mudi Dokan', phone: '01611000204', creditLimit: 20000 },
    { name: 'Green Valley Restaurant', phone: '01511000205', creditLimit: 60000 },
  ],
  suppliers: [
    { name: 'Bogura Rice Mills', phone: '01711000301' },
    { name: 'Meghna Edible Oil Ltd.', phone: '01711000302' },
    { name: 'Chattogram Spice House', phone: '01711000303' },
  ],
  employees: [
    { name: 'Abdul Kader', designation: 'Production Supervisor', salary: 28000 },
    { name: 'Rokeya Begum', designation: 'Packing Operator', salary: 14000 },
    { name: 'Sumon Ahmed', designation: 'Delivery Driver', salary: 16000 },
    { name: 'Nasima Khatun', designation: 'Sales Executive', salary: 20000 },
  ],
  branches: [{ code: 'FAC', name: 'Tongi Factory', kind: 'factory' }],
};

const POWERCELL: DemoTenant = {
  name: 'PowerCell Battery Wholesale',
  slug: 'powercell',
  businessType: 'Electronics — battery wholesale',
  address: 'Shop 41, Patuatuli, Dhaka',
  phone: '+880 1811-222333',
  owner: { email: 'owner@powercell.com', name: 'Tanvir Islam' },
  staff: [{ email: 'cashier@powercell.com', name: 'Mitu Rani', role: 'Cashier' }],
  categories: ['IPS Batteries', 'Car Batteries', 'Small Batteries'],
  products: [
    { name: 'Hamko IPS Battery 130Ah', category: 'IPS Batteries', unit: 'pcs', cost: 14200, price: 15800, reorder: 3, stock: 12 },
    { name: 'Rimso Tubular 150Ah', category: 'IPS Batteries', unit: 'pcs', cost: 16500, price: 18200, reorder: 3, stock: 8 },
    { name: 'Volvo Car Battery 70Ah', category: 'Car Batteries', unit: 'pcs', cost: 7800, price: 8900, reorder: 2, stock: 0 },
    { name: 'AA Alkaline (4 pack)', category: 'Small Batteries', unit: 'pack', cost: 95, price: 130, reorder: 50, stock: 0 },
  ],
  customers: [{ name: 'Nur Electronics', phone: '01711999001', creditLimit: 200000 }],
  suppliers: [{ name: 'Rahimafrooz Distribution', phone: '01711999101' }],
  employees: [{ name: 'Babul Sheikh', designation: 'Showroom Assistant', salary: 15000 }],
  branches: [],
};

async function ensurePlatformAdmin(admin: pg.Client) {
  const email = (process.env.PLATFORM_ADMIN_EMAIL ?? 'platform@smarterp.local').toLowerCase();
  const password = process.env.PLATFORM_ADMIN_PASSWORD ?? 'ChangeMe!Platform1';
  const existing = await admin.query('SELECT id FROM users WHERE lower(email) = $1', [email]);
  if (existing.rowCount) return existing.rows[0].id as string;
  // Platform admins can only be created through the owner connection.
  const res = await admin.query(
    `INSERT INTO users (email, name, password_hash, is_platform_admin) VALUES ($1, 'Platform Administrator', $2, true) RETURNING id`,
    [email, await hashPassword(password)],
  );
  console.log(`Platform admin created: ${email}`);
  return res.rows[0].id as string;
}

function daysAgo(days: number, hour: number) {
  const d = new Date(Date.now() - days * 86400000);
  d.setUTCHours(hour - 6, between(0, 59), 0, 0); // hour in Asia/Dhaka (UTC+6)
  return d.toISOString();
}

async function seedTenant(platformAdminId: string, spec: DemoTenant) {
  const exists = await withPlatform(platformAdminId, (db) => db.maybe('SELECT id FROM tenants WHERE slug = $1', [spec.slug]));
  if (exists) {
    console.log(`Tenant ${spec.slug} already exists, skipping`);
    return;
  }
  const { tenant, ownerUserId } = await withPlatform(platformAdminId, (db) =>
    createTenant(db, { name: spec.name, slug: spec.slug, owner: { ...spec.owner, password: DEMO_PASSWORD } }),
  );
  const ctx: Ctx = {
    tenantId: tenant.id,
    userId: ownerUserId,
    userName: spec.owner.name,
    permissions: new Set(['*']),
    warehouseIds: null,
    ip: 'seed',
  };
  const tx = <T>(fn: (db: Db) => Promise<T>) => withTenant(ctx, fn);

  await tx(async (db) => {
    await db.exec(
      `UPDATE tenant_settings SET business_type = $1, address = $2, phone = $3, email = $4, default_vat_rate = 0`,
      [spec.businessType, spec.address, spec.phone, spec.owner.email],
    );
    const passwordHash = await hashPassword(DEMO_PASSWORD);
    for (const s of spec.staff) {
      const user = await db.one(
        `INSERT INTO users (email, name, password_hash) VALUES ($1, $2, $3)
         ON CONFLICT ((lower(email))) DO UPDATE SET name = EXCLUDED.name RETURNING id`,
        [s.email, s.name, passwordHash],
      );
      const role = await db.one(`SELECT id FROM roles WHERE name = $1`, [s.role]);
      await db.exec(`INSERT INTO memberships (user_id, role_id) VALUES ($1, $2)`, [user.id, role.id]);
    }
    for (const b of spec.branches) {
      await db.exec(`INSERT INTO warehouses (code, name, kind) VALUES ($1, $2, $3)`, [b.code, b.name, b.kind]);
    }
    for (const c of spec.categories) await db.exec(`INSERT INTO categories (name) VALUES ($1)`, [c]);
    let i = 0;
    for (const p of spec.products) {
      i++;
      await db.exec(
        `INSERT INTO products (sku, name, category_id, unit, sale_price, purchase_price, avg_cost, vat_rate, reorder_level, barcode)
         VALUES ($1, $2, (SELECT id FROM categories WHERE name = $3), $4, $5, $6, $6, $7, $8, $9)`,
        [`P-${String(i).padStart(5, '0')}`, p.name, p.category, p.unit, p.price, p.cost, p.vat ?? 0, p.reorder, `8901${String(1000 + i)}${spec.slug.length}`],
      );
    }
    for (const [n, c] of spec.customers.entries()) {
      await db.exec(`INSERT INTO customers (code, name, phone, credit_limit) VALUES ($1, $2, $3, $4)`, [
        `C-${String(n + 1).padStart(5, '0')}`, c.name, c.phone, c.creditLimit ?? null,
      ]);
    }
    await db.exec(`INSERT INTO counters (key, value) VALUES ('CUST', $1)`, [spec.customers.length]);
    await db.exec(`INSERT INTO counters (key, value) VALUES ('SKU', $1)`, [spec.products.length]);
    for (const [n, s] of spec.suppliers.entries()) {
      await db.exec(`INSERT INTO suppliers (code, name, phone) VALUES ($1, $2, $3)`, [`S-${String(n + 1).padStart(5, '0')}`, s.name, s.phone]);
    }
    await db.exec(`INSERT INTO counters (key, value) VALUES ('SUPP', $1)`, [spec.suppliers.length]);
    for (const [n, e] of spec.employees.entries()) {
      await db.exec(
        `INSERT INTO employees (code, name, designation, base_salary, join_date, phone) VALUES ($1, $2, $3, $4, app_tenant_today() - 400, $5)`,
        [`E-${String(n + 1).padStart(4, '0')}`, e.name, e.designation, e.salary, `0170000${1000 + n}`],
      );
    }
    await db.exec(`INSERT INTO counters (key, value) VALUES ('EMP', $1)`, [spec.employees.length]);

    // Owner's starting capital in cash and bank.
    const acc = await db.many(`SELECT system_key, id FROM accounts WHERE system_key IN ('CASH', 'BANK', 'EQUITY')`);
    const id = (k: string) => acc.find((a) => a.system_key === k).id;
    await postJournal(db, ctx, {
      date: (await db.one(`SELECT (app_tenant_today() - 95)::text AS d`)).d,
      memo: 'Owner capital introduced',
      refType: 'manual',
      lines: [
        { accountId: id('CASH'), debit: 150000 },
        { accountId: id('BANK'), debit: 850000 },
        { accountId: id('EQUITY'), credit: 1000000 },
      ],
    });
  });

  // Opening stock arrives as purchases from suppliers (one partly on credit).
  await tx(async (db) => {
    const products = await db.many(`SELECT id FROM products ORDER BY sku`);
    const suppliers = await db.many(`SELECT id FROM suppliers ORDER BY code`);
    const wh = await db.one(`SELECT id FROM warehouses WHERE is_default`);
    const bank = await db.one(`SELECT id FROM accounts WHERE system_key = 'BANK'`);
    const { d } = await db.one(`SELECT (app_tenant_today() - 90)::text AS d`);
    const items = spec.products
      .map((p, idx) => ({ productId: products[idx].id, qty: p.stock, unitCost: p.cost }))
      .filter((x) => x.qty > 0);
    for (const [i, supplier] of suppliers.entries()) {
      const chunk = items.filter((_, j) => j % suppliers.length === i);
      if (!chunk.length) continue;
      const total = chunk.reduce((s, x) => s + x.qty * x.unitCost, 0);
      await createPurchase(db, ctx, {
        supplierId: supplier.id,
        warehouseId: wh.id,
        purchaseDate: d,
        reference: `SUP-INV-${1001 + i}`,
        items: chunk,
        paidAmount: i === 0 ? Math.round(total * 0.6) : total,
        accountId: bank.id,
      });
    }
  });

  // Amar Food turns raw materials into its own chanachur.
  if (spec.slug === 'amar-food') {
    await tx(async (db) => {
      const id = async (name: string) => (await db.one(`SELECT id FROM products WHERE name = $1`, [name])).id;
      const wh = await db.one(`SELECT id FROM warehouses WHERE is_default`);
      const cash = await db.one(`SELECT id FROM accounts WHERE system_key = 'CASH'`);
      await postProduction(db, ctx, {
        warehouseId: wh.id,
        outputProductId: await id('Amar Chanachur 250g'),
        outputQty: 400,
        inputs: [
          { productId: await id('Gram Flour (Besan) 1kg'), qty: 60 },
          { productId: await id('Peanuts 1kg'), qty: 25 },
          { productId: await id('Packaging Pouch 250g'), qty: 400 },
        ],
        extraCost: 2500,
        accountId: cash.id,
        note: 'Batch #1 — labour and gas',
      });
    });
  }

  // ~3 months of sales history.
  const lookups = await tx(async (db) => ({
    products: await db.many(`SELECT id, sale_price, vat_rate FROM products WHERE avg_cost > 0 ORDER BY sku`),
    customers: await db.many(`SELECT id FROM customers ORDER BY code`),
    warehouse: await db.one(`SELECT id FROM warehouses WHERE is_default`),
    cash: await db.one(`SELECT id FROM accounts WHERE system_key = 'CASH'`),
    mobile: await db.one(`SELECT id FROM accounts WHERE system_key = 'MOBILE'`),
  }));
  const saleCount = spec.slug === 'amar-food' ? 70 : 12;
  for (let n = 0; n < saleCount; n++) {
    const daysBack = 88 - Math.floor((n / saleCount) * 88);
    const basket = [...new Map(Array.from({ length: between(1, 3) }, () => pick(lookups.products)).map((p) => [p.id, p])).values()];
    const items = basket.map((p) => ({ productId: p.id, qty: spec.slug === 'powercell' ? 1 : between(1, 4), discount: 0 }));
    const { total } = priceSale(
      basket.map((p, i) => ({ qty: items[i].qty, unitPrice: p.sale_price, discount: 0, vatRate: p.vat_rate })),
      0,
    );
    const customer = rand() < 0.65 ? pick(lookups.customers) : null;
    const onCredit = !!customer && rand() < 0.35;
    const paid = onCredit ? Math.floor(total * 0.4) : total;
    const account = rand() < 0.3 ? lookups.mobile.id : lookups.cash.id;
    try {
      await tx((db) =>
        createSale(db, ctx, {
          warehouseId: lookups.warehouse.id,
          customerId: customer?.id ?? null,
          items,
          discount: 0,
          payments: paid > 0 ? [{ accountId: account, amount: paid }] : [],
          note: null,
          saleDate: daysAgo(daysBack, between(10, 20)),
        }),
      );
    } catch {
      // Basket ran out of stock: skip it, as a cashier would.
    }
  }

  // Collect part of the outstanding dues.
  await tx(async (db) => {
    const dues = await db.many(
      `SELECT customer_id, sum(due_amount) AS due FROM sales WHERE due_amount > 0 GROUP BY customer_id LIMIT 2`,
    );
    const cash = await db.one(`SELECT id FROM accounts WHERE system_key = 'CASH'`);
    for (const d of dues) {
      await createCustomerPayment(db, ctx, { partyId: d.customer_id, accountId: cash.id, amount: Math.floor(d.due / 2), note: 'Partial payment' });
    }
  });

  await seedOperationsViaApi(spec);
  console.log(`Seeded ${spec.name} (${spec.slug})`);
}

/**
 * Running costs, a bank deposit, attendance and last month's payroll are
 * entered through the real HTTP API as the owner, exactly like a user would.
 */
async function seedOperationsViaApi(spec: DemoTenant) {
  const app = await buildApp({ logger: false });
  try {
    const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: spec.owner.email, password: DEMO_PASSWORD } });
    const cookie = login.cookies.find((c) => c.name === 'serp_session')!.value;
    const call = async (method: 'GET' | 'POST' | 'PUT', url: string, payload?: object) => {
      const res = await app.inject({ method, url, payload, cookies: { serp_session: cookie } });
      if (res.statusCode >= 300) throw new Error(`${method} ${url} failed: ${res.body}`);
      return res.json();
    };
    const lookups = await call('GET', '/api/lookups');
    const account = (key: string) => lookups.accounts.find((a: any) => a.system_key === key || a.name.startsWith(key)).id;
    const shift = (days: number) => {
      const d = new Date(`${lookups.settings.today}T00:00:00Z`);
      d.setUTCDate(d.getUTCDate() - days);
      return d.toISOString().slice(0, 10);
    };
    const thisMonth = lookups.settings.today.slice(0, 8);

    await call('POST', '/api/fund-transfers', { fromAccountId: account('CASH'), toAccountId: account('BANK'), amount: 40000, date: shift(20), reference: 'DEP-SLIP-0041' });
    const expenses: [string, number, string, number, string][] = [
      ['Rent', 25000, 'BANK', 40, 'Landlord — factory & shop'],
      ['Rent', 25000, 'BANK', 10, 'Landlord — factory & shop'],
      ['Utilities', 6200, 'CASH', 12, 'DESCO electricity bill'],
      ['Transport', 1800, 'CASH', 3, 'Delivery van fuel'],
      ['Office Supplies', 950, 'CASH', 2, 'Receipt paper rolls'],
    ];
    for (const [category, amount, from, daysBack, party] of expenses) {
      await call('POST', '/api/finance', {
        kind: 'expense', categoryAccountId: account(category), moneyAccountId: account(from), amount, date: shift(daysBack), party,
      });
    }

    const employees = (await call('GET', '/api/employees?pageSize=100')).rows;
    for (let back = 9; back >= 1; back--) {
      const date = shift(back);
      if (new Date(`${date}T00:00:00Z`).getUTCDay() === 5) continue; // Friday weekend
      await call('PUT', '/api/attendance', {
        date,
        records: employees.map((e: any) => {
          const r = rand();
          return { employeeId: e.id, status: r < 0.08 ? 'absent' : r < 0.18 ? 'late' : 'present', checkIn: r < 0.18 && r >= 0.08 ? '09:40' : '09:00', checkOut: '18:00' };
        }),
      });
    }

    // The day before the 1st of this month falls in last month.
    const lastMonth = shift(Number(lookups.settings.today.slice(8, 10))).slice(0, 7);
    const run = await call('POST', '/api/payroll/runs', { period: lastMonth, deductAbsences: true });
    await call('POST', `/api/payroll/runs/${run.id}/pay`, { accountId: account('BANK'), date: `${thisMonth}01` });
  } finally {
    await app.close();
  }
}

async function resetDatabase() {
  if (config.isProd) throw new Error('Refusing to reset a production database');
  const url = new URL(config.databaseAdminUrl);
  const dbName = url.pathname.slice(1);
  url.pathname = '/postgres';
  const c = new pg.Client({ connectionString: url.toString() });
  await c.connect();
  await c.query(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);
  await c.query(`CREATE DATABASE "${dbName}"`);
  await c.end();
  console.log(`Database ${dbName} recreated`);
}

async function main() {
  if (process.argv.includes('--reset')) await resetDatabase();
  await migrate();
  const admin = new pg.Client({ connectionString: config.databaseAdminUrl });
  await admin.connect();
  try {
    const platformAdminId = await ensurePlatformAdmin(admin);
    if (process.argv.includes('--admin-only')) return; // production: no demo businesses
    await seedTenant(platformAdminId, AMAR_FOOD);
    await seedTenant(platformAdminId, POWERCELL);
  } finally {
    await admin.end();
    await appPool.end();
  }
  console.log(`\nDemo logins (password: ${DEMO_PASSWORD})`);
  console.log('  owner@amarfood.com, manager@amarfood.com, cashier@amarfood.com, store@amarfood.com, accounts@amarfood.com');
  console.log('  owner@powercell.com, cashier@powercell.com');
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
