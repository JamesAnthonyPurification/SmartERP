import { useState } from 'react';
import { patch, post, useAction, useGet, useLookups } from '../api';
import { useAuth } from '../auth';
import { FormModal } from '../components/FormModal';
import { Badge, Button, Card, DataTable, Page, Pagination, useDebounced, useToast } from '../components/ui';
import { date, money } from '../format';

export default function Employees() {
  const { can } = useAuth();
  const toast = useToast();
  const { data: lookups } = useLookups();
  const [q, setQ] = useState('');
  const [status, setStatus] = useState('active');
  const [page, setPage] = useState(1);
  const [edit, setEdit] = useState<any>(null);
  const dq = useDebounced(q);
  const { data, isLoading } = useGet<any>('/employees', { q: dq, status, page, pageSize: 50 });
  const save = useAction((v: any) => (v.id ? patch(`/employees/${v.id}`, v) : post('/employees', v)), ['/employees', '/attendance']);

  return (
    <Page title="Employees" subtitle={`${data?.total ?? 0} employees · monthly salary ${money(data?.rows?.filter((r: any) => r.is_active).reduce((s: number, r: any) => s + r.base_salary, 0) ?? 0)}`}
      actions={can('hr.manage') && <Button variant="primary" onClick={() => setEdit({ isActive: true })}>＋ New employee</Button>}>
      <Card pad={false}>
        <div className="card-body" style={{ paddingBottom: 0 }}>
          <div className="toolbar">
            <input className="input search" placeholder="Search name, code, phone, designation…" value={q} onChange={(e) => setQ(e.target.value)} />
            <select className="select" value={status} onChange={(e) => setStatus(e.target.value)}>
              <option value="active">Active</option><option value="all">All</option>
            </select>
          </div>
        </div>
        <DataTable loading={isLoading} rows={data?.rows} empty="No employees yet." columns={[
          { key: 'name', header: 'Employee', render: (r) => <><strong>{r.name}</strong><div className="small muted">{r.code}</div></> },
          { key: 'designation', header: 'Designation', render: (r) => <>{r.designation ?? '—'}<div className="small muted">{r.department}</div></> },
          { key: 'phone', header: 'Phone' },
          { key: 'warehouse_name', header: 'Branch' },
          { key: 'join_date', header: 'Joined', render: (r) => date(r.join_date) },
          { key: 'base_salary', header: 'Salary', num: true, render: (r) => money(r.base_salary) },
          { key: 'is_active', header: 'Status', render: (r) => (r.is_active ? <Badge tone="green">Active</Badge> : <Badge>Left</Badge>) },
          { key: 'actions', header: '', render: (r) => can('hr.manage') && (
            <Button size="sm" onClick={() => setEdit({
              id: r.id, code: r.code, name: r.name, phone: r.phone, email: r.email, designation: r.designation, department: r.department,
              joinDate: r.join_date, baseSalary: r.base_salary, warehouseId: r.warehouse_id, address: r.address, isActive: r.is_active,
            })}>Edit</Button>
          ) },
        ]} />
        <Pagination page={page} pageSize={50} total={data?.total ?? 0} onChange={setPage} />
      </Card>
      <FormModal open={!!edit} size="wide" title={edit?.id ? 'Edit employee' : 'New employee'} initial={edit} onClose={() => setEdit(null)}
        fields={[
          { name: 'name', label: 'Full name', required: true },
          { name: 'code', label: 'Employee ID', hint: 'Auto-generated when empty', required: !!edit?.id },
          { name: 'designation', label: 'Designation' },
          { name: 'department', label: 'Department' },
          { name: 'phone', label: 'Phone', type: 'tel' },
          { name: 'email', label: 'Email', type: 'email' },
          { name: 'joinDate', label: 'Join date', type: 'date' },
          { name: 'baseSalary', label: 'Monthly salary', type: 'number', required: true },
          { name: 'warehouseId', label: 'Branch', type: 'select', options: lookups?.warehouses.map((w) => ({ value: w.id, label: w.name })) },
          { name: 'isActive', label: 'Currently employed', type: 'checkbox' },
          { name: 'address', label: 'Address', type: 'textarea', span: 2 },
        ]}
        onSubmit={async (v) => {
          await save.mutateAsync({ ...v, id: edit?.id });
          toast('Employee saved');
        }} />
    </Page>
  );
}
