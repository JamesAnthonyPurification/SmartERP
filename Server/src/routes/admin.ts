import type { FastifyInstance } from 'fastify';
import { Ctx, tenantRoutes } from '../auth/context';
import { ALL_PERMISSIONS, PERMISSIONS, WILDCARD } from '../auth/permissions';
import { Db, withSystem, withUser } from '../db/pool';
import { badRequest, conflict, forbidden, notFound } from '../lib/errors';
import { hashPassword, validatePasswordStrength } from '../lib/password';
import { likePattern, parse, z, zBool, zId, zOpt, zPaging } from '../lib/validate';
import { logActivity } from '../services/common';

const zPermissions = z.array(z.enum(ALL_PERMISSIONS as [string, ...string[]])).max(ALL_PERMISSIONS.length);

/** Prevents privilege escalation: you can only grant what you hold yourself. */
function assertCanGrant(ctx: Ctx, permissions: string[]) {
  if (ctx.permissions.has(WILDCARD)) return;
  const missing = permissions.filter((p) => p === WILDCARD || !ctx.permissions.has(p));
  if (missing.length) throw forbidden(`You cannot grant permissions you do not hold: ${missing.join(', ')}`);
}

async function loadRole(db: Db, roleId: string) {
  const role = await db.maybe<{ id: string; name: string; permissions: string[]; is_system: boolean }>(
    `SELECT id, name, permissions, is_system FROM roles WHERE id = $1`,
    [roleId],
  );
  if (!role) throw badRequest('Role not found');
  return role;
}

async function assertWarehouseIds(db: Db, ids: string[] | null | undefined) {
  if (!ids || !ids.length) return;
  const { n } = await db.one<{ n: number }>(`SELECT count(*) AS n FROM warehouses WHERE id = ANY($1::uuid[])`, [ids]);
  if (n !== new Set(ids).size) throw badRequest('One or more warehouses were not found');
}

const settingsSchema = z.object({
  companyName: z.string().trim().min(2).max(120),
  tagline: z.string().trim().max(120).default('POS & ERP Management'),
  businessType: zOpt(120),
  address: zOpt(300),
  phone: zOpt(60),
  email: zOpt(120),
  taxId: zOpt(60),
  currencySymbol: z.string().trim().min(1).max(5),
  currencyCode: z.string().trim().length(3).toUpperCase(),
  timezone: z.string().trim().min(1).max(60),
  defaultVatRate: z.coerce.number().min(0).max(100),
  invoicePrefix: z.string().trim().toUpperCase().regex(/^[A-Z0-9]{1,8}$/, 'Use 1-8 letters or digits'),
  receiptFooter: z.string().trim().max(300).default(''),
  allowNegativeStock: zBool.default(false),
});

