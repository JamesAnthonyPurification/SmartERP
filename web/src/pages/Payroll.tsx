import { useState } from 'react';
import { del, patch, post, useAction, useGet, useLookups } from '../api';
import { FormModal } from '../components/FormModal';
import { Button, Card, DataTable, ErrorBox, Modal, Page, Spinner, StatusBadge, useToast } from '../components/ui';
import { date, money } from '../format';

function RunDetail({ id, onClose }: { id: string; onClose: () => void }) {
  const toast = useToast();
  const { data: lookups } = useLookups();
  const { data, refetch } = useGet<any>(`/payroll/runs/${id}`);
  const [paying, setPaying] = useState(false);
  const [editing, setEditing] = useState<any>(null);
  const pay = useAction((v: any) => post(`/payroll/runs/${id}/pay`, v), ['/payroll', '/dashboard', '/accounts']);
  const adjust = useAction((v: any) => patch(`/payroll/runs/${id}/items/${editing.employee_id}`, v), ['/payroll']);
  const remove = useAction(() => del(`/payroll/runs/${id}`), ['/payroll']);
  const draft = data?.status === 'draft';

  return (
    <Modal open size="xwide" title={data ? `Payroll ${data.period}` : 'Payroll'} onClose={onClose} footer={data && draft && (
      <>
        <Button variant="danger" onClick={async () => {
          if (!confirm('Delete this draft payroll?')) return;
          await remove.mutateAsync(undefined);
          onClose();
        }}>Delete draft</Button>
        <Button variant="primary" onClick={() => setPaying(true)}>Pay {money(data.total)}</Button>
      </>
    )}>
      {!data ? <Spinner /> : (
        <div className="stack">
          <div className="row between">
            <span><StatusBadge status={data.status} /> {data.status === 'paid' && `Paid ${date(data.paid_date)} from ${data.account_name}`}</span>
            <strong className="display" style={{ fontSize: 22 }}>{money(data.total)}</strong>
          </div>
          <ErrorBox error={pay.error ?? adjust.error} />
          <DataTable rowKey="employee_id" rows={data.items} columns={[
            { key: 'name', header: 'Employee', render: (r) => <><strong>{r.name}</strong><div className="small muted">{r.code} · {r.designation}</div></> },
            { key: 'base_salary', header: 'Salary', num: true, render: (r) => money(r.base_salary) },
            { key: 'absent_days', header: 'Absent days', num: true },
            { key: 'deduction', header: 'Deduction', num: true, render: (r) => <span className="red">{money(r.deduction)}</span> },
            { key: 'bonus', header: 'Bonus', num: true, render: (r) => <span className="green">{money(r.bonus)}</span> },
            { key: 'net_pay', header: 'Net pay', num: true, render: (r) => <strong>{money(r.net_pay)}</strong> },
            { key: 'a', header: '', render: (r) => draft && <Button size="sm" onClick={() => setEditing(r)}>Adjust</Button> },
          ]} />
        </div>
      )}
      <FormModal open={paying} title="Pay salaries" onClose={() => setPaying(false)}
        initial={{ accountId: lookups?.accounts.find((a) => a.money_kind === 'bank')?.id, date: lookups?.settings.today }}
        fields={[
          { name: 'accountId', label: 'Pay from', type: 'select', required: true, options: lookups?.accounts.filter((a) => a.is_money).map((a) => ({ value: a.id, label: a.name })) },
          { name: 'date', label: 'Payment date', type: 'date' },
        ]}
        submitLabel="Confirm payment"
        onSubmit={async (v) => {
          await pay.mutateAsync(v);
          toast('Payroll paid and posted to the ledger');
          refetch();
        }} />
      <FormModal open={!!editing} title={`Adjust ${editing?.name ?? ''}`} onClose={() => setEditing(null)}
        initial={{ bonus: editing?.bonus, deduction: editing?.deduction }}
        fields={[
          { name: 'bonus', label: 'Bonus / allowance', type: 'number' },
          { name: 'deduction', label: 'Deduction', type: 'number', hint: 'Absence, advance recovery, etc.' },
        ]}
        onSubmit={async (v) => {
          await adjust.mutateAsync({ bonus: v.bonus ?? 0, deduction: v.deduction ?? 0 });
          refetch();
        }} />
    </Modal>
  );
}

export default function Payroll() {
  const toast = useToast();
  const [creating, setCreating] = useState(false);
  const [view, setView] = useState<string | null>(null);
  const { data, isLoading } = useGet<any[]>('/payroll/runs');
  const create = useAction((v: any) => post('/payroll/runs', v), ['/payroll']);
  const lastMonth = (() => {
    const d = new Date();
    d.setDate(0);
    return d.toLocaleDateString('en-CA').slice(0, 7);
  })();

  return (
    <Page title="Payroll" subtitle="Monthly salary runs with attendance-based deductions" actions={<Button variant="primary" onClick={() => setCreating(true)}>＋ New payroll</Button>}>
      <Card pad={false}>
        <DataTable loading={isLoading} rows={data} onRowClick={(r) => setView(r.id)} empty="No payroll runs yet." columns={[
          { key: 'period', header: 'Month', render: (r) => <strong>{r.period}</strong> },
          { key: 'employees', header: 'Employees', num: true },
          { key: 'total', header: 'Total', num: true, render: (r) => money(r.total) },
          { key: 'status', header: 'Status', render: (r) => <StatusBadge status={r.status} /> },
          { key: 'paid_date', header: 'Paid', render: (r) => (r.paid_date ? `${date(r.paid_date)} · ${r.account_name}` : '—') },
        ]} />
      </Card>
      {view && <RunDetail id={view} onClose={() => setView(null)} />}
      <FormModal open={creating} title="New payroll run" onClose={() => setCreating(false)} initial={{ period: lastMonth, deductAbsences: true }}
        fields={[
          { name: 'period', label: 'Month', type: 'month', required: true },
          { name: 'deductAbsences', label: 'Deduct pay for absent days (from attendance)', type: 'checkbox', span: 2 },
        ]}
        submitLabel="Create draft"
        onSubmit={async (v) => {
          const r = await create.mutateAsync(v);
          toast(`Draft created for ${r.period}`);
          setView(r.id);
        }} />
    </Page>
  );
}
