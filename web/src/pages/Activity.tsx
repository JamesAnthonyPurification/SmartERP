import { useState } from 'react';
import { useGet } from '../api';
import { Badge, Card, DataTable, Page, Pagination, useDebounced } from '../components/ui';
import { dateTime } from '../format';

const AREAS = ['', 'auth', 'sale', 'purchase', 'stock', 'product', 'customer', 'supplier', 'collection', 'finance', 'journal', 'payroll', 'user', 'role', 'settings'];

export default function Activity() {
  const [q, setQ] = useState('');
  const [action, setAction] = useState('');
  const [page, setPage] = useState(1);
  const dq = useDebounced(q);
  const { data, isLoading } = useGet<any>('/activity', { q: dq, action, page, pageSize: 50 });
  return (
    <Page title="Activity Logs" subtitle="Who did what, and when — an append-only audit trail">
      <Card pad={false}>
        <div className="card-body" style={{ paddingBottom: 0 }}>
          <div className="toolbar">
            <input className="input search" placeholder="Search activity…" value={q} onChange={(e) => { setQ(e.target.value); setPage(1); }} />
            <select className="select" value={action} onChange={(e) => { setAction(e.target.value); setPage(1); }}>
              {AREAS.map((a) => <option key={a} value={a}>{a ? a[0].toUpperCase() + a.slice(1) : 'All areas'}</option>)}
            </select>
          </div>
        </div>
        <DataTable loading={isLoading} rows={data?.rows} columns={[
          { key: 'created_at', header: 'When', render: (r) => <span className="nowrap">{dateTime(r.created_at)}</span> },
          { key: 'user_name', header: 'User', render: (r) => r.user_name ?? 'System' },
          { key: 'action', header: 'Action', render: (r) => <Badge>{r.action}</Badge> },
          { key: 'summary', header: 'Details' },
          { key: 'ip', header: 'IP', render: (r) => <span className="small muted">{r.ip}</span> },
        ]} />
        <Pagination page={page} pageSize={50} total={data?.total ?? 0} onChange={setPage} />
      </Card>
    </Page>
  );
}
