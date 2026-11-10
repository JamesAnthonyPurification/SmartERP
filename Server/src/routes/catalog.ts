import type { FastifyInstance } from 'fastify';
import { tenantRoutes } from '../auth/context';
import { conflict, notFound } from '../lib/errors';
import { likePattern, parse, z, zBool, zId, zMoney, zOpt, zOptId, zPaging } from '../lib/validate';
import { logActivity, nextNumber } from '../services/common';
import { createAdjustment } from '../services/inventory';

const productSchema = z.object({
  sku: zOpt(60),
  barcode: zOpt(60),
  name: z.string().trim().min(1).max(200),
  description: zOpt(1000),
  unit: z.string().trim().min(1).max(20).default('pcs'),
  categoryId: zOptId,
  salePrice: zMoney,
  purchasePrice: zMoney.default(0),
  vatRate: z.coerce.number().min(0).max(100).default(0),
  reorderLevel: z.coerce.number().min(0).max(1e9).default(0),
  isActive: zBool.default(true),
});

const warehouseSchema = z.object({
  code: z.string().trim().toUpperCase().min(1).max(20),
  name: z.string().trim().min(2).max(120),
  kind: z.enum(['warehouse', 'branch', 'outlet', 'factory']).default('branch'),
  address: zOpt(300),
  phone: zOpt(60),
  isActive: zBool.default(true),
  isDefault: zBool.default(false),
});

