import { useState } from 'react';
import { del, patch, post, useAction, useGet, useLookups } from '../api';
import { useAuth } from '../auth';
import { FieldDef, FormModal } from '../components/FormModal';
import { Badge, Button, Card, DataTable, Modal, Page, Pagination, Spinner, Tabs, useDebounced, useToast } from '../components/ui';
import { dateTime, money, num, titleCase } from '../format';

function ProductDetail({ id, onClose }: { id: string; onClose: () => void }) {
  const { data } = useGet<any>(`/products/${id}`);
  return (
    <Modal open title={data?.name ?? 'Product'} onClose={onClose} size="wide">
      {!data ? <Spinner /> : (
        <div className="stack">
          <dl className="kv">
            <dt>SKU / Barcode</dt><dd>{data.sku} {data.barcode && `· ${data.barcode}`}</dd>
            <dt>Category</dt><dd>{data.category_name ?? '—'}</dd>
            <dt>Sale price</dt><dd>{money(data.sale_price)} {data.vat_rate > 0 && `+ VAT ${data.vat_rate}%`}</dd>
            <dt>Average cost</dt><dd>{money(data.avg_cost)} (last purchase {money(data.purchase_price)})</dd>
            <dt>Reorder level</dt><dd>{num(data.reorder_level)} {data.unit}</dd>
          </dl>
          <h4 className="card-title">Stock by location</h4>
          <DataTable compact rowKey="warehouse_id" rows={data.stock} columns={[
            { key: 'warehouse_name', header: 'Warehouse / branch' },
            { key: 'qty', header: 'Qty', num: true, render: (r) => `${num(r.qty)} ${data.unit}` },
          ]} />
          <h4 className="card-title">Recent movements</h4>
          <DataTable compact rows={data.movements} empty="No stock movements yet" columns={[
            { key: 'created_at', header: 'When', render: (r) => dateTime(r.created_at) },
            { key: 'kind', header: 'Type', render: (r) => titleCase(r.kind) },
            { key: 'ref_number', header: 'Ref' },
            { key: 'warehouse_name', header: 'Location' },
            { key: 'qty_change', header: 'Change', num: true, render: (r) => <span className={r.qty_change < 0 ? 'red' : 'green'}>{r.qty_change > 0 ? '+' : ''}{num(r.qty_change)}</span> },
            { key: 'balance_after', header: 'Balance', num: true, render: (r) => num(r.balance_after) },
            { key: 'user_name', header: 'By' },
          ]} />
        </div>
      )}
    </Modal>
  );
}

function Categories() {
  const { data, isLoading } = useGet<any[]>('/categories');
  const { can } = useAuth();
  const toast = useToast();
  const [edit, setEdit] = useState<any>(null);
  const save = useAction((v: any) => (v.id ? patch(`/categories/${v.id}`, v) : post('/categories', v)), ['/categories', '/lookups']);
  const remove = useAction((id: string) => del(`/categories/${id}`), ['/categories', '/lookups', '/products']);
  return (
    <Card pad={false} title="Categories" actions={can('products.manage') && <Button variant="primary" onClick={() => setEdit({})}>＋ Category</Button>}>
      <DataTable loading={isLoading} rows={data} columns={[
        { key: 'name', header: 'Name' },
        { key: 'product_count', header: 'Products', num: true },
        { key: 'actions', header: '', render: (r) => can('products.manage') && (
          <div className="row" style={{ justifyContent: 'flex-end' }}>
            <Button size="sm" onClick={() => setEdit(r)}>Rename</Button>
            <Button size="sm" variant="danger" onClick={async () => {
              if (!confirm(`Delete category ${r.name}? Products keep existing without a category.`)) return;
              await remove.mutateAsync(r.id).catch((e) => toast(e.message, 'error'));
            }}>Delete</Button>
          </div>
        ) },
      ]} />
      <FormModal open={!!edit} title={edit?.id ? 'Rename category' : 'New category'} initial={edit} onClose={() => setEdit(null)}
        fields={[{ name: 'name', label: 'Name', required: true, span: 2 }]}
        onSubmit={(v) => save.mutateAsync({ ...v, id: edit?.id })} />
    </Card>
  );
}

