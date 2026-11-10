import { SYSTEM_ROLES } from '../auth/permissions';
import type { Db } from '../db/pool';
import { badRequest } from '../lib/errors';
import { hashPassword, validatePasswordStrength } from '../lib/password';
import { seedAccounts } from './ledger';

export interface CreateTenantInput {
  name: string;
  slug: string;
  contactEmail?: string | null;
  owner: { email: string; name: string; password?: string | null };
}

/**
 * Provisions a tenant atomically. Must run in a platform transaction
 * (withPlatform): the tenants row requires the platform context, and every
 * default record is written under the new tenant's own RLS context.
 */
export async function createTenant(db: Db, input: CreateTenantInput) {
  const tenant = await db.one<{ id: string; name: string; slug: string; status: string; created_at: string }>(
    `INSERT INTO tenants (name, slug, contact_email) VALUES ($1, $2, $3)
     RETURNING id, name, slug, status, created_at`,
    [input.name, input.slug, input.contactEmail ?? input.owner.email],
  );
  await db.setTenant(tenant.id);

  let owner = await db.maybe<{ id: string }>(`SELECT id FROM users WHERE lower(email) = lower($1)`, [input.owner.email]);
  if (!owner) {
    if (!input.owner.password) throw badRequest('A password is required for a new owner account');
    const weak = validatePasswordStrength(input.owner.password);
    if (weak) throw badRequest(weak);
    owner = await db.one(`INSERT INTO users (email, name, password_hash) VALUES ($1, $2, $3) RETURNING id`, [
      input.owner.email.toLowerCase(),
      input.owner.name,
      await hashPassword(input.owner.password),
    ]);
  }

  await db.exec(`INSERT INTO tenant_settings (company_name) VALUES ($1)`, [input.name]);

  let ownerRoleId = '';
  for (const role of SYSTEM_ROLES) {
    const r = await db.one<{ id: string }>(
      `INSERT INTO roles (name, description, permissions, is_system) VALUES ($1, $2, $3, true) RETURNING id`,
      [role.name, role.description, role.permissions],
    );
    if (role.name === 'Owner') ownerRoleId = r.id;
  }
  await db.exec(`INSERT INTO memberships (user_id, role_id) VALUES ($1, $2)`, [owner!.id, ownerRoleId]);
  await db.exec(
    `INSERT INTO warehouses (code, name, kind, is_default) VALUES ('MAIN', 'Main Store', 'branch', true)`,
  );
  await seedAccounts(db);

  return { tenant, ownerUserId: owner!.id };
}
