import { useState } from 'react';
import { Link } from 'react-router-dom';
import { patch, post, useAction, useGet, useLookups } from '../api';
import { useAuth } from '../auth';
import { FormModal } from '../components/FormModal';
import { Badge, Button, Card, DataTable, Page, Pagination, useDebounced, useToast } from '../components/ui';
import { date, money } from '../format';

export default function Suppliers() {
  const { can } = useAuth();
  const toast = useToast();
  const { data: lookups } = useLookups();
  const [q, setQ] = useState('');
  const [page, setPage] = useState(1);
  const [edit, setEdit] = useState<any>(null);
  const [paying, setPaying] = useState<any>(null);
  const dq = useDebounced(q);
  const { data, isLoading } = useGet<any>('/suppliers', { q: dq, page, pageSize: 50 });
  const save = useAction((v: any) => (v.id ? patch(`/suppliers/${v.id}`, v) : post('/suppliers', v)), ['/suppliers']);
  const pay = useAction((v: any) => post(`/suppliers/${paying.id}/payments`, v), ['/suppliers', '/purchases', '/dashboard', '/accounts']);
  const moneyAccounts = lookups?.accounts.filter((a) => a.is_money) ?? [];

  return (
    <Page title="Suppliers" subtitle={`Payable: ${money(data?.rows?.reduce((s: number, r: any) => s + r.payable, 0) ?? 0)}`} actions={can('suppliers.manage') && <Button variant="primary" onClick={() => setEdit({ isActive: true })}>＋ New supplier</Button>}>
      <Card pad={false}>
        <div className="card-body" style={{ paddingBottom: 0 }}>
          <div className="toolbar"><input className="input search" placeholder="Search supplier…" value={q} onChange={(e) => { setQ(e.target.value); setPage(1); }} /></div>
        </div>
        <DataTable loading={isLoading} rows={data?.rows} empty="No suppliers yet." columns={[
          { key: 'name', header: 'Supplier', render: (r) => <><strong>{r.name}</strong><div className="small muted">{r.code}</div></> },
          { key: 'phone', header: 'Phone' },
          { key: 'total_purchases', header: 'Purchases', num: true, render: (r) => money(r.total_purchases) },
          { key: 'payable', header: 'Payable', num: true, render: (r) => (r.payable > 0 ? <Badge tone="red">{money(r.payable)}</Badge> : '—') },
          { key: 'last_purchase', header: 'Last purchase', render: (r) => date(r.last_purchase) },
          { key: 'actions', header: '', render: (r) => (
            <div className="row" style={{ justifyContent: 'flex-end' }}>
              {can('reports.view') && <Link className="btn btn-sm btn-ghost" to={`/statements?type=supplier&id=${r.id}`}>Statement</Link>}
              {can('suppliers.pay') && r.payable > 0 && <Button size="sm" variant="primary" onClick={() => setPaying(r)}>Pay</Button>}
              {can('suppliers.manage') && <Button size="sm" onClick={() => setEdit({ id: r.id, name: r.name, code: r.code, phone: r.phone, email: r.email, address: r.address, isActive: r.is_active })}>Edit</Button>}
            </div>
          ) },
        ]} />
        <Pagination page={page} pageSize={50} total={data?.total ?? 0} onChange={setPage} />
      </Card>
      <FormModal open={!!edit} title={edit?.id ? 'Edit supplier' : 'New supplier'} initial={edit} onClose={() => setEdit(null)}
        fields={[
          { name: 'name', label: 'Name', required: true, span: 2 },
          { name: 'code', label: 'Code', hint: 'Auto-generated when empty' },
          { name: 'phone', label: 'Phone', type: 'tel' },
          { name: 'email', label: 'Email', type: 'email', span: 2 },
          { name: 'address', label: 'Address', type: 'textarea', span: 2 },
          { name: 'isActive', label: 'Active', type: 'checkbox' },
        ]}
        onSubmit={async (v) => {
          await save.mutateAsync({ ...v, id: edit?.id });
          toast('Supplier saved');
        }} />
      <FormModal open={!!paying} title={`Pay ${paying?.name ?? ''}`} initial={{ amount: paying?.payable, accountId: moneyAccounts[0]?.id, paymentDate: lookups?.settings.today }}
        onClose={() => setPaying(null)}
        fields={[
          { name: 'amount', label: 'Amount', type: 'number', required: true, hint: `Payable ${money(paying?.payable)} — applied to oldest bills first` },
          { name: 'accountId', label: 'Pay from', type: 'select', required: true, options: moneyAccounts.map((a) => ({ value: a.id, label: a.name })) },
          { name: 'paymentDate', label: 'Date', type: 'date' },
          { name: 'note', label: 'Note' },
        ]}
        submitLabel="Pay supplier"
        onSubmit={async (v) => {
          const r = await pay.mutateAsync(v);
          toast(`${r.number} recorded`);
        }} />
    </Page>
  );
}