export default function Products() {
  const { can } = useAuth();
  const toast = useToast();
  const { data: lookups } = useLookups();
  const [tab, setTab] = useState<'products' | 'categories'>('products');
  const [q, setQ] = useState('');
  const [filters, setFilters] = useState({ categoryId: '', status: 'active', stock: 'all' });
  const [page, setPage] = useState(1);
  const [edit, setEdit] = useState<any>(null);
  const [view, setView] = useState<string | null>(null);
  const dq = useDebounced(q);
  const { data, isLoading } = useGet<any>('/products', { q: dq, page, pageSize: 50, ...filters });
  const save = useAction(
    (v: any) => (v.id ? patch(`/products/${v.id}`, v) : post('/products', v)),
    ['/products', '/dashboard', '/pos', '/categories'],
  );

  const fields: FieldDef[] = [
    { name: 'name', label: 'Product name', required: true, span: 2 },
    { name: 'sku', label: 'SKU', hint: edit?.id ? undefined : 'Leave empty to auto-generate', required: !!edit?.id },
    { name: 'barcode', label: 'Barcode' },
    { name: 'categoryId', label: 'Category', type: 'select', options: lookups?.categories.map((c) => ({ value: c.id, label: c.name })) },
    { name: 'unit', label: 'Unit', placeholder: 'pcs, kg, bag, bottle…', required: true },
    { name: 'salePrice', label: 'Sale price', type: 'number', required: true },
    { name: 'purchasePrice', label: 'Purchase price', type: 'number' },
    { name: 'vatRate', label: 'VAT %', type: 'number' },
    { name: 'reorderLevel', label: 'Reorder level', type: 'number', hint: 'Low-stock alert threshold' },
    { name: 'description', label: 'Description', type: 'textarea', span: 2 },
    { name: 'isActive', label: 'Active (available for sale)', type: 'checkbox', span: 2 },
    ...(!edit?.id
      ? ([
          { name: 'openingQty', label: 'Opening stock qty', type: 'number', hint: 'Stock you already have' },
          { name: 'openingWarehouseId', label: 'Opening stock location', type: 'select', required: false,
            options: lookups?.warehouses.filter((w) => w.allowed).map((w) => ({ value: w.id, label: w.name })) },
        ] as FieldDef[])
      : []),
  ];

  const openEdit = (p?: any) =>
    setEdit(
      p
        ? { id: p.id, name: p.name, sku: p.sku, barcode: p.barcode, categoryId: p.category_id, unit: p.unit, salePrice: p.sale_price,
            purchasePrice: p.purchase_price, vatRate: p.vat_rate, reorderLevel: p.reorder_level, isActive: p.is_active }
        : { unit: 'pcs', vatRate: lookups?.settings.default_vat_rate ?? 0, reorderLevel: 0, isActive: true,
            openingWarehouseId: lookups?.warehouses.find((w) => w.allowed)?.id },
    );

  return (
    <Page title="Products" subtitle={`${data?.total ?? 0} products`} actions={can('products.manage') && tab === 'products' && <Button variant="primary" onClick={() => openEdit()}>＋ New product</Button>}>
      <Tabs value={tab} onChange={setTab} tabs={[{ value: 'products', label: 'Products' }, { value: 'categories', label: 'Categories' }]} />
      {tab === 'categories' ? <Categories /> : (
        <Card pad={false}>
          <div className="card-body" style={{ paddingBottom: 0 }}>
            <div className="toolbar">
              <input className="input search" placeholder="Search name, SKU, barcode…" value={q} onChange={(e) => { setQ(e.target.value); setPage(1); }} />
              <select className="select" value={filters.categoryId} onChange={(e) => setFilters({ ...filters, categoryId: e.target.value })}>
                <option value="">All categories</option>
                {lookups?.categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
              <select className="select" value={filters.stock} onChange={(e) => setFilters({ ...filters, stock: e.target.value })}>
                <option value="all">Any stock</option><option value="in">In stock</option><option value="low">Low stock</option><option value="out">Out of stock</option>
              </select>
              <select className="select" value={filters.status} onChange={(e) => setFilters({ ...filters, status: e.target.value })}>
                <option value="active">Active</option><option value="inactive">Inactive</option><option value="all">All</option>
              </select>
            </div>
          </div>
          <DataTable loading={isLoading} rows={data?.rows} onRowClick={(r) => setView(r.id)} empty="No products yet — add your first product." columns={[
            { key: 'name', header: 'Product', render: (r) => <div><strong>{r.name}</strong><div className="small muted">{r.sku}{r.barcode ? ` · ${r.barcode}` : ''}</div></div> },
            { key: 'category_name', header: 'Category' },
            { key: 'sale_price', header: 'Price', num: true, render: (r) => money(r.sale_price) },
            { key: 'avg_cost', header: 'Avg cost', num: true, render: (r) => money(r.avg_cost) },
            { key: 'stock', header: 'Stock', num: true, render: (r) => (
              <Badge tone={r.stock <= 0 ? 'red' : r.stock <= r.reorder_level ? 'amber' : 'green'}>{num(r.stock)} {r.unit}</Badge>
            ) },
            { key: 'is_active', header: 'Status', render: (r) => (r.is_active ? <Badge tone="green">Active</Badge> : <Badge>Inactive</Badge>) },
            { key: 'actions', header: '', render: (r) => can('products.manage') && (
              <Button size="sm" onClick={(e) => { e.stopPropagation(); openEdit(r); }}>Edit</Button>
            ) },
          ]} />
          <Pagination page={page} pageSize={50} total={data?.total ?? 0} onChange={setPage} />
        </Card>
      )}
      {view && <ProductDetail id={view} onClose={() => setView(null)} />}
      <FormModal open={!!edit} size="wide" title={edit?.id ? 'Edit product' : 'New product'} initial={edit} fields={fields} onClose={() => setEdit(null)}
        onSubmit={async (v) => {
          const body: any = { ...v, id: edit?.id };
          if (!edit?.id && v.openingQty > 0) body.openingStock = { warehouseId: v.openingWarehouseId, qty: v.openingQty, unitCost: v.purchasePrice ?? 0 };
          delete body.openingQty;
          delete body.openingWarehouseId;
          await save.mutateAsync(body);
          toast(edit?.id ? 'Product updated' : 'Product created');
        }} />
    </Page>
  );
}