export default async function catalogRoutes(app: FastifyInstance) {
  const r = tenantRoutes(app);

  // ---- Warehouses / branches ------------------------------------------
  r.get('/api/warehouses', ['inventory.view', 'warehouses.manage'], ({ db }) =>
    db.many(
      `SELECT w.*, COALESCE(s.units, 0) AS units, COALESCE(s.value, 0) AS stock_value, COALESCE(s.products, 0) AS products
       FROM warehouses w
       LEFT JOIN (
         SELECT sl.warehouse_id, sum(sl.qty) FILTER (WHERE sl.qty > 0) AS units,
                round(sum(GREATEST(sl.qty, 0) * p.avg_cost), 2) AS value, count(*) FILTER (WHERE sl.qty > 0) AS products
         FROM stock_levels sl JOIN products p ON p.id = sl.product_id GROUP BY sl.warehouse_id
       ) s ON s.warehouse_id = w.id
       ORDER BY w.is_default DESC, w.name`,
    ),
  );

  r.post('/api/warehouses', 'warehouses.manage', async ({ db, ctx, body, reply }) => {
    const b = parse(warehouseSchema, body);
    if (b.isDefault) await db.exec(`UPDATE warehouses SET is_default = false WHERE is_default`);
    const row = await db.one(
      `INSERT INTO warehouses (code, name, kind, address, phone, is_active, is_default)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
      [b.code, b.name, b.kind, b.address, b.phone, b.isActive, b.isDefault],
    );
    await logActivity(db, ctx, 'warehouse.create', `Warehouse ${b.name} created`, { entity: 'warehouse', entityId: row.id });
    reply.code(201);
    return row;
  });

  r.patch('/api/warehouses/:id', 'warehouses.manage', async ({ db, ctx, body, params }) => {
    const { id } = parse(z.object({ id: zId }), params);
    const b = parse(warehouseSchema, body);
    if (b.isDefault) await db.exec(`UPDATE warehouses SET is_default = false WHERE is_default AND id <> $1`, [id]);
    const row = await db.maybe(
      `UPDATE warehouses SET code = $2, name = $3, kind = $4, address = $5, phone = $6, is_active = $7, is_default = $8
       WHERE id = $1 RETURNING *`,
      [id, b.code, b.name, b.kind, b.address, b.phone, b.isActive, b.isDefault],
    );
    if (!row) throw notFound('Warehouse');
    await logActivity(db, ctx, 'warehouse.update', `Warehouse ${b.name} updated`, { entity: 'warehouse', entityId: id });
    return row;
  });

  // ---- Categories -----------------------------------------------------
  r.get('/api/categories', 'products.view', ({ db }) =>
    db.many(
      `SELECT c.id, c.name, (SELECT count(*) FROM products p WHERE p.category_id = c.id) AS product_count
       FROM categories c ORDER BY c.name`,
    ),
  );

  r.post('/api/categories', 'products.manage', async ({ db, ctx, body, reply }) => {
    const { name } = parse(z.object({ name: z.string().trim().min(1).max(80) }), body);
    const row = await db.one(`INSERT INTO categories (name) VALUES ($1) RETURNING id, name`, [name]);
    await logActivity(db, ctx, 'category.create', `Category ${name} created`, { entity: 'category', entityId: row.id });
    reply.code(201);
    return row;
  });

  r.patch('/api/categories/:id', 'products.manage', async ({ db, ctx, body, params }) => {
    const { id } = parse(z.object({ id: zId }), params);
    const { name } = parse(z.object({ name: z.string().trim().min(1).max(80) }), body);
    const row = await db.maybe(`UPDATE categories SET name = $2 WHERE id = $1 RETURNING id, name`, [id, name]);
    if (!row) throw notFound('Category');
    await logActivity(db, ctx, 'category.update', `Category renamed to ${name}`, { entity: 'category', entityId: id });
    return row;
  });

  r.del('/api/categories/:id', 'products.manage', async ({ db, ctx, params }) => {
    const { id } = parse(z.object({ id: zId }), params);
    await db.exec(`UPDATE products SET category_id = NULL WHERE category_id = $1`, [id]);
    const n = await db.exec(`DELETE FROM categories WHERE id = $1`, [id]);
    if (!n) throw notFound('Category');
    await logActivity(db, ctx, 'category.delete', 'Category deleted', { entity: 'category', entityId: id });
    return { ok: true };
  });

  // ---- Products -------------------------------------------------------
  r.get('/api/products', ['products.view', 'pos.sell', 'inventory.view'], async ({ db, query }) => {
    const q = parse(
      zPaging.extend({
        categoryId: zOptId,
        status: z.enum(['active', 'inactive', 'all']).default('active'),
        stock: z.enum(['all', 'low', 'out', 'in']).default('all'),
        warehouseId: zOptId,
      }),
      query,
    );
    const rows = await db.many(
      `WITH stock AS (
         SELECT product_id, sum(qty) AS qty FROM stock_levels
         WHERE ($5::uuid IS NULL OR warehouse_id = $5) GROUP BY product_id
       )
       SELECT p.id, p.sku, p.barcode, p.name, p.unit, p.sale_price, p.purchase_price, p.avg_cost, p.vat_rate,
              p.reorder_level, p.is_active, p.category_id, c.name AS category_name, COALESCE(s.qty, 0) AS stock,
              count(*) OVER () AS total_count
       FROM products p
       LEFT JOIN categories c ON c.id = p.category_id
       LEFT JOIN stock s ON s.product_id = p.id
       WHERE ($1::text IS NULL OR p.name ILIKE $1 OR p.sku ILIKE $1 OR p.barcode = $2)
         AND ($3::uuid IS NULL OR p.category_id = $3)
         AND ($4 = 'all' OR p.is_active = ($4 = 'active'))
         AND ($6 = 'all'
              OR ($6 = 'out' AND COALESCE(s.qty, 0) <= 0)
              OR ($6 = 'low' AND COALESCE(s.qty, 0) > 0 AND COALESCE(s.qty, 0) <= p.reorder_level)
              OR ($6 = 'in' AND COALESCE(s.qty, 0) > 0))
       ORDER BY p.name
       LIMIT $7 OFFSET $8`,
      [likePattern(q.q), q.q ?? null, q.categoryId, q.status, q.warehouseId, q.stock, q.pageSize, (q.page - 1) * q.pageSize],
    );
    return { rows, total: rows[0]?.total_count ?? 0 };
  });

  r.get('/api/products/:id', ['products.view', 'inventory.view'], async ({ db, params }) => {
    const { id } = parse(z.object({ id: zId }), params);
    const product = await db.maybe(
      `SELECT p.*, c.name AS category_name FROM products p LEFT JOIN categories c ON c.id = p.category_id WHERE p.id = $1`,
      [id],
    );
    if (!product) throw notFound('Product');
    const stock = await db.many(
      `SELECT w.id AS warehouse_id, w.name AS warehouse_name, COALESCE(sl.qty, 0) AS qty
       FROM warehouses w LEFT JOIN stock_levels sl ON sl.warehouse_id = w.id AND sl.product_id = $1
       WHERE w.is_active ORDER BY w.is_default DESC, w.name`,
      [id],
    );
    const movements = await db.many(
      `SELECT m.id, m.qty_change, m.unit_cost, m.balance_after, m.kind, m.ref_number, m.note, m.created_at,
              w.name AS warehouse_name, u.name AS user_name
       FROM stock_movements m JOIN warehouses w ON w.id = m.warehouse_id LEFT JOIN users u ON u.id = m.user_id
       WHERE m.product_id = $1 ORDER BY m.created_at DESC LIMIT 50`,
      [id],
    );
    return { ...product, stock, movements };
  });

  r.post('/api/products', 'products.manage', async ({ db, ctx, body, reply }) => {
    const b = parse(
      productSchema.extend({
        openingStock: z
          .object({ warehouseId: zId, qty: z.coerce.number().min(0).max(1e9), unitCost: zMoney.optional() })
          .optional()
          .nullable(),
      }),
      body,
    );
    const sku = b.sku ?? (await nextNumber(db, 'SKU', 'P', 5));
    const row = await db.one(
      `INSERT INTO products (sku, barcode, name, description, unit, category_id, sale_price, purchase_price, avg_cost,
                             vat_rate, reorder_level, is_active)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $8, $9, $10, $11) RETURNING *`,
      [sku, b.barcode, b.name, b.description, b.unit, b.categoryId, b.salePrice, b.purchasePrice, b.vatRate, b.reorderLevel, b.isActive],
    );
    await logActivity(db, ctx, 'product.create', `Product ${b.name} (${sku}) created`, { entity: 'product', entityId: row.id });
    if (b.openingStock && b.openingStock.qty > 0) {
      await createAdjustment(db, ctx, {
        warehouseId: b.openingStock.warehouseId,
        reason: 'opening',
        note: 'Opening stock',
        items: [{ productId: row.id, qtyChange: b.openingStock.qty, unitCost: b.openingStock.unitCost ?? b.purchasePrice }],
      });
    }
    reply.code(201);
    return row;
  });

  r.patch('/api/products/:id', 'products.manage', async ({ db, ctx, body, params }) => {
    const { id } = parse(z.object({ id: zId }), params);
    const b = parse(productSchema.extend({ sku: z.string().trim().min(1).max(60) }), body);
    const row = await db.maybe(
      `UPDATE products SET sku = $2, barcode = $3, name = $4, description = $5, unit = $6, category_id = $7,
         sale_price = $8, purchase_price = $9, vat_rate = $10, reorder_level = $11, is_active = $12, updated_at = now()
       WHERE id = $1 RETURNING *`,
      [id, b.sku, b.barcode, b.name, b.description, b.unit, b.categoryId, b.salePrice, b.purchasePrice, b.vatRate, b.reorderLevel, b.isActive],
    );
    if (!row) throw notFound('Product');
    await logActivity(db, ctx, 'product.update', `Product ${b.name} updated`, { entity: 'product', entityId: id });
    return row;
  });

  r.del('/api/products/:id', 'products.manage', async ({ db, ctx, params }) => {
    const { id } = parse(z.object({ id: zId }), params);
    const used = await db.maybe(
      `SELECT 1 FROM stock_movements WHERE product_id = $1
       UNION ALL SELECT 1 FROM sale_items WHERE product_id = $1
       UNION ALL SELECT 1 FROM purchase_items WHERE product_id = $1 LIMIT 1`,
      [id],
    );
    if (used) throw conflict('This product has transaction history. Deactivate it instead of deleting.');
    await db.exec(`DELETE FROM stock_levels WHERE product_id = $1`, [id]);
    const n = await db.exec(`DELETE FROM products WHERE id = $1`, [id]);
    if (!n) throw notFound('Product');
    await logActivity(db, ctx, 'product.delete', 'Product deleted', { entity: 'product', entityId: id });
    return { ok: true };
  });

  // ---- POS product search ---------------------------------------------
  r.get('/api/pos/products', 'pos.sell', async ({ db, query }) => {
    const q = parse(z.object({ q: z.string().trim().max(100).optional(), warehouseId: zId, categoryId: zOptId }), query);
    return db.many(
      `SELECT p.id, p.sku, p.barcode, p.name, p.unit, p.sale_price, p.vat_rate, c.name AS category_name,
              COALESCE(sl.qty, 0) AS stock
       FROM products p
       LEFT JOIN categories c ON c.id = p.category_id
       LEFT JOIN stock_levels sl ON sl.product_id = p.id AND sl.warehouse_id = $3
       WHERE p.is_active
         AND ($1::text IS NULL OR p.name ILIKE $1 OR p.sku ILIKE $1 OR p.barcode = $2)
         AND ($4::uuid IS NULL OR p.category_id = $4)
       ORDER BY (p.barcode = $2) DESC NULLS LAST, p.name LIMIT 60`,
      [likePattern(q.q), q.q ?? null, q.warehouseId, q.categoryId],
    );
  });

  // ---- Stock levels & movements ---------------------------------------
  r.get('/api/stock/movements', 'inventory.view', async ({ db, query }) => {
    const q = parse(zPaging.extend({ productId: zOptId, warehouseId: zOptId, kind: z.string().max(30).optional() }), query);
    const rows = await db.many(
      `SELECT m.id, m.qty_change, m.unit_cost, m.balance_after, m.kind, m.ref_type, m.ref_number, m.note, m.created_at,
              p.name AS product_name, p.sku, w.name AS warehouse_name, u.name AS user_name, count(*) OVER () AS total_count
       FROM stock_movements m
       JOIN products p ON p.id = m.product_id
       JOIN warehouses w ON w.id = m.warehouse_id
       LEFT JOIN users u ON u.id = m.user_id
       WHERE ($1::uuid IS NULL OR m.product_id = $1) AND ($2::uuid IS NULL OR m.warehouse_id = $2)
         AND ($3::text IS NULL OR m.kind = $3) AND ($4::text IS NULL OR p.name ILIKE $4 OR m.ref_number ILIKE $4)
       ORDER BY m.created_at DESC LIMIT $5 OFFSET $6`,
      [q.productId, q.warehouseId, q.kind ?? null, likePattern(q.q), q.pageSize, (q.page - 1) * q.pageSize],
    );
    return { rows, total: rows[0]?.total_count ?? 0 };
  });

  r.get('/api/stock', 'inventory.view', async ({ db, ctx, query }) => {
    const q = parse(z.object({ warehouseId: zOptId, q: z.string().trim().max(100).optional() }), query);
    return db.many(
      `SELECT p.id, p.sku, p.name, p.unit, p.reorder_level, p.avg_cost, w.id AS warehouse_id, w.name AS warehouse_name,
              sl.qty, round(GREATEST(sl.qty, 0) * p.avg_cost, 2) AS value
       FROM stock_levels sl JOIN products p ON p.id = sl.product_id JOIN warehouses w ON w.id = sl.warehouse_id
       WHERE ($1::uuid IS NULL OR sl.warehouse_id = $1) AND ($2::text IS NULL OR p.name ILIKE $2 OR p.sku ILIKE $2)
         AND ($3::uuid[] IS NULL OR sl.warehouse_id = ANY($3))
       ORDER BY p.name, w.name`,
      [q.warehouseId, likePattern(q.q), ctx.warehouseIds],
    );
  });
}
