import { useState } from 'react';
import { patch, post, useAction, useGet } from '../api';
import { FormModal } from '../components/FormModal';
import { Button, Card, DataTable, Page, StatusBadge, Tabs, useToast } from '../components/ui';
import { dateTime } from '../format';

/** Platform console: manages tenants only. Tenant business data is never visible here. */
export default function Platform() {
  const toast = useToast();
  const [tab, setTab] = useState<'tenants' | 'audit'>('tenants');
  const [creating, setCreating] = useState(false);
  const { data, isLoading } = useGet<any[]>('/platform/tenants');
  const audit = useGet<any[]>(tab === 'audit' ? '/platform/audit' : null);
  const create = useAction((v: any) => post('/platform/tenants', v), ['/platform']);
  const setStatus = useAction((v: { id: string; status: string }) => patch(`/platform/tenants/${v.id}`, { status: v.status }), ['/platform']);

  return (
    <Page title="Platform" subtitle="SmartERP tenant administration" actions={<Button variant="primary" onClick={() => setCreating(true)}>＋ New business</Button>}>
      <Tabs value={tab} onChange={setTab} tabs={[{ value: 'tenants', label: 'Businesses' }, { value: 'audit', label: 'Platform audit log' }]} />
      {tab === 'tenants' ? (
        <Card pad={false}>
          <DataTable loading={isLoading} rows={data} columns={[
            { key: 'name', header: 'Business', render: (r) => <><strong>{r.name}</strong><div className="small muted">ID: {r.slug}</div></> },
            { key: 'contact_email', header: 'Contact' },
            { key: 'created_at', header: 'Created', render: (r) => dateTime(r.created_at) },
            { key: 'status', header: 'Status', render: (r) => <StatusBadge status={r.status} /> },
            { key: 'a', header: '', render: (r) => (
              <Button size="sm" variant={r.status === 'active' ? 'danger' : 'success'} onClick={async () => {
                const status = r.status === 'active' ? 'suspended' : 'active';
                if (!confirm(`${status === 'suspended' ? 'Suspend' : 'Reactivate'} ${r.name}?`)) return;
                await setStatus.mutateAsync({ id: r.id, status });
                toast(`${r.name} ${status}`);
              }}>{r.status === 'active' ? 'Suspend' : 'Reactivate'}</Button>
            ) },
          ]} />
        </Card>
      ) : (
        <Card pad={false}>
          <DataTable loading={audit.isLoading} rows={audit.data} columns={[
            { key: 'created_at', header: 'When', render: (r) => dateTime(r.created_at) },
            { key: 'actor_email', header: 'Admin' },
            { key: 'action', header: 'Action' },
            { key: 'tenant_name', header: 'Business' },
            { key: 'details', header: 'Details', render: (r) => <code className="small">{JSON.stringify(r.details)}</code> },
          ]} />
        </Card>
      )}
      <FormModal open={creating} title="Provision a new business" onClose={() => setCreating(false)}
        fields={[
          { name: 'name', label: 'Business name', required: true },
          { name: 'slug', label: 'Business ID', required: true, hint: 'lowercase, e.g. rahman-traders' },
          { name: 'ownerName', label: 'Owner name', required: true },
          { name: 'ownerEmail', label: 'Owner email', type: 'email', required: true },
          { name: 'ownerPassword', label: 'Owner initial password', type: 'password', span: 2, hint: 'Required unless the owner already has a SmartERP account' },
        ]}
        submitLabel="Create business"
        onSubmit={async (v) => {
          const t = await create.mutateAsync(v);
          toast(`${t.name} created with default roles, accounts and a main store`);
        }} />
    </Page>
  );
}
