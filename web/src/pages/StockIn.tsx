import { useState } from 'react';
import { post, useAction, useGet, useLookups } from '../api';
import { Line, LineEditor } from '../components/LineEditor';
import { Badge, Button, Card, DataTable, ErrorBox, Field, Modal, Page, Pagination, Spinner, useDebounced, useToast } from '../components/ui';
import { date, money, num } from '../format';

function PurchaseDetail({ id, onClose }: { id: string; onClose: () => void }) {
  const { data } = useGet<any>(`/purchases/${id}`);
  return (
    <Modal open title={data?.number ?? 'Purchase'} onClose={onClose} size="wide">
      {!data ? <Spinner /> : (
        <div className="stack">
          <dl className="kv">
            <dt>Supplier</dt><dd>{data.supplier_name ?? '—'}</dd>
            <dt>Date</dt><dd>{date(data.purchase_date)} {data.reference && `· Ref ${data.reference}`}</dd>
            <dt>Received at</dt><dd>{data.warehouse_name} by {data.user_name}</dd>
            <dt>Total / Paid / Due</dt><dd>{money(data.total)} / {money(data.paid_amount)} / <span className={data.due_amount > 0 ? 'red' : ''}>{money(data.due_amount)}</span></dd>
          </dl>
          <DataTable compact rows={data.items} columns={[
            { key: 'product_name', header: 'Product' },
            { key: 'qty', header: 'Qty', num: true, render: (r) => `${num(r.qty)} ${r.unit}` },
            { key: 'unit_cost', header: 'Unit cost', num: true, render: (r) => money(r.unit_cost) },
            { key: 'line_total', header: 'Total', num: true, render: (r) => money(r.line_total) },
          ]} />
        </div>
      )}
    </Modal>
  );
}

function NewPurchase({ onClose }: { onClose: () => void }) {
  const { data: lookups } = useLookups();
  const { data: suppliers } = useGet<any>('/suppliers', { pageSize: 500 });
  const toast = useToast();
  const warehouses = lookups?.warehouses.filter((w) => w.allowed) ?? [];
  const moneyAccounts = lookups?.accounts.filter((a) => a.is_money) ?? [];
  const [form, setForm] = useState({
    supplierId: '', warehouseId: warehouses[0]?.id ?? '', purchaseDate: lookups?.settings.today ?? '', reference: '', note: '',
    paidAmount: '', accountId: moneyAccounts[0]?.id ?? '',
  });
  const [lines, setLines] = useState<Line[]>([]);
  const total = lines.reduce((s, l) => s + Number(l.qty || 0) * Number(l.unitCost || 0), 0);
  const save = useAction(() => post('/purchases', {
    ...form,
    supplierId: form.supplierId || null,
    reference: form.reference || null,
    note: form.note || null,
    paidAmount: Number(form.paidAmount || 0),
    accountId: form.accountId || null,
    items: lines.map((l) => ({ productId: l.productId, qty: Number(l.qty), unitCost: Number(l.unitCost || 0) })),
  }), ['/purchases', '/products', '/dashboard', '/suppliers', '/pos']);
  const set = (k: string, v: string) => setForm((f) => ({ ...f, [k]: v }));

  return (
    <Modal open title="Stock In — receive goods" onClose={onClose} size="xwide" footer={
      <>
        <Button onClick={onClose}>Cancel</Button>
        <Button variant="primary" loading={save.isPending} disabled={!lines.length} onClick={async () => {
          try {
            const p = await save.mutateAsync(undefined);
            toast(`${p.number} received`);
            onClose();
          } catch { /* shown below */ }
        }}>Receive stock · {money(total)}</Button>
      </>
    }>
      <div className="stack">
        <ErrorBox error={save.error} />
        <div className="grid grid-4">
          <Field label="Supplier">
            <select className="select" value={form.supplierId} onChange={(e) => set('supplierId', e.target.value)}>
              <option value="">— No supplier (cash purchase) —</option>
              {suppliers?.rows.map((s: any) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
          </Field>
          <Field label="Receive into">
            <select className="select" value={form.warehouseId} onChange={(e) => set('warehouseId', e.target.value)}>
              {warehouses.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
            </select>
          </Field>
          <Field label="Date"><input className="input" type="date" value={form.purchaseDate} onChange={(e) => set('purchaseDate', e.target.value)} /></Field>
          <Field label="Supplier invoice #"><input className="input" value={form.reference} onChange={(e) => set('reference', e.target.value)} /></Field>
        </div>
        <LineEditor lines={lines} onChange={setLines} warehouseId={form.warehouseId} withCost />
        <div className="grid grid-4">
          <Field label="Paid now" hint={`Due: ${money(Math.max(0, total - Number(form.paidAmount || 0)))}`}>
            <div className="row">
              <input className="input" type="number" min="0" step="any" value={form.paidAmount} placeholder="0" onChange={(e) => set('paidAmount', e.target.value)} />
              <Button size="sm" onClick={() => set('paidAmount', String(total))}>Full</Button>
            </div>
          </Field>
          <Field label="Paid from">
            <select className="select" value={form.accountId} onChange={(e) => set('accountId', e.target.value)}>
              {moneyAccounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
            </select>
          </Field>
          <Field label="Note" className="span-2"><input className="input" value={form.note} onChange={(e) => set('note', e.target.value)} /></Field>
        </div>
      </div>
    </Modal>
  );
}

export default function StockIn() {
  const [q, setQ] = useState('');
  const [page, setPage] = useState(1);
  const [creating, setCreating] = useState(false);
  const [view, setView] = useState<string | null>(null);
  const dq = useDebounced(q);
  const { data, isLoading } = useGet<any>('/purchases', { q: dq, page, pageSize: 50 });

  return (
    <Page title="Stock In" subtitle="Receive purchased goods into a warehouse or branch" actions={<Button variant="primary" onClick={() => setCreating(true)}>＋ New stock in</Button>}>
      <Card pad={false}>
        <div className="card-body" style={{ paddingBottom: 0 }}>
          <div className="toolbar">
            <input className="input search" placeholder="Search number, supplier, reference…" value={q} onChange={(e) => { setQ(e.target.value); setPage(1); }} />
          </div>
        </div>
        <DataTable loading={isLoading} rows={data?.rows} onRowClick={(r) => setView(r.id)} empty="No stock received yet." columns={[
          { key: 'number', header: 'Number', render: (r) => <strong>{r.number}</strong> },
          { key: 'purchase_date', header: 'Date', render: (r) => date(r.purchase_date) },
          { key: 'supplier_name', header: 'Supplier' },
          { key: 'warehouse_name', header: 'Location' },
          { key: 'item_count', header: 'Items', num: true },
          { key: 'total', header: 'Total', num: true, render: (r) => money(r.total) },
          { key: 'due_amount', header: 'Due', num: true, render: (r) => (r.due_amount > 0 ? <Badge tone="red">{money(r.due_amount)}</Badge> : <Badge tone="green">Paid</Badge>) },
          { key: 'user_name', header: 'By' },
        ]} />
        <Pagination page={page} pageSize={50} total={data?.total ?? 0} onChange={setPage} />
      </Card>
      {creating && <NewPurchase onClose={() => setCreating(false)} />}
      {view && <PurchaseDetail id={view} onClose={() => setView(null)} />}
    </Page>
  );
}
