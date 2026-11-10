import { createHash, randomBytes } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest, HTTPMethods } from 'fastify';
import { config } from '../config';
import { Db, transaction, withTenant } from '../db/pool';
import { forbidden, unauthorized } from '../lib/errors';
import { hasPermission, Permission } from './permissions';

export const SESSION_COOKIE = 'serp_session';

export interface TenantAccess {
  id: string;
  name: string;
  slug: string;
  status: 'active' | 'suspended';
  membershipId: string;
  roleId: string;
  roleName: string;
  permissions: string[];
  warehouseIds: string[] | null;
  companyName: string;
  tagline: string;
  currencySymbol: string;
}

export interface AuthInfo {
  sessionId: string;
  userId: string;
  email: string;
  name: string;
  isPlatformAdmin: boolean;
  tenant: TenantAccess | null;
}

/** The validated tenant context handed to every tenant-scoped handler. */
export interface Ctx {
  tenantId: string;
  userId: string;
  userName: string;
  permissions: Set<string>;
  warehouseIds: string[] | null;
  ip: string;
}

declare module 'fastify' {
  interface FastifyRequest {
    auth: AuthInfo | null;
  }
}

export const hashToken = (token: string) => createHash('sha256').update(token).digest('hex');

export async function createSession(db: Db, userId: string, tenantId: string | null, req: FastifyRequest) {
  const token = randomBytes(32).toString('base64url');
  await db.exec(
    `INSERT INTO sessions (token_hash, user_id, tenant_id, expires_at, ip, user_agent)
     VALUES ($1, $2, $3, now() + make_interval(hours => $4::int), $5, $6)`,
    [hashToken(token), userId, tenantId, config.sessionTtlHours, req.ip, String(req.headers['user-agent'] ?? '').slice(0, 300)],
  );
  return token;
}

export function setSessionCookie(reply: FastifyReply, token: string) {
  reply.setCookie(SESSION_COOKIE, token, {
    path: '/',
    httpOnly: true,
    sameSite: 'lax',
    secure: config.cookieSecure,
    maxAge: config.sessionTtlHours * 3600,
  });
}

export function clearSessionCookie(reply: FastifyReply) {
  reply.clearCookie(SESSION_COOKIE, { path: '/' });
}

export function readToken(req: FastifyRequest): string | null {
  const cookie = req.cookies?.[SESSION_COOKIE];
  if (cookie) return cookie;
  const header = req.headers.authorization;
  if (header?.startsWith('Bearer ')) return header.slice(7).trim() || null;
  return null;
}

/**
 * Resolves the session and, if one is selected, the tenant membership.
 * The tenant comes only from the server-side session row, which is written
 * after membership validation; nothing the client sends can change it.
 */
export async function loadAuth(req: FastifyRequest): Promise<AuthInfo | null> {
  const token = readToken(req);
  if (!token || token.length > 200) return null;
  return authFromToken(token);
}

