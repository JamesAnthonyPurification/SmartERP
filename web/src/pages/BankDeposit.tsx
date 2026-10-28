import { useState } from 'react';
import { post, useAction, useGet, useLookups } from '../api';
import { useAuth } from '../auth';
import { FormModal } from '../components/FormModal';
import { Button, Card, DataTable, Page, Pagination, useToast } from '../components/ui';
import { date, money } from '../format';

export default function BankDeposit() {
  const { can } = useAuth();
  const toast = useToast();
  const { data: lookups } = useLookups();
  const { data: dashboard } = useGet<any>(can('dashboard.view') ? '/dashboard' : null);
  const [page, setPage] = useState(1);
  const [open, setOpen] = useState(false);
  const { data, isLoading } = useGet<any>('/fund-transfers', { page, pageSize: 50 });
  const save = useAction((v: any) => post('/fund-transfers', v), ['/fund-transfers', '/dashboard', '/accounts']);
  const moneyAccounts = lookups?.accounts.filter((a) => a.is_money) ?? [];
  const cash = moneyAccounts.find((a) => a.money_kind === 'cash');
  const bank = moneyAccounts.find((a) => a.money_kind === 'bank');

  return (
    <Page title="Bank Deposit" subtitle="Move money between cash, bank and mobile wallets" actions={can('finance.manage') && <Button variant="primary" onClick={() => setOpen(true)}>＋ New deposit / transfer</Button>}>
      {dashboard && (
        <div className="grid grid-3 mb">
          {dashboard.money.map((a: any) => (
            <div key={a.id} className="stat" style={{ minHeight: 0 }}>
              <span className="stat-icon">{a.money_kind === 'cash' ? '💵' : a.money_kind === 'bank' ? '🏦' : '📱'}</span>
              <div className="stat-label">{a.name}</div>
              <div className="stat-value">{money(a.balance, 0)}</div>
            </div>
          ))}
        </div>
      )}
      <Card pad={false}>
        <DataTable loading={isLoading} rows={data?.rows} empty="No deposits or transfers yet." columns={[
          { key: 'number', header: 'Number', render: (r) => <strong>{r.number}</strong> },
          { key: 'transfer_date', header: 'Date', render: (r) => date(r.transfer_date) },
          { key: 'from_name', header: 'From' },
          { key: 'to_name', header: 'To' },
          { key: 'reference', header: 'Deposit slip / ref' },
          { key: 'amount', header: 'Amount', num: true, render: (r) => money(r.amount) },
          { key: 'user_name', header: 'By' },
        ]} />
        <Pagination page={page} pageSize={50} total={data?.total ?? 0} onChange={setPage} />
      </Card>
      <FormModal open={open} title="Bank deposit / transfer" onClose={() => setOpen(false)}
        initial={{ fromAccountId: cash?.id, toAccountId: bank?.id, date: lookups?.settings.today }}
        fields={[
          { name: 'fromAccountId', label: 'From', type: 'select', required: true, options: moneyAccounts.map((a) => ({ value: a.id, label: a.name })) },
          { name: 'toAccountId', label: 'To', type: 'select', required: true, options: moneyAccounts.map((a) => ({ value: a.id, label: a.name })) },
          { name: 'amount', label: 'Amount', type: 'number', required: true },
          { name: 'date', label: 'Date', type: 'date' },
          { name: 'reference', label: 'Deposit slip / reference' },
          { name: 'note', label: 'Note' },
        ]}
        submitLabel="Record transfer"
        onSubmit={async (v) => {
          const r = await save.mutateAsync(v);
          toast(`${r.number} recorded`);
        }} />
    </Page>
  );
}
