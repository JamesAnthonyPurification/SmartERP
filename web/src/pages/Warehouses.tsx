import { useState } from 'react';
import { patch, post, useAction, useGet } from '../api';
import { useAuth } from '../auth';
import { FormModal } from '../components/FormModal';
import { Badge, Button, Card, DataTable, Page, useToast } from '../components/ui';
import { money, num, titleCase } from '../format';

export default function Warehouses() {
  const { can } = useAuth();
  const toast = useToast();
  const [edit, setEdit] = useState<any>(null);
  const { data, isLoading } = useGet<any[]>('/warehouses');
  const save = useAction((v: any) => (v.id ? patch(`/warehouses/${v.id}`, v) : post('/warehouses', v)), ['/warehouses', '/lookups']);

  return (
    <Page title="Warehouse" subtitle="Warehouses, branches, outlets and factories" actions={can('warehouses.manage') && <Button variant="primary" onClick={() => setEdit({ kind: 'branch', isActive: true })}>＋ New location</Button>}>
      <Card pad={false}>
        <DataTable loading={isLoading} rows={data} columns={[
          { key: 'code', header: 'Code', render: (r) => <strong>{r.code}</strong> },
          { key: 'name', header: 'Name', render: (r) => <>{r.name} {r.is_default && <Badge tone="red">Default</Badge>}<div className="small muted">{r.address}</div></> },
          { key: 'kind', header: 'Type', render: (r) => titleCase(r.kind) },
          { key: 'products', header: 'Products', num: true, render: (r) => num(r.products) },
          { key: 'units', header: 'Units', num: true, render: (r) => num(r.units) },
          { key: 'stock_value', header: 'Stock value', num: true, render: (r) => money(r.stock_value) },
          { key: 'is_active', header: 'Status', render: (r) => (r.is_active ? <Badge tone="green">Active</Badge> : <Badge>Closed</Badge>) },
          { key: 'actions', header: '', render: (r) => can('warehouses.manage') && (
            <Button size="sm" onClick={() => setEdit({ id: r.id, code: r.code, name: r.name, kind: r.kind, address: r.address, phone: r.phone, isActive: r.is_active, isDefault: r.is_default })}>Edit</Button>
          ) },
        ]} />
      </Card>
      <FormModal open={!!edit} title={edit?.id ? 'Edit location' : 'New location'} initial={edit} onClose={() => setEdit(null)}
        fields={[
          { name: 'code', label: 'Code', required: true, hint: 'Short code, e.g. MAIN, DHK2' },
          { name: 'name', label: 'Name', required: true },
          { name: 'kind', label: 'Type', type: 'select', required: true, options: ['branch', 'warehouse', 'outlet', 'factory'].map((k) => ({ value: k, label: titleCase(k) })) },
          { name: 'phone', label: 'Phone' },
          { name: 'address', label: 'Address', type: 'textarea', span: 2 },
          { name: 'isActive', label: 'Active', type: 'checkbox' },
          { name: 'isDefault', label: 'Default location', type: 'checkbox' },
        ]}
        onSubmit={async (v) => {
          await save.mutateAsync({ ...v, id: edit?.id });
          toast('Location saved');
        }} />
    </Page>
  );
}