export async function authFromToken(token: string): Promise<AuthInfo | null> {
  return transaction({}, async (db) => {
    const s = await db.maybe(
      `SELECT s.id, s.user_id, s.tenant_id, s.last_seen_at < now() - interval '5 minutes' AS stale,
              u.email, u.name, u.is_platform_admin
       FROM sessions s JOIN users u ON u.id = s.user_id
       WHERE s.token_hash = $1 AND s.revoked_at IS NULL AND s.expires_at > now() AND u.is_active`,
      [hashToken(token)],
    );
    if (!s) return null;
    if (s.stale) {
      await db.exec(
        `UPDATE sessions SET last_seen_at = now(), expires_at = now() + make_interval(hours => $2::int) WHERE id = $1`,
        [s.id, config.sessionTtlHours],
      );
    }

    let tenant: TenantAccess | null = null;
    if (s.tenant_id) {
      await db.client.query(`SELECT set_config('app.tenant_id', $1, true), set_config('app.user_id', $2, true)`, [
        s.tenant_id,
        s.user_id,
      ]);
      const m = await db.maybe(
        `SELECT m.id AS membership_id, m.warehouse_ids, r.id AS role_id, r.name AS role_name, r.permissions,
                t.id, t.name, t.slug, t.status, ts.company_name, ts.tagline, ts.currency_symbol
         FROM memberships m
         JOIN roles r ON r.tenant_id = m.tenant_id AND r.id = m.role_id
         JOIN tenants t ON t.id = m.tenant_id
         LEFT JOIN tenant_settings ts ON ts.tenant_id = m.tenant_id
         WHERE m.user_id = $1 AND m.tenant_id = $2 AND m.is_active`,
        [s.user_id, s.tenant_id],
      );
      if (m) {
        tenant = {
          id: m.id,
          name: m.name,
          slug: m.slug,
          status: m.status,
          membershipId: m.membership_id,
          roleId: m.role_id,
          roleName: m.role_name,
          permissions: m.permissions,
          warehouseIds: m.warehouse_ids,
          companyName: m.company_name ?? m.name,
          tagline: m.tagline ?? 'POS & ERP Management',
          currencySymbol: m.currency_symbol ?? '৳',
        };
      }
    }

    return {
      sessionId: s.id,
      userId: s.user_id,
      email: s.email,
      name: s.name,
      isPlatformAdmin: s.is_platform_admin,
      tenant,
    };
  });
}

export function requireAuth(req: FastifyRequest): AuthInfo {
  if (!req.auth) throw unauthorized();
  return req.auth;
}

export function requirePlatform(req: FastifyRequest): AuthInfo {
  const auth = requireAuth(req);
  if (!auth.isPlatformAdmin) throw forbidden('Platform administrator access required');
  return auth;
}

/** Authenticates, resolves the authorized tenant and checks permissions. */
export function requireTenant(req: FastifyRequest, perm: Permission | Permission[] | null): Ctx {
  const auth = requireAuth(req);
  const t = auth.tenant;
  if (!t) throw forbidden('No business is selected for this session');
  if (t.status !== 'active') throw forbidden('This business account is suspended. Contact SmartERP support.');
  const permissions = new Set(t.permissions);
  if (perm) {
    const needed = Array.isArray(perm) ? perm : [perm];
    if (!needed.some((p) => hasPermission(permissions, p))) throw forbidden();
  }
  return {
    tenantId: t.id,
    userId: auth.userId,
    userName: auth.name,
    permissions,
    warehouseIds: t.warehouseIds,
    ip: req.ip,
  };
}

export const can = (ctx: Ctx, perm: Permission) => hasPermission(ctx.permissions, perm);

export function assertWarehouseAccess(ctx: Ctx, warehouseId: string) {
  if (ctx.warehouseIds && !ctx.warehouseIds.includes(warehouseId)) {
    throw forbidden('You are not assigned to this warehouse or branch');
  }
}

export interface HandlerArgs {
  ctx: Ctx;
  db: Db;
  req: FastifyRequest;
  reply: FastifyReply;
  body: any;
  query: any;
  params: any;
}

type Handler = (args: HandlerArgs) => Promise<unknown>;

/**
 * The only way business modules register routes. Each request is
 * authenticated, permission-checked and executed inside a transaction whose
 * RLS context is the session's validated tenant.
 */
export function tenantRoutes(app: FastifyInstance) {
  const add = (method: HTTPMethods) => (url: string, perm: Permission | Permission[] | null, handler: Handler) =>
    app.route({
      method,
      url,
      handler: async (req, reply) => {
        const ctx = requireTenant(req, perm);
        return withTenant(ctx, (db) =>
          handler({ ctx, db, req, reply, body: req.body ?? {}, query: req.query ?? {}, params: req.params ?? {} }),
        );
      },
    });
  return { get: add('GET'), post: add('POST'), put: add('PUT'), patch: add('PATCH'), del: add('DELETE') };
}
