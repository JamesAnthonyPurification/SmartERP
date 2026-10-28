import { useEffect, useState } from 'react';
import { put, useAction, useGet } from '../api';
import { localToday } from '../format';
import { Button, Card, DataTable, ErrorBox, Field, Page, Spinner, Tabs, useToast } from '../components/ui';

const STATUSES = ['present', 'late', 'half_day', 'absent', 'leave', 'holiday'] as const;
const LABEL: Record<string, string> = { present: 'Present', late: 'Late', half_day: 'Half day', absent: 'Absent', leave: 'Leave', holiday: 'Holiday' };

function Daily() {
  const toast = useToast();
  const [day, setDay] = useState('');
  const { data, isLoading } = useGet<any>('/attendance', { date: day }, { refetchOnWindowFocus: false });
  const [rows, setRows] = useState<Record<string, any>>({});
  useEffect(() => {
    if (data) {
      setDay(data.date);
      setRows(Object.fromEntries(data.rows.map((r: any) => [r.employee_id, { status: r.status ?? '', checkIn: r.check_in?.slice(0, 5) ?? '', checkOut: r.check_out?.slice(0, 5) ?? '', note: r.note ?? '' }])));
    }
  }, [data]);
  const save = useAction(() => put('/attendance', {
    date: day,
    records: Object.entries(rows).filter(([, r]) => r.status).map(([employeeId, r]) => ({ employeeId, ...r, checkIn: r.checkIn || null, checkOut: r.checkOut || null, note: r.note || null })),
  }), ['/attendance']);
  const set = (id: string, patch: any) => setRows((s) => ({ ...s, [id]: { ...s[id], ...patch } }));
  const markAll = (status: string) => setRows((s) => Object.fromEntries(Object.entries(s).map(([k, v]) => [k, { ...v, status: v.status || status }])));

  if (isLoading || !data) return <Spinner />;
  return (
    <Card>
      <div className="stack">
        <div className="toolbar">
          <Field label="Date"><input className="input" type="date" value={day} onChange={(e) => setDay(e.target.value)} /></Field>
          <Button onClick={() => markAll('present')}>Mark unmarked as present</Button>
        </div>
        <ErrorBox error={save.error} />
        <DataTable rowKey="employee_id" rows={data.rows} empty="Add employees first." columns={[
          { key: 'name', header: 'Employee', render: (r) => <><strong>{r.name}</strong><div className="small muted">{r.code} · {r.designation}</div></> },
          { key: 'status', header: 'Status', render: (r) => (
            <div className="chips">
              {STATUSES.map((s) => (
                <button key={s} className={`chip ${rows[r.employee_id]?.status === s ? 'active' : ''}`} onClick={() => set(r.employee_id, { status: s })}>{LABEL[s]}</button>
              ))}
            </div>
          ) },
          { key: 'in', header: 'In', render: (r) => <input className="input sm" type="time" value={rows[r.employee_id]?.checkIn ?? ''} onChange={(e) => set(r.employee_id, { checkIn: e.target.value })} /> },
          { key: 'out', header: 'Out', render: (r) => <input className="input sm" type="time" value={rows[r.employee_id]?.checkOut ?? ''} onChange={(e) => set(r.employee_id, { checkOut: e.target.value })} /> },
          { key: 'note', header: 'Note', render: (r) => <input className="input sm" value={rows[r.employee_id]?.note ?? ''} onChange={(e) => set(r.employee_id, { note: e.target.value })} /> },
        ]} />
        <div className="row">
          <Button variant="primary" loading={save.isPending} onClick={async () => {
            try {
              const r = await save.mutateAsync(undefined);
              toast(`Attendance saved for ${r.saved} employees`);
            } catch { /* shown */ }
          }}>Save attendance</Button>
        </div>
      </div>
    </Card>
  );
}

function Monthly() {
  const [month, setMonth] = useState(localToday().slice(0, 7));
  const { data, isLoading } = useGet<any[]>('/attendance/summary', { month });
  return (
    <Card pad={false}>
      <div className="card-body" style={{ paddingBottom: 0 }}>
        <Field label="Month"><input className="input" type="month" value={month} onChange={(e) => setMonth(e.target.value)} style={{ maxWidth: 200 }} /></Field>
      </div>
      <DataTable loading={isLoading} rowKey="employee_id" rows={data} columns={[
        { key: 'name', header: 'Employee', render: (r) => <><strong>{r.name}</strong><div className="small muted">{r.code}</div></> },
        ...STATUSES.map((s) => ({ key: s, header: LABEL[s], num: true })),
      ]} />
    </Card>
  );
}

export default function Attendance() {
  const [tab, setTab] = useState<'daily' | 'monthly'>('daily');
  return (
    <Page title="Attendance" subtitle="Daily attendance feeds absence deductions in payroll">
      <Tabs value={tab} onChange={setTab} tabs={[{ value: 'daily', label: 'Mark attendance' }, { value: 'monthly', label: 'Monthly summary' }]} />
      {tab === 'daily' ? <Daily /> : <Monthly />}
    </Page>
  );
}