export default async function adminRoutes(app: FastifyInstance) {
  const r = tenantRoutes(app);

  // ---- Lookups for forms ---------------------------------------------
  r.get('/api/lookups', null, async ({ db, ctx }) => {
    const warehouses = await db.many(
      `SELECT id, code, name, kind, is_default FROM warehouses WHERE is_active ORDER BY is_default DESC, name`,
    );
    return {
      warehouses: warehouses.map((w) => ({ ...w, allowed: !ctx.warehouseIds || ctx.warehouseIds.includes(w.id) })),
      categories: await db.many(`SELECT id, name FROM categories ORDER BY name`),
      accounts: await db.many(
        `SELECT id, code, name, type, is_money, money_kind, system_key FROM accounts WHERE is_active ORDER BY code`,
      ),
      settings: await db.one(
        `SELECT company_name, tagline, currency_symbol, currency_code, timezone, default_vat_rate, invoice_prefix,
                allow_negative_stock, receipt_footer, address, phone, email, tax_id, app_tenant_today()::text AS today
         FROM tenant_settings`,
      ),
    };
  });

  // ---- Settings -------------------------------------------------------
  r.get('/api/settings', null, ({ db }) => db.one(`SELECT * FROM tenant_settings`));

  r.put('/api/settings', 'settings.manage', async ({ db, ctx, body }) => {
    const s = parse(settingsSchema, body);
    const tzOk = await db.maybe(`SELECT 1 FROM pg_timezone_names WHERE name = $1`, [s.timezone]);
    if (!tzOk) throw badRequest('Unknown timezone');
    const row = await db.one(
      `UPDATE tenant_settings SET company_name = $1, tagline = $2, business_type = $3, address = $4, phone = $5,
         email = $6, tax_id = $7, currency_symbol = $8, currency_code = $9, timezone = $10, default_vat_rate = $11,
         invoice_prefix = $12, receipt_footer = $13, allow_negative_stock = $14, updated_at = now()
       RETURNING *`,
      [
        s.companyName, s.tagline, s.businessType, s.address, s.phone, s.email, s.taxId, s.currencySymbol,
        s.currencyCode, s.timezone, s.defaultVatRate, s.invoicePrefix, s.receiptFooter, s.allowNegativeStock,
      ],
    );
    await logActivity(db, ctx, 'settings.update', 'Business settings updated', { entity: 'settings' });
    return row;
  });

  // ---- Roles ----------------------------------------------------------
  r.get('/api/permissions', 'users.manage', async () =>
    Object.entries(PERMISSIONS).map(([key, label]) => ({ key, label })),
  );

  r.get('/api/roles', 'users.manage', ({ db }) =>
    db.many(
      `SELECT r.id, r.name, r.description, r.permissions, r.is_system,
              (SELECT count(*) FROM memberships m WHERE m.role_id = r.id) AS member_count
       FROM roles r ORDER BY r.is_system DESC, r.name`,
    ),
  );

  const roleSchema = z.object({
    name: z.string().trim().min(2).max(60),
    description: zOpt(200),
    permissions: zPermissions,
  });

  r.post('/api/roles', 'users.manage', async ({ db, ctx, body, reply }) => {
    const b = parse(roleSchema, body);
    assertCanGrant(ctx, b.permissions);
    const row = await db.one(
      `INSERT INTO roles (name, description, permissions) VALUES ($1, $2, $3) RETURNING *`,
      [b.name, b.description, b.permissions],
    );
    await logActivity(db, ctx, 'role.create', `Role ${b.name} created`, { entity: 'role', entityId: row.id });
    reply.code(201);
    return row;
  });

  r.patch('/api/roles/:id', 'users.manage', async ({ db, ctx, body, params }) => {
    const { id } = parse(z.object({ id: zId }), params);
    const b = parse(roleSchema.partial(), body);
    const role = await loadRole(db, id);
    if (role.permissions.includes(WILDCARD)) throw forbidden('The Owner role cannot be modified');
    if (b.permissions) assertCanGrant(ctx, b.permissions);
    const row = await db.one(
      `UPDATE roles SET name = COALESCE($2, name), description = COALESCE($3, description),
         permissions = COALESCE($4, permissions) WHERE id = $1 RETURNING *`,
      [id, b.name ?? null, b.description ?? null, b.permissions ?? null],
    );
    await logActivity(db, ctx, 'role.update', `Role ${row.name} updated`, { entity: 'role', entityId: id, details: b });
    return row;
  });

  r.del('/api/roles/:id', 'users.manage', async ({ db, ctx, params }) => {
    const { id } = parse(z.object({ id: zId }), params);
    const role = await loadRole(db, id);
    if (role.is_system) throw forbidden('Built-in roles cannot be deleted');
    const inUse = await db.maybe(`SELECT 1 FROM memberships WHERE role_id = $1 LIMIT 1`, [id]);
    if (inUse) throw conflict('Role is assigned to users');
    await db.exec(`DELETE FROM roles WHERE id = $1`, [id]);
    await logActivity(db, ctx, 'role.delete', `Role ${role.name} deleted`, { entity: 'role', entityId: id });
    return { ok: true };
  });

  // ---- Users (memberships of this tenant) ------------------------------
  r.get('/api/users', 'users.manage', ({ db }) =>
    db.many(
      `SELECT m.id, m.user_id, m.is_active, m.warehouse_ids, m.created_at, u.email, u.name, u.last_login_at,
              r.id AS role_id, r.name AS role_name
       FROM memberships m
       JOIN users u ON u.id = m.user_id
       JOIN roles r ON r.tenant_id = m.tenant_id AND r.id = m.role_id
       ORDER BY u.name`,
    ),
  );

  r.post('/api/users', 'users.manage', async ({ db, ctx, body, reply }) => {
    const b = parse(
      z.object({
        email: z.string().trim().toLowerCase().email().max(200),
        name: z.string().trim().min(2).max(120),
        password: z.string().max(200).optional().nullable(),
        roleId: zId,
        warehouseIds: z.array(zId).max(100).nullable().optional(),
      }),
      body,
    );
    const role = await loadRole(db, b.roleId);
    assertCanGrant(ctx, role.permissions);
    await assertWarehouseIds(db, b.warehouseIds);

    let user = await db.maybe<{ id: string }>(`SELECT id FROM users WHERE lower(email) = $1`, [b.email]);
    if (!user) {
      if (!b.password) throw badRequest('Set an initial password for the new user');
      const weak = validatePasswordStrength(b.password);
      if (weak) throw badRequest(weak);
      user = await db.one(`INSERT INTO users (email, name, password_hash) VALUES ($1, $2, $3) RETURNING id`, [
        b.email, b.name, await hashPassword(b.password),
      ]);
    }
    const m = await db.one(
      `INSERT INTO memberships (user_id, role_id, warehouse_ids) VALUES ($1, $2, $3) RETURNING id`,
      [user!.id, b.roleId, b.warehouseIds?.length ? b.warehouseIds : null],
    );
    await logActivity(db, ctx, 'user.add', `${b.email} added as ${role.name}`, { entity: 'membership', entityId: m.id });
    reply.code(201);
    return m;
  });

  r.patch('/api/users/:id', 'users.manage', async ({ db, ctx, body, params }) => {
    const { id } = parse(z.object({ id: zId }), params);
    const b = parse(
      z.object({
        roleId: zId.optional(),
        isActive: zBool.optional(),
        warehouseIds: z.array(zId).max(100).nullable().optional(),
      }),
      body,
    );
    const m = await db.maybe(`SELECT id, user_id, role_id FROM memberships WHERE id = $1`, [id]);
    if (!m) throw notFound('User');
    if (m.user_id === ctx.userId) throw forbidden('You cannot change your own access');
    const current = await loadRole(db, m.role_id);
    assertCanGrant(ctx, current.permissions);
    if (b.roleId) assertCanGrant(ctx, (await loadRole(db, b.roleId)).permissions);
    await assertWarehouseIds(db, b.warehouseIds);

    const row = await db.one(
      `UPDATE memberships SET role_id = COALESCE($2, role_id), is_active = COALESCE($3, is_active),
         warehouse_ids = CASE WHEN $4::boolean THEN $5::uuid[] ELSE warehouse_ids END
       WHERE id = $1 RETURNING id, user_id, role_id, is_active, warehouse_ids`,
      [id, b.roleId ?? null, b.isActive ?? null, b.warehouseIds !== undefined, b.warehouseIds?.length ? b.warehouseIds : null],
    );
    if (b.isActive === false) {
      await withSystem((sys) =>
        sys.exec(`UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND tenant_id = $2 AND revoked_at IS NULL`, [
          m.user_id, ctx.tenantId,
        ]),
      );
    }
    await logActivity(db, ctx, 'user.update', 'User access updated', { entity: 'membership', entityId: id, details: b });
    return row;
  });

  /**
   * A password belongs to the global identity, so a tenant admin may reset it
   * only for users who belong exclusively to this tenant.
   */
  r.post('/api/users/:id/reset-password', 'users.manage', async ({ db, ctx, body, params }) => {
    const { id } = parse(z.object({ id: zId }), params);
    const { password } = parse(z.object({ password: z.string().max(200) }), body);
    const weak = validatePasswordStrength(password);
    if (weak) throw badRequest(weak);
    const m = await db.maybe(`SELECT user_id, role_id FROM memberships WHERE id = $1`, [id]);
    if (!m) throw notFound('User');
    assertCanGrant(ctx, (await loadRole(db, m.role_id)).permissions);
    const { n } = await withUser(m.user_id, (u) =>
      u.one<{ n: number }>(`SELECT count(*) AS n FROM memberships WHERE user_id = $1`, [m.user_id]),
    );
    const target = await db.one(`SELECT is_platform_admin FROM users WHERE id = $1`, [m.user_id]);
    if (n > 1 || target.is_platform_admin) {
      throw forbidden('This user also belongs to other businesses; they must change their own password');
    }
    const hash = await hashPassword(password);
    await withSystem(async (sys) => {
      await sys.exec(`UPDATE users SET password_hash = $2 WHERE id = $1`, [m.user_id, hash]);
      await sys.exec(`UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL`, [m.user_id]);
    });
    await logActivity(db, ctx, 'user.reset_password', 'User password reset', { entity: 'membership', entityId: id });
    return { ok: true };
  });

  // ---- Activity log & notifications ----------------------------------
  r.get('/api/activity', 'audit.view', async ({ db, query }) => {
    const q = parse(zPaging.extend({ action: z.string().max(60).optional() }), query);
    const rows = await db.many(
      `SELECT a.id, a.action, a.entity, a.entity_id, a.summary, a.details, a.ip, a.created_at, u.name AS user_name,
              count(*) OVER () AS total_count
       FROM activity_logs a LEFT JOIN users u ON u.id = a.user_id
       WHERE ($1::text IS NULL OR a.summary ILIKE $1 OR a.action ILIKE $1) AND ($2::text IS NULL OR a.action LIKE $2 || '%')
       ORDER BY a.created_at DESC LIMIT $3 OFFSET $4`,
      [likePattern(q.q), q.action ?? null, q.pageSize, (q.page - 1) * q.pageSize],
    );
    return { rows, total: rows[0]?.total_count ?? 0 };
  });

  r.get('/api/notifications', null, ({ db }) =>
    db.many(`SELECT id, kind, title, body, created_at, read_at FROM notifications ORDER BY created_at DESC LIMIT 50`),
  );

  r.post('/api/notifications/read-all', null, async ({ db }) => {
    await db.exec(`UPDATE notifications SET read_at = now() WHERE read_at IS NULL`);
    return { ok: true };
  });
}
