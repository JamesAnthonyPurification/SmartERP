import type { FastifyInstance } from 'fastify';
import { requirePlatform } from '../auth/context';
import { Db, withPlatform } from '../db/pool';
import { notFound } from '../lib/errors';
import { parse, z, zId } from '../lib/validate';
import { createTenant } from '../services/tenants';

const zSlug = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z0-9][a-z0-9-]{1,48}[a-z0-9]$/, 'Use 3-50 lowercase letters, digits or dashes');

async function audit(db: Db, actor: string, action: string, tenantId: string | null, details: object, ip: string) {
  await db.exec(
    `INSERT INTO platform_audit_log (actor_user_id, action, target_tenant_id, details, ip) VALUES ($1, $2, $3, $4, $5)`,
    [actor, action, tenantId, details, ip],
  );
}

/**
 * Platform administration. Runs with app.platform = on, which unlocks the
 * tenants table only; tenant business data stays behind RLS.
 */
export default async function platformRoutes(app: FastifyInstance) {
  app.get('/api/platform/tenants', async (req) => {
    const auth = requirePlatform(req);
    return withPlatform(auth.userId, (db) =>
      db.many(`SELECT id, name, slug, contact_email, status, created_at FROM tenants ORDER BY created_at`),
    );
  });

  app.post('/api/platform/tenants', async (req, reply) => {
    const auth = requirePlatform(req);
    const body = parse(
      z.object({
        name: z.string().trim().min(2).max(120),
        slug: zSlug,
        ownerEmail: z.string().trim().toLowerCase().email(),
        ownerName: z.string().trim().min(2).max(120),
        ownerPassword: z.string().max(200).optional().nullable(),
      }),
      req.body,
    );
    const result = await withPlatform(auth.userId, async (db) => {
      const r = await createTenant(db, {
        name: body.name,
        slug: body.slug,
        owner: { email: body.ownerEmail, name: body.ownerName, password: body.ownerPassword },
      });
      await audit(db, auth.userId, 'tenant.create', r.tenant.id, { name: body.name, slug: body.slug, owner: body.ownerEmail }, req.ip);
      return r.tenant;
    });
    reply.code(201);
    return result;
  });

  app.patch('/api/platform/tenants/:id', async (req) => {
    const auth = requirePlatform(req);
    const { id } = parse(z.object({ id: zId }), req.params);
    const body = parse(
      z.object({ status: z.enum(['active', 'suspended']).optional(), name: z.string().trim().min(2).max(120).optional() }),
      req.body,
    );
    return withPlatform(auth.userId, async (db) => {
      const row = await db.maybe(
        `UPDATE tenants SET status = COALESCE($2, status), name = COALESCE($3, name), updated_at = now()
         WHERE id = $1 RETURNING id, name, slug, contact_email, status, created_at`,
        [id, body.status ?? null, body.name ?? null],
      );
      if (!row) throw notFound('Business');
      await audit(db, auth.userId, 'tenant.update', id, body, req.ip);
      return row;
    });
  });

  app.get('/api/platform/audit', async (req) => {
    const auth = requirePlatform(req);
    return withPlatform(auth.userId, (db) =>
      db.many(
        `SELECT a.id, a.action, a.details, a.ip, a.created_at, u.email AS actor_email, t.name AS tenant_name
         FROM platform_audit_log a
         LEFT JOIN users u ON u.id = a.actor_user_id
         LEFT JOIN tenants t ON t.id = a.target_tenant_id
         ORDER BY a.created_at DESC LIMIT 200`,
      ),
    );
  });
}
