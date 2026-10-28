import { useState } from 'react';
import { Link } from 'react-router-dom';
import { post, useAction, useGet, useLookups } from '../api';
import { useAuth } from '../auth';
import { Button, Card, DataTable, ErrorBox, Field, Modal, Page, Pagination, Spinner, StatusBadge, useDebounced, useToast } from '../components/ui';
import { dateTime, money, num } from '../format';

export function SaleDetail({ id, onClose }: { id: string; onClose: () => void }) {
  const { can } = useAuth();
  const toast = useToast();
  const { data, refetch } = useGet<any>(`/sales/${id}`);
  const [voiding, setVoiding] = useState(false);
  const [reason, setReason] = useState('');
  const voidSale = useAction(() => post(`/sales/${id}/void`, { reason }), ['/sales', '/dashboard', '/products', '/customers']);

  return (
    <Modal open title={data ? `Invoice ${data.number}` : 'Invoice'} onClose={onClose} size="wide" footer={data && (
      <>
        <Button onClick={() => window.open(`/print/sale/${id}`, '_blank', 'width=420,height=720')}>🖨️ Print</Button>
        {can('returns.manage') && data.status === 'completed' && <Link className="btn btn-secondary" to={`/returns?sale=${id}`}>↩️ Return items</Link>}
        {can('sales.void') && data.status === 'completed' && <Button variant="danger" onClick={() => setVoiding(true)}>Void sale</Button>}
      </>
    )}>
      {!data ? <Spinner /> : (
        <div className="stack">
          <div className="row between wrap">
            <div>
              <div><StatusBadge status={data.status} /> {dateTime(data.sale_date)}</div>
              <div className="muted">{data.customer_name ?? 'Walk-in customer'} {data.customer_phone && `· ${data.customer_phone}`}</div>
              <div className="small muted">{data.warehouse_name} · Cashier {data.cashier_name}</div>
            </div>
            <div className="right">
              <div className="display" style={{ fontSize: 28 }}>{money(data.total)}</div>
              {data.due_amount > 0 && <div className="red">Due {money(data.due_amount)}</div>}
            </div>
          </div>
          {data.status === 'void' && <div className="error-box">Voided {dateTime(data.voided_at)} by {data.voided_by_name}: {data.void_reason}</div>}
          <DataTable compact rows={data.items} columns={[
            { key: 'product_name', header: 'Product', render: (r) => <>{r.product_name}<div className="small muted">{r.sku}</div></> },
            { key: 'qty', header: 'Qty', num: true, render: (r) => `${num(r.qty)} ${r.unit}` },
            { key: 'unit_price', header: 'Price', num: true, render: (r) => money(r.unit_price) },
            { key: 'vat_amount', header: 'VAT', num: true, render: (r) => money(r.vat_amount) },
            { key: 'line_total', header: 'Total', num: true, render: (r) => money(r.line_total) },
            { key: 'returned_qty', header: 'Returned', num: true, render: (r) => (r.returned_qty > 0 ? num(r.returned_qty) : '—') },
          ]} />
          <div className="grid grid-2">
            <dl className="kv">
              <dt>Subtotal</dt><dd>{money(data.subtotal)}</dd>
              <dt>Discount</dt><dd>{money(data.discount)}</dd>
              <dt>VAT</dt><dd>{money(data.vat_amount)}</dd>
              <dt>Total</dt><dd><strong>{money(data.total)}</strong></dd>
              {can('reports.view') && <><dt>Cost / profit</dt><dd>{money(data.cost_total)} / {money(data.subtotal - data.discount - data.cost_total)}</dd></>}
            </dl>
            <div>
              {data.payments.map((p: any, i: number) => <div key={i} className="list-row"><span>Paid · {p.account_name}</span><span>{money(p.amount)}</span></div>)}
              {data.collections.map((c: any) => <div key={c.number} className="list-row"><span>{c.number} · {c.account_name}</span><span>{money(c.amount)}</span></div>)}
              {data.returns.map((r: any) => <div key={r.id} className="list-row"><span>Return {r.number}</span><span className="red">-{money(r.amount)}</span></div>)}
            </div>
          </div>
          {data.note && <div className="muted">Note: {data.note}</div>}
        </div>
      )}
      <Modal open={voiding} title="Void sale" onClose={() => setVoiding(false)} footer={
        <>
          <Button onClick={() => setVoiding(false)}>Cancel</Button>
          <Button variant="danger" loading={voidSale.isPending} disabled={reason.trim().length < 3} onClick={async () => {
            try {
              await voidSale.mutateAsync(undefined);
              toast('Sale voided; stock restored and journal reversed');
              setVoiding(false);
              refetch();
            } catch { /* shown */ }
          }}>Void sale</Button>
        </>
      }>
        <div className="stack">
          <div className="info-box">Voiding returns all items to stock and posts a reversing journal entry. Sales with returns or later collections cannot be voided — use Returns instead.</div>
          <ErrorBox error={voidSale.error} />
          <Field label="Reason *"><input className="input" value={reason} onChange={(e) => setReason(e.target.value)} autoFocus /></Field>
        </div>
      </Modal>
    </Modal>
  );
}

