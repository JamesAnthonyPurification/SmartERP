import { useState } from 'react';
import { Link } from 'react-router-dom';
import { patch, post, useAction, useGet } from '../api';
import { useAuth } from '../auth';
import { FormModal } from '../components/FormModal';
import { Badge, Button, Card, DataTable, Modal, Page, Pagination, Spinner, useDebounced, useToast } from '../components/ui';
import { date, money } from '../format';

const FIELDS = [
  { name: 'name', label: 'Name', required: true, span: 2 as const },
  { name: 'code', label: 'Code', hint: 'Auto-generated when empty' },
  { name: 'phone', label: 'Phone', type: 'tel' as const },
  { name: 'email', label: 'Email', type: 'email' as const },
  { name: 'creditLimit', label: 'Credit limit', type: 'number' as const, hint: 'Empty = no limit' },
  { name: 'address', label: 'Address', type: 'textarea' as const, span: 2 as const },
  { name: 'isActive', label: 'Active', type: 'checkbox' as const },
];

function CustomerDetail({ id, onClose }: { id: string; onClose: () => void }) {
  const { data } = useGet<any>(`/customers/${id}`);
  return (
    <Modal open title={data?.name ?? 'Customer'} onClose={onClose} size="wide">
      {!data ? <Spinner /> : (
        <div className="stack">
          <div className="grid grid-3">
            <div className="stat" style={{ minHeight: 0 }}><div className="stat-label">Total purchases</div><div className="stat-value">{money(data.total_sales, 0)}</div></div>
            <div className="stat" style={{ minHeight: 0 }}><div className="stat-label">Outstanding due</div><div className="stat-value red">{money(data.due, 0)}</div></div>
            <div className="stat" style={{ minHeight: 0 }}><div className="stat-label">Invoices</div><div className="stat-value">{data.invoices}</div><div className="stat-sub">Last: {date(data.last_sale)}</div></div>
          </div>
          <dl className="kv">
            <dt>Code</dt><dd>{data.code}</dd>
            <dt>Phone</dt><dd>{data.phone ?? '—'}</dd>
            <dt>Address</dt><dd>{data.address ?? '—'}</dd>
            <dt>Credit limit</dt><dd>{data.credit_limit === null ? 'No limit' : money(data.credit_limit)}</dd>
          </dl>
          <h4 className="card-title">Open invoices</h4>
          <DataTable compact rows={data.openInvoices} empty="No dues 🎉" columns={[
            { key: 'number', header: 'Invoice' },
            { key: 'sale_date', header: 'Date', render: (r) => date(r.sale_date) },
            { key: 'total', header: 'Total', num: true, render: (r) => money(r.total) },
            { key: 'due_amount', header: 'Due', num: true, render: (r) => money(r.due_amount) },
          ]} />
          <div className="row">
            <Link className="btn btn-secondary" to={`/statements?type=customer&id=${data.id}`}>📄 Statement</Link>
            {data.due > 0 && <Link className="btn btn-primary" to={`/collect-due?customer=${data.id}`}>💰 Collect due</Link>}
          </div>
        </div>
      )}
    </Modal>
  );
}

export default function Customers() {
  const { can } = useAuth();
  const toast = useToast();
  const [q, setQ] = useState('');
  const [dueOnly, setDueOnly] = useState(false);
  const [page, setPage] = useState(1);
  const [edit, setEdit] = useState<any>(null);
  const [view, setView] = useState<string | null>(null);
  const dq = useDebounced(q);
  const { data, isLoading } = useGet<any>('/customers', { q: dq, page, pageSize: 50, dueOnly, status: 'all' });
  const save = useAction((v: any) => (v.id ? patch(`/customers/${v.id}`, v) : post('/customers', v)), ['/customers']);

  return (
    <Page title="Customers" subtitle={`${data?.total ?? 0} customers`} actions={can('customers.manage') && <Button variant="primary" onClick={() => setEdit({ isActive: true })}>＋ New customer</Button>}>
      <Card pad={false}>
        <div className="card-body" style={{ paddingBottom: 0 }}>
          <div className="toolbar">
            <input className="input search" placeholder="Search name, phone, code…" value={q} onChange={(e) => { setQ(e.target.value); setPage(1); }} />
            <label className="checkbox"><input type="checkbox" checked={dueOnly} onChange={(e) => setDueOnly(e.target.checked)} /> With dues only</label>
          </div>
        </div>
        <DataTable loading={isLoading} rows={data?.rows} onRowClick={(r) => setView(r.id)} empty="No customers yet." columns={[
          { key: 'name', header: 'Customer', render: (r) => <><strong>{r.name}</strong><div className="small muted">{r.code}</div></> },
          { key: 'phone', header: 'Phone' },
          { key: 'total_sales', header: 'Purchases', num: true, render: (r) => money(r.total_sales) },
          { key: 'due', header: 'Due', num: true, render: (r) => (r.due > 0 ? <Badge tone="red">{money(r.due)}</Badge> : '—') },
          { key: 'last_sale', header: 'Last purchase', render: (r) => date(r.last_sale) },
          { key: 'is_active', header: 'Status', render: (r) => (r.is_active ? <Badge tone="green">Active</Badge> : <Badge>Inactive</Badge>) },
          { key: 'actions', header: '', render: (r) => can('customers.manage') && (
            <Button size="sm" onClick={(e) => {
              e.stopPropagation();
              setEdit({ id: r.id, name: r.name, code: r.code, phone: r.phone, email: r.email, address: r.address, creditLimit: r.credit_limit, isActive: r.is_active });
            }}>Edit</Button>
          ) },
        ]} />
        <Pagination page={page} pageSize={50} total={data?.total ?? 0} onChange={setPage} />
      </Card>
      {view && <CustomerDetail id={view} onClose={() => setView(null)} />}
      <FormModal open={!!edit} title={edit?.id ? 'Edit customer' : 'New customer'} initial={edit} fields={FIELDS} onClose={() => setEdit(null)}
        onSubmit={async (v) => {
          await save.mutateAsync({ ...v, id: edit?.id });
          toast('Customer saved');
        }} />
    </Page>
  );
}
