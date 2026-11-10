import { randomBytes } from 'node:crypto';
import pg from 'pg';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app';
import { withPlatform } from '../src/db/pool';
import { hashPassword } from '../src/lib/password';
import { createTenant } from '../src/services/tenants';
import { testUrls } from './urls';

export const PASSWORD = 'Test@12345';
export const uid = () => randomBytes(4).toString('hex');

export async function startApp() {
  return buildApp({ logger: false });
}

/** Superuser connection for assertions that must bypass RLS on purpose. */
export async function adminClient() {
  const c = new pg.Client({ connectionString: testUrls.admin });
  await c.connect();
  return c;
}

export async function makeTenant(label: string) {
  const slug = `${label}-${uid()}`;
  const ownerEmail = `owner@${slug}.test`;
  const { tenant } = await withPlatform(null, (db) =>
    createTenant(db, { name: `${label} ${slug}`, slug, owner: { email: ownerEmail, name: `${label} Owner`, password: PASSWORD } }),
  );
  return { id: tenant.id, slug, ownerEmail };
}

export async function makePlatformAdmin() {
  const email = `platform-${uid()}@smarterp.test`;
  const c = await adminClient();
  await c.query(`INSERT INTO users (email, name, password_hash, is_platform_admin) VALUES ($1, 'Platform', $2, true)`, [
    email, await hashPassword(PASSWORD),
  ]);
  await c.end();
  return email;
}

export interface Res<T = any> {
  status: number;
  body: T;
  text: string;
}

export class Client {
  constructor(
    private app: FastifyInstance,
    public token: string | null,
  ) {}

  async req<T = any>(method: string, url: string, payload?: unknown, headers: Record<string, string> = {}): Promise<Res<T>> {
    const res = await this.app.inject({
      method: method as any,
      url,
      payload: payload as any,
      headers: { ...(this.token ? { authorization: `Bearer ${this.token}` } : {}), ...headers },
    });
    let body: any = res.body;
    try {
      body = res.json();
    } catch {
      /* not JSON (CSV) */
    }
    return { status: res.statusCode, body, text: res.body };
  }

  get = <T = any>(url: string, headers?: Record<string, string>) => this.req<T>('GET', url, undefined, headers);
  post = <T = any>(url: string, body?: unknown, headers?: Record<string, string>) => this.req<T>('POST', url, body ?? {}, headers);
  put = <T = any>(url: string, body?: unknown) => this.req<T>('PUT', url, body ?? {});
  patch = <T = any>(url: string, body?: unknown) => this.req<T>('PATCH', url, body ?? {});
  del = <T = any>(url: string) => this.req<T>('DELETE', url);
}

export async function login(app: FastifyInstance, email: string, password = PASSWORD, tenant?: string) {
  const res = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email, password, tenant } });
  if (res.statusCode !== 200) throw new Error(`Login failed for ${email}: ${res.statusCode} ${res.body}`);
  return new Client(app, res.json().token);
}

/** Creates a product with opening stock in the default warehouse. */
export async function makeProduct(
  c: Client,
  opts: { name?: string; price?: number; cost?: number; qty?: number; vatRate?: number; reorderLevel?: number } = {},
) {
  const lookups = (await c.get('/api/lookups')).body;
  const warehouseId = lookups.warehouses[0].id;
  const res = await c.post('/api/products', {
    name: opts.name ?? `Product ${uid()}`,
    salePrice: opts.price ?? 100,
    purchasePrice: opts.cost ?? 60,
    vatRate: opts.vatRate ?? 0,
    reorderLevel: opts.reorderLevel ?? 0,
    openingStock: opts.qty ? { warehouseId, qty: opts.qty, unitCost: opts.cost ?? 60 } : null,
  });
  if (res.status !== 201) throw new Error(`Product creation failed: ${res.text}`);
  return { product: res.body, warehouseId, lookups };
}

export const moneyAccount = (lookups: any, key = 'CASH') => lookups.accounts.find((a: any) => a.system_key === key).id;
