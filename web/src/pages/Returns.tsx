import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { post, useAction, useGet, useLookups } from '../api';
import { Button, Card, DataTable, ErrorBox, Field, Page, Pagination, Spinner, useDebounced, useToast } from '../components/ui';
import { dateTime, money, num } from '../format';

export function InvoiceFinder({ onPick }: { onPick: (id: string) => void }) {
  const [q, setQ] = useState('');
  const dq = useDebounced(q.trim(), 250);
  const { data } = useGet<any>(dq ? '/sales' : null, { q: dq, pageSize: 8, status: 'completed' });
  return (
    <div className="ac">
      <input className="input" placeholder="Find invoice by number, customer or phone…" value={q} onChange={(e) => setQ(e.target.value)} />
      {dq && (
        <div className="ac-list">
          {!data?.rows?.length && <div className="ac-item muted">No completed invoices found</div>}
          {data?.rows?.map((s: any) => (
            <div key={s.id} className="ac-item" onMouseDown={() => { onPick(s.id); setQ(''); }}>
              <div><strong>{s.number}</strong><div className="small muted">{s.customer_name ?? 'Walk-in'} · {dateTime(s.sale_date)}</div></div>
              <span>{money(s.total)}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function ReturnForm({ saleId, onDone }: { saleId: string; onDone: () => void }) {
  const { data: sale } = useGet<any>(`/sales/${saleId}`);
  const { data: lookups } = useLookups();
  const toast = useToast();
  const moneyAccounts = lookups?.accounts.filter((a) => a.is_money) ?? [];
  const [qty, setQty] = useState<Record<string, string>>({});
  const [restock, setRestock] = useState(true);
  const [accountId, setAccountId] = useState('');
  const [reason, setReason] = useState('');
  useEffect(() => { if (!accountId && moneyAccounts[0]) setAccountId(moneyAccounts[0].id); }, [moneyAccounts, accountId]);

  const save = useAction(() => post('/returns', {
    saleId, restock, accountId: accountId || null, reason: reason || null,
    items: Object.entries(qty).filter(([, v]) => Number(v) > 0).map(([saleItemId, v]) => ({ saleItemId, qty: Number(v) })),
  }), ['/returns', '/sales', '/products', '/dashboard', '/customers']);

  if (!sale) return <Spinner />;
  const estimate = sale.items.reduce((s: number, i: any) => s + (Number(qty[i.id] || 0) * i.line_total) / i.qty, 0);
  const dueCut = Math.min(estimate, sale.due_amount);

  return (
    <Card title={`Return against ${sale.number}`}>
      <div className="stack">
        <div className="muted">{sale.customer_name ?? 'Walk-in customer'} · {dateTime(sale.sale_date)} · Total {money(sale.total)} · Due {money(sale.due_amount)}</div>
        <ErrorBox error={save.error} />
        <DataTable compact rows={sale.items} columns={[
          { key: 'product_name', header: 'Product' },
          { key: 'qty', header: 'Sold', num: true, render: (r) => num(r.qty) },
          { key: 'returned_qty', header: 'Already returned', num: true, render: (r) => num(r.returned_qty) },
          { key: 'line_total', header: 'Line total', num: true, render: (r) => money(r.line_total) },
          { key: 'ret', header: 'Return qty', render: (r) => (
            <input className="input sm" style={{ width: 100 }} type="number" min="0" max={r.qty - r.returned_qty} step="any"
              disabled={r.qty - r.returned_qty <= 0} value={qty[r.id] ?? ''} onChange={(e) => setQty({ ...qty, [r.id]: e.target.value })} />
          ) },
        ]} />
        <div className="grid grid-3">
          <label className="checkbox"><input type="checkbox" checked={restock} onChange={(e) => setRestock(e.target.checked)} /> Put returned goods back into stock</label>
          <Field label="Refund from">
            <select className="select" value={accountId} onChange={(e) => setAccountId(e.target.value)}>
              {moneyAccounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
            </select>
          </Field>
          <Field label="Reason"><input className="input" value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
        </div>
        <div className="info-box">
          Return value ≈ {money(estimate)}. {dueCut > 0 && `${money(dueCut)} reduces the customer's due; `}
          {estimate - dueCut > 0 && `${money(estimate - dueCut)} is refunded.`}
        </div>
        <div className="row">
          <Button onClick={onDone}>Cancel</Button>
          <Button variant="primary" loading={save.isPending} disabled={estimate <= 0} onClick={async () => {
            try {
              const r = await save.mutateAsync(undefined);
              toast(`${r.number}: ${money(r.amount)} returned${r.refund > 0 ? `, refund ${money(r.refund)}` : ''}`);
              onDone();
            } catch { /* shown */ }
          }}>Process return</Button>
        </div>
      </div>
    </Card>
  );
}

export default function Returns() {
  const [params, setParams] = useSearchParams();
  const saleId = params.get('sale');
  const [page, setPage] = useState(1);
  const { data, isLoading } = useGet<any>('/returns', { page, pageSize: 30 });

  return (
    <Page title="Returns" subtitle="Take back goods from an invoice: restock, reduce dues and refund">
      <div className="stack">
        {!saleId ? (
          <Card title="Start a return"><InvoiceFinder onPick={(id) => setParams({ sale: id })} /></Card>
        ) : (
          <ReturnForm saleId={saleId} onDone={() => setParams({})} />
        )}
        <Card pad={false} title="Recent returns">
          <DataTable loading={isLoading} rows={data?.rows} empty="No returns yet." columns={[
            { key: 'number', header: 'Return', render: (r) => <strong>{r.number}</strong> },
            { key: 'return_date', header: 'Date', render: (r) => dateTime(r.return_date) },
            { key: 'sale_number', header: 'Invoice' },
            { key: 'customer_name', header: 'Customer', render: (r) => r.customer_name ?? 'Walk-in' },
            { key: 'items', header: 'Items', render: (r) => r.items?.map((i: any) => `${i.product} ×${num(i.qty)}`).join(', ') },
            { key: 'amount', header: 'Amount', num: true, render: (r) => money(r.amount) },
            { key: 'refund_amount', header: 'Refunded', num: true, render: (r) => money(r.refund_amount) },
            { key: 'restock', header: 'Restocked', render: (r) => (r.restock ? 'Yes' : 'No') },
          ]} />
          <Pagination page={page} pageSize={30} total={data?.total ?? 0} onChange={setPage} />
        </Card>
      </div>
    </Page>
  );
}
