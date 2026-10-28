import { useState } from 'react';
import { post, useAction, useGet, useLookups } from '../api';
import { ProductHit, ProductSearch } from '../components/ProductSearch';
import { Button, Card, DataTable, ErrorBox, Field, Page, Pagination, useToast } from '../components/ui';
import { dateTime, money, num } from '../format';
import { InvoiceFinder } from './Returns';

function PickedProduct({ label, product, onPick, warehouseId }: { label: string; product: ProductHit | null; onPick: (p: ProductHit | null) => void; warehouseId: string }) {
  return (
    <Field label={label}>
      {product ? (
        <div className="row between card" style={{ padding: '8px 12px' }}>
          <span><strong>{product.name}</strong> <span className="small muted">stock {num(product.stock)}</span></span>
          <button className="link small" onClick={() => onPick(null)}>Change</button>
        </div>
      ) : (
        <ProductSearch onSelect={onPick} warehouseId={warehouseId} />
      )}
    </Field>
  );
}

export default function Replacements() {
  const { data: lookups } = useLookups();
  const toast = useToast();
  const allowed = lookups?.warehouses.filter((w) => w.allowed) ?? [];
  const moneyAccounts = lookups?.accounts.filter((a) => a.is_money) ?? [];
  const [saleId, setSaleId] = useState<string | null>(null);
  const { data: sale } = useGet<any>(saleId ? `/sales/${saleId}` : null);
  const [warehouseId, setWarehouseId] = useState('');
  const [returned, setReturned] = useState<ProductHit | null>(null);
  const [issued, setIssued] = useState<ProductHit | null>(null);
  const [form, setForm] = useState({ returnedQty: '1', issuedQty: '1', restockReturned: false, chargeAmount: '', accountId: '', reason: '' });
  const [page, setPage] = useState(1);
  const { data, isLoading } = useGet<any>('/replacements', { page, pageSize: 30 });
  const wh = warehouseId || allowed[0]?.id || '';
  const save = useAction(() => post('/replacements', {
    saleId, warehouseId: wh, returnedProductId: returned?.id, issuedProductId: issued?.id,
    returnedQty: Number(form.returnedQty), issuedQty: Number(form.issuedQty), restockReturned: form.restockReturned,
    chargeAmount: Number(form.chargeAmount || 0), accountId: form.accountId || moneyAccounts[0]?.id || null, reason: form.reason || null,
  }), ['/replacements', '/products', '/dashboard']);
  const reset = () => { setSaleId(null); setReturned(null); setIssued(null); setForm({ ...form, returnedQty: '1', issuedQty: '1', chargeAmount: '', reason: '' }); };

  return (
    <Page title="Replacements" subtitle="Warranty exchanges: take back a faulty item and issue a replacement">
      <div className="stack">
        <Card title="New replacement">
          <div className="stack">
            <ErrorBox error={save.error} />
            <div className="grid grid-2">
              <Field label="Original invoice (optional)">
                {sale ? (
                  <div className="row between card" style={{ padding: '8px 12px' }}>
                    <span><strong>{sale.number}</strong> · {sale.customer_name ?? 'Walk-in'}</span>
                    <button className="link small" onClick={() => setSaleId(null)}>Change</button>
                  </div>
                ) : <InvoiceFinder onPick={setSaleId} />}
              </Field>
              <Field label="Branch">
                <select className="select" value={wh} onChange={(e) => setWarehouseId(e.target.value)}>
                  {allowed.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
                </select>
              </Field>
            </div>
            {sale && (
              <div className="small muted">Sold on this invoice: {sale.items.map((i: any) => `${i.product_name} ×${num(i.qty - i.returned_qty)}`).join(', ')}</div>
            )}
            <div className="grid grid-2">
              <div className="stack" style={{ gap: 10 }}>
                <PickedProduct label="Item received back" product={returned} onPick={(p) => { setReturned(p); if (p && !issued) setIssued(p); }} warehouseId={wh} />
                <Field label="Qty received"><input className="input" type="number" min="0" step="any" value={form.returnedQty} onChange={(e) => setForm({ ...form, returnedQty: e.target.value })} /></Field>
                <label className="checkbox"><input type="checkbox" checked={form.restockReturned} onChange={(e) => setForm({ ...form, restockReturned: e.target.checked })} /> Item is resellable — put back into stock</label>
              </div>
              <div className="stack" style={{ gap: 10 }}>
                <PickedProduct label="Item issued as replacement" product={issued} onPick={setIssued} warehouseId={wh} />
                <Field label="Qty issued"><input className="input" type="number" min="0" step="any" value={form.issuedQty} onChange={(e) => setForm({ ...form, issuedQty: e.target.value })} /></Field>
              </div>
            </div>
            <div className="grid grid-3">
              <Field label="Charge to customer" hint="e.g. upgrade difference; 0 for free warranty replacement">
                <input className="input" type="number" min="0" step="any" value={form.chargeAmount} placeholder="0" onChange={(e) => setForm({ ...form, chargeAmount: e.target.value })} />
              </Field>
              <Field label="Received into">
                <select className="select" value={form.accountId} onChange={(e) => setForm({ ...form, accountId: e.target.value })}>
                  {moneyAccounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
                </select>
              </Field>
              <Field label="Reason"><input className="input" value={form.reason} placeholder="e.g. dead cell, leaking" onChange={(e) => setForm({ ...form, reason: e.target.value })} /></Field>
            </div>
            <div className="row">
              <Button variant="primary" loading={save.isPending} disabled={!returned || !issued} onClick={async () => {
                try {
                  const r = await save.mutateAsync(undefined);
                  toast(`${r.number} recorded`);
                  reset();
                } catch { /* shown */ }
              }}>Record replacement</Button>
            </div>
          </div>
        </Card>
        <Card pad={false} title="Replacement history">
          <DataTable loading={isLoading} rows={data?.rows} empty="No replacements yet." columns={[
            { key: 'number', header: 'Number', render: (r) => <strong>{r.number}</strong> },
            { key: 'created_at', header: 'Date', render: (r) => dateTime(r.created_at) },
            { key: 'sale_number', header: 'Invoice' },
            { key: 'customer_name', header: 'Customer' },
            { key: 'returned_product', header: 'Received', render: (r) => `${r.returned_product} ×${num(r.returned_qty)}` },
            { key: 'issued_product', header: 'Issued', render: (r) => `${r.issued_product} ×${num(r.issued_qty)}` },
            { key: 'issued_cost', header: 'Cost', num: true, render: (r) => money(r.issued_cost) },
            { key: 'charge_amount', header: 'Charged', num: true, render: (r) => money(r.charge_amount) },
            { key: 'reason', header: 'Reason' },
          ]} />
          <Pagination page={page} pageSize={30} total={data?.total ?? 0} onChange={setPage} />
        </Card>
      </div>
    </Page>
  );
}
