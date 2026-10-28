import { useState } from 'react';
import { post, useAction, useGet, useLookups } from '../api';
import { useAuth } from '../auth';
import { FormModal } from '../components/FormModal';
import { Badge, Button, Card, DataTable, Page, Pagination, useToast } from '../components/ui';
import { date, money } from '../format';

export default function Finance() {
  const { can } = useAuth();
  const toast = useToast();
  const { data: lookups } = useLookups();
  const [kind, setKind] = useState<'all' | 'expense' | 'income'>('all');
  const [range, setRange] = useState({ from: '', to: '' });
  const [page, setPage] = useState(1);
  const [creating, setCreating] = useState<'expense' | 'income' | null>(null);
  const { data, isLoading } = useGet<any>('/finance', { kind, page, pageSize: 50, ...range });
  const save = useAction((v: any) => post('/finance', v), ['/finance', '/dashboard', '/accounts', '/reports']);
  const accounts = lookups?.accounts ?? [];

  return (
    <Page title="Finance" subtitle="Daily expenses and other income, posted straight to the ledger" actions={can('finance.manage') && (
      <>
        <Button onClick={() => setCreating('income')}>＋ Other income</Button>
        <Button variant="primary" onClick={() => setCreating('expense')}>＋ Expense</Button>
      </>
    )}>
      <Card pad={false}>
        <div className="card-body" style={{ paddingBottom: 0 }}>
          <div className="toolbar">
            <select className="select" value={kind} onChange={(e) => setKind(e.target.value as any)}>
              <option value="all">Expenses & income</option><option value="expense">Expenses</option><option value="income">Income</option>
            </select>
            <input className="input" type="date" value={range.from} onChange={(e) => setRange({ ...range, from: e.target.value })} aria-label="From" />
            <input className="input" type="date" value={range.to} onChange={(e) => setRange({ ...range, to: e.target.value })} aria-label="To" />
            <span className="muted">Total: <strong>{money(data?.sumAmount ?? 0)}</strong></span>
          </div>
        </div>
        <DataTable loading={isLoading} rows={data?.rows} empty="No entries yet." columns={[
          { key: 'number', header: 'Number', render: (r) => <strong>{r.number}</strong> },
          { key: 'entry_date', header: 'Date', render: (r) => date(r.entry_date) },
          { key: 'kind', header: 'Type', render: (r) => <Badge tone={r.kind === 'expense' ? 'red' : 'green'}>{r.kind}</Badge> },
          { key: 'category_name', header: 'Category' },
          { key: 'party', header: 'Paid to / from' },
          { key: 'account_name', header: 'Account' },
          { key: 'note', header: 'Note' },
          { key: 'amount', header: 'Amount', num: true, render: (r) => money(r.amount) },
        ]} />
        <Pagination page={page} pageSize={50} total={data?.total ?? 0} onChange={setPage} />
      </Card>
      <FormModal
        open={!!creating}
        title={creating === 'expense' ? 'Record expense' : 'Record other income'}
        initial={{ date: lookups?.settings.today, moneyAccountId: accounts.find((a) => a.is_money)?.id }}
        onClose={() => setCreating(null)}
        fields={[
          { name: 'categoryAccountId', label: 'Category', type: 'select', required: true,
            options: accounts.filter((a) => a.type === creating && !['COGS', 'INV_ADJ', 'SALES', 'SALES_RETURNS', 'REPLACEMENT'].includes(a.system_key ?? '')).map((a) => ({ value: a.id, label: a.name })) },
          { name: 'amount', label: 'Amount', type: 'number', required: true },
          { name: 'moneyAccountId', label: creating === 'expense' ? 'Paid from' : 'Received into', type: 'select', required: true,
            options: accounts.filter((a) => a.is_money).map((a) => ({ value: a.id, label: a.name })) },
          { name: 'date', label: 'Date', type: 'date' },
          { name: 'party', label: creating === 'expense' ? 'Paid to' : 'Received from' },
          { name: 'reference', label: 'Reference / voucher #' },
          { name: 'note', label: 'Note', type: 'textarea', span: 2 },
        ]}
        onSubmit={async (v) => {
          const r = await save.mutateAsync({ ...v, kind: creating });
          toast(`${r.number} recorded`);
        }}
      />
    </Page>
  );
}
