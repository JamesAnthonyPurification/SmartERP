import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { post, useAction, useGet, useLookups } from '../api';
import { Badge, Button, Card, DataTable, ErrorBox, Field, Page, Pagination, Spinner, useDebounced, useToast } from '../components/ui';
import { date, money } from '../format';

function CollectForm({ customerId, onDone }: { customerId: string; onDone: () => void }) {
  const { data: c } = useGet<any>(`/customers/${customerId}`);
  const { data: lookups } = useLookups();
  const toast = useToast();
  const moneyAccounts = lookups?.accounts.filter((a) => a.is_money) ?? [];
  const [amount, setAmount] = useState('');
  const [accountId, setAccountId] = useState('');
  const [paymentDate, setPaymentDate] = useState('');
  const [note, setNote] = useState('');
  useEffect(() => { if (!accountId && moneyAccounts[0]) setAccountId(moneyAccounts[0].id); }, [moneyAccounts, accountId]);
  const save = useAction(() => post('/collections', { customerId, accountId, amount: Number(amount), paymentDate: paymentDate || null, note: note || null }),
    ['/collections', '/customers', '/sales', '/dashboard']);

  if (!c) return <Spinner />;
  let remaining = Number(amount) || 0;
  const preview = c.openInvoices.map((inv: any) => {
    const applied = Math.min(remaining, inv.due_amount);
    remaining -= applied;
    return { ...inv, applied };
  });

  return (
    <Card title={`Collect from ${c.name}`}>
      <div className="stack">
        <div className="row wrap">
          <Badge tone="red">Total due {money(c.due)}</Badge>
          <span className="muted">{c.phone}</span>
        </div>
        <ErrorBox error={save.error} />
        <div className="grid grid-4">
          <Field label="Amount received">
            <div className="row">
              <input className="input" type="number" min="0" step="any" value={amount} onChange={(e) => setAmount(e.target.value)} autoFocus />
              <Button size="sm" onClick={() => setAmount(String(c.due))}>Full</Button>
            </div>
          </Field>
          <Field label="Received into">
            <select className="select" value={accountId} onChange={(e) => setAccountId(e.target.value)}>
              {moneyAccounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
            </select>
          </Field>
          <Field label="Date"><input className="input" type="date" value={paymentDate} onChange={(e) => setPaymentDate(e.target.value)} /></Field>
          <Field label="Note"><input className="input" value={note} onChange={(e) => setNote(e.target.value)} /></Field>
        </div>
        <DataTable compact rows={preview} empty="This customer has no dues." columns={[
          { key: 'number', header: 'Invoice' },
          { key: 'sale_date', header: 'Date', render: (r) => date(r.sale_date) },
          { key: 'due_amount', header: 'Due', num: true, render: (r) => money(r.due_amount) },
          { key: 'applied', header: 'Will apply', num: true, render: (r) => (r.applied > 0 ? <span className="green">{money(r.applied)}</span> : '—') },
        ]} />
        <div className="row">
          <Button onClick={onDone}>Cancel</Button>
          <Button variant="primary" loading={save.isPending} disabled={!(Number(amount) > 0)} onClick={async () => {
            try {
              const r = await save.mutateAsync(undefined);
              toast(`${r.number}: ${money(Number(amount))} collected`);
              onDone();
            } catch { /* shown */ }
          }}>Receive payment</Button>
        </div>
      </div>
    </Card>
  );
}

export default function CollectDue() {
  const [params, setParams] = useSearchParams();
  const customerId = params.get('customer');
  const [q, setQ] = useState('');
  const dq = useDebounced(q);
  const { data: dues, isLoading } = useGet<any>('/customers', { q: dq, dueOnly: true, pageSize: 100 });
  const [page, setPage] = useState(1);
  const { data: history } = useGet<any>('/collections', { page, pageSize: 20 });

  return (
    <Page title="Collect Due" subtitle={`Outstanding: ${money(dues?.rows?.reduce((s: number, r: any) => s + r.due, 0) ?? 0)} from ${dues?.total ?? 0} customers`}>
      <div className="stack">
        {customerId ? (
          <CollectForm customerId={customerId} onDone={() => setParams({})} />
        ) : (
          <Card pad={false} title="Customers with dues">
            <div className="card-body" style={{ paddingBottom: 0 }}>
              <input className="input search" placeholder="Search customer…" value={q} onChange={(e) => setQ(e.target.value)} />
            </div>
            <DataTable loading={isLoading} rows={dues?.rows} onRowClick={(r) => setParams({ customer: r.id })} empty="No outstanding dues 🎉" columns={[
              { key: 'name', header: 'Customer', render: (r) => <><strong>{r.name}</strong><div className="small muted">{r.code}</div></> },
              { key: 'phone', header: 'Phone' },
              { key: 'last_sale', header: 'Last purchase', render: (r) => date(r.last_sale) },
              { key: 'due', header: 'Due', num: true, render: (r) => <Badge tone="red">{money(r.due)}</Badge> },
              { key: 'go', header: '', render: () => <Button size="sm" variant="primary">Collect</Button> },
            ]} />
          </Card>
        )}
        <Card pad={false} title="Recent collections">
          <DataTable rows={history?.rows} empty="No collections yet." columns={[
            { key: 'number', header: 'Receipt', render: (r) => <strong>{r.number}</strong> },
            { key: 'payment_date', header: 'Date', render: (r) => date(r.payment_date) },
            { key: 'customer_name', header: 'Customer' },
            { key: 'account_name', header: 'Into' },
            { key: 'applied_to', header: 'Applied to', render: (r) => <span className="small">{r.applied_to}</span> },
            { key: 'amount', header: 'Amount', num: true, render: (r) => money(r.amount) },
            { key: 'user_name', header: 'By' },
          ]} />
          <Pagination page={page} pageSize={20} total={history?.total ?? 0} onChange={setPage} />
        </Card>
      </div>
    </Page>
  );
}
