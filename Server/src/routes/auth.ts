import type { FastifyInstance, FastifyRequest } from 'fastify';
import {
  AuthInfo, authFromToken, clearSessionCookie, createSession, readToken, requireAuth, setSessionCookie,
} from '../auth/context';
import { config } from '../config';
import { Db, withSystem, withTenant, withUser } from '../db/pool';
import { badRequest, forbidden, unauthorized } from '../lib/errors';
import { DUMMY_HASH, hashPassword, validatePasswordStrength, verifyPassword } from '../lib/password';
import { parse, z, zId } from '../lib/validate';

async function recordAuthEvent(
  db: Db,
  req: FastifyRequest,
  event: string,
  data: { email?: string; userId?: string | null; tenantId?: string | null },
) {
  await db.exec(
    `INSERT INTO auth_events (event, email, user_id, tenant_id, ip, user_agent) VALUES ($1, $2, $3, $4, $5, $6)`,
    [event, data.email ?? null, data.userId ?? null, data.tenantId ?? null, req.ip, String(req.headers['user-agent'] ?? '').slice(0, 300)],
  );
}

async function tenantActivity(tenantId: string, userId: string, ip: string, action: string, summary: string) {
  await withTenant({ tenantId, userId }, (db) =>
    db.exec(`INSERT INTO activity_logs (user_id, action, entity, summary, ip) VALUES ($1, $2, 'auth', $3, $4)`, [
      userId, action, summary, ip,
    ]),
  );
}

/** The user's own memberships, readable only while no tenant is selected. */
export function listMemberships(userId: string) {
  return withUser(userId, (db) =>
    db.many<{ id: string; name: string; slug: string; status: string }>(
      `SELECT t.id, t.name, t.slug, t.status
       FROM memberships m JOIN tenants t ON t.id = m.tenant_id
       WHERE m.user_id = $1 AND m.is_active ORDER BY t.name`,
      [userId],
    ),
  );
}

export async function buildMe(auth: AuthInfo) {
  const t = auth.tenant;
  return {
    user: { id: auth.userId, email: auth.email, name: auth.name, isPlatformAdmin: auth.isPlatformAdmin },
    tenant: t && {
      id: t.id,
      name: t.name,
      slug: t.slug,
      status: t.status,
      companyName: t.companyName,
      tagline: t.tagline,
      currencySymbol: t.currencySymbol,
      roleName: t.roleName,
      permissions: t.permissions,
      warehouseIds: t.warehouseIds,
    },
    memberships: await listMemberships(auth.userId),
  };
}

export default async function authRoutes(app: FastifyInstance) {
  app.post(
    '/api/auth/login',
    { config: { rateLimit: { max: config.loginRateLimit, timeWindow: '1 minute' } } },
    async (req, reply) => {
      const body = parse(
        z.object({
          email: z.string().trim().toLowerCase().email().max(200),
          password: z.string().min(1).max(200),
          tenant: z.string().trim().toLowerCase().max(60).optional(),
        }),
        req.body,
      );

      const user = await withSystem((db) =>
        db.maybe(`SELECT id, name, password_hash, is_active, is_platform_admin FROM users WHERE lower(email) = $1`, [body.email]),
      );
      const ok = await verifyPassword(body.password, user?.password_hash ?? DUMMY_HASH);
      if (!user || !ok || !user.is_active) {
        await withSystem((db) => recordAuthEvent(db, req, 'login_failed', { email: body.email, userId: user?.id }));
        throw unauthorized('Invalid email or password');
      }

      const memberships = await listMemberships(user.id);
      let tenantId: string | null = null;
      if (body.tenant) {
        const m = memberships.find((x) => x.slug === body.tenant);
        if (!m) throw unauthorized('You are not a member of that business');
        if (m.status !== 'active') throw forbidden('This business account is suspended');
        tenantId = m.id;
      } else {
        tenantId = memberships.find((m) => m.status === 'active')?.id ?? null;
      }
      if (!tenantId && !user.is_platform_admin) {
        throw forbidden(
          memberships.length ? 'Your business account is suspended' : 'Your account is not linked to any business',
        );
      }

      const token = await withSystem(async (db) => {
        const t = await createSession(db, user.id, tenantId, req);
        await db.exec(`UPDATE users SET last_login_at = now() WHERE id = $1`, [user.id]);
        await recordAuthEvent(db, req, 'login_success', { email: body.email, userId: user.id, tenantId });
        return t;
      });
      if (tenantId) await tenantActivity(tenantId, user.id, req.ip, 'auth.login', `${user.name} signed in`);
      setSessionCookie(reply, token);
      const auth = await authFromToken(token);
      return { ...(await buildMe(auth!)), token: config.isTest ? token : undefined };
    },
  );

  app.post('/api/auth/logout', async (req, reply) => {
    if (req.auth) {
      await withSystem((db) => db.exec(`UPDATE sessions SET revoked_at = now() WHERE id = $1`, [req.auth!.sessionId]));
    }
    clearSessionCookie(reply);
    return { ok: true };
  });

  app.get('/api/auth/me', async (req) => buildMe(requireAuth(req)));

  // The requested tenant is never trusted: membership is re-validated server-side.
  app.post('/api/auth/switch-tenant', async (req) => {
    const auth = requireAuth(req);
    const { tenantId } = parse(z.object({ tenantId: zId }), req.body);
    const memberships = await listMemberships(auth.userId);
    const target = memberships.find((m) => m.id === tenantId);
    if (!target) {
      await withSystem((db) => recordAuthEvent(db, req, 'tenant_switch_denied', { userId: auth.userId, tenantId: null }));
      throw forbidden('You are not a member of that business');
    }
    if (target.status !== 'active') throw forbidden('This business account is suspended');
    await withSystem((db) => db.exec(`UPDATE sessions SET tenant_id = $2 WHERE id = $1`, [auth.sessionId, tenantId]));
    await tenantActivity(tenantId, auth.userId, req.ip, 'auth.switch', `${auth.name} switched into this business`);
    const fresh = await authFromToken(readToken(req)!);
    return buildMe(fresh!);
  });

  app.post('/api/auth/change-password', async (req) => {
    const auth = requireAuth(req);
    const body = parse(z.object({ currentPassword: z.string().min(1).max(200), newPassword: z.string().max(200) }), req.body);
    const weak = validatePasswordStrength(body.newPassword);
    if (weak) throw badRequest(weak);
    await withSystem(async (db) => {
      const u = await db.one(`SELECT password_hash FROM users WHERE id = $1`, [auth.userId]);
      if (!(await verifyPassword(body.currentPassword, u.password_hash))) throw badRequest('Current password is incorrect');
      await db.exec(`UPDATE users SET password_hash = $2 WHERE id = $1`, [auth.userId, await hashPassword(body.newPassword)]);
      await db.exec(`UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND id <> $2 AND revoked_at IS NULL`, [
        auth.userId, auth.sessionId,
      ]);
      await recordAuthEvent(db, req, 'password_changed', { userId: auth.userId });
    });
    return { ok: true };
  });
}