export default function Sales({ mode }: { mode: 'history' | 'manage' }) {
  const { data: lookups } = useLookups();
  const [q, setQ] = useState('');
  const [f, setF] = useState({ from: '', to: '', status: mode === 'manage' ? 'completed' : 'all', warehouseId: '', dueOnly: false });
  const [page, setPage] = useState(1);
  const [view, setView] = useState<string | null>(null);
  const dq = useDebounced(q);
  const { data, isLoading } = useGet<any>('/sales', { q: dq, page, pageSize: 50, ...f });
  const set = (k: string, v: any) => { setF((x) => ({ ...x, [k]: v })); setPage(1); };

  return (
    <Page
      title={mode === 'manage' ? 'Manage Sales' : 'Sales History'}
      subtitle={mode === 'manage' ? 'Void mistaken invoices and review completed or voided sales' : `${data?.total ?? 0} invoices · ${money(data?.sumTotal ?? 0)} · due ${money(data?.sumDue ?? 0)}`}
    >
      <Card pad={false}>
        <div className="card-body" style={{ paddingBottom: 0 }}>
          <div className="toolbar">
            <input className="input search" placeholder="Invoice #, customer, phone…" value={q} onChange={(e) => { setQ(e.target.value); setPage(1); }} />
            <input className="input" type="date" value={f.from} onChange={(e) => set('from', e.target.value)} aria-label="From" />
            <input className="input" type="date" value={f.to} onChange={(e) => set('to', e.target.value)} aria-label="To" />
            <select className="select" value={f.status} onChange={(e) => set('status', e.target.value)}>
              <option value="all">All statuses</option><option value="completed">Completed</option><option value="void">Void</option>
            </select>
            <select className="select" value={f.warehouseId} onChange={(e) => set('warehouseId', e.target.value)}>
              <option value="">All branches</option>
              {lookups?.warehouses.filter((w) => w.allowed).map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
            </select>
            <label className="checkbox"><input type="checkbox" checked={f.dueOnly} onChange={(e) => set('dueOnly', e.target.checked)} /> Due only</label>
          </div>
        </div>
        <DataTable loading={isLoading} rows={data?.rows} onRowClick={(r) => setView(r.id)} empty="No sales match your filters." columns={[
          { key: 'number', header: 'Invoice', render: (r) => <strong>{r.number}</strong> },
          { key: 'sale_date', header: 'Date', render: (r) => dateTime(r.sale_date) },
          { key: 'customer_name', header: 'Customer', render: (r) => r.customer_name ?? <span className="muted">Walk-in</span> },
          { key: 'warehouse_name', header: 'Branch' },
          { key: 'cashier_name', header: 'Cashier' },
          { key: 'total', header: 'Total', num: true, render: (r) => money(r.total) },
          { key: 'due_amount', header: 'Due', num: true, render: (r) => (r.due_amount > 0 ? <span className="red">{money(r.due_amount)}</span> : '—') },
          { key: 'status', header: 'Status', render: (r) => <StatusBadge status={r.status} /> },
        ]} />
        <Pagination page={page} pageSize={50} total={data?.total ?? 0} onChange={setPage} />
      </Card>
      {view && <SaleDetail id={view} onClose={() => setView(null)} />}
    </Page>
  );
}
