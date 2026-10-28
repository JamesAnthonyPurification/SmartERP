import { useEffect, useState } from 'react';
import { del, patch, post, put, useAction, useGet, useLookups } from '../api';
import { useAuth } from '../auth';
import { FormModal } from '../components/FormModal';
import { Badge, Button, Card, DataTable, ErrorBox, Field, Modal, Page, Spinner, Tabs, useToast } from '../components/ui';
import { dateTime } from '../format';

function Settings() {
  const toast = useToast();
  const { refresh } = useAuth();
  const { data } = useGet<any>('/settings');
  const [f, setF] = useState<any>(null);
  useEffect(() => {
    if (data) {
      setF({
        companyName: data.company_name, tagline: data.tagline, businessType: data.business_type ?? '', address: data.address ?? '', phone: data.phone ?? '',
        email: data.email ?? '', taxId: data.tax_id ?? '', currencySymbol: data.currency_symbol, currencyCode: data.currency_code, timezone: data.timezone,
        defaultVatRate: data.default_vat_rate, invoicePrefix: data.invoice_prefix, receiptFooter: data.receipt_footer, allowNegativeStock: data.allow_negative_stock,
      });
    }
  }, [data]);
  const save = useAction(() => put('/settings', f), ['/settings', '/lookups']);
  if (!f) return <Spinner />;
  const input = (k: string, label: string, props: any = {}) => (
    <Field label={label} className={props.span ? 'span-2' : ''} hint={props.hint}>
      <input className="input" value={f[k]} onChange={(e) => setF({ ...f, [k]: e.target.value })} {...props} />
    </Field>
  );
  return (
    <Card>
      <div className="stack">
        <ErrorBox error={save.error} />
        <div className="form-grid">
          {input('companyName', 'Business name (shown in header and receipts)')}
          {input('tagline', 'Tagline')}
          {input('businessType', 'Business type')}
          {input('taxId', 'BIN / VAT registration')}
          {input('phone', 'Phone')}
          {input('email', 'Email')}
          {input('address', 'Address', { span: true })}
          {input('currencySymbol', 'Currency symbol')}
          {input('currencyCode', 'Currency code')}
          {input('timezone', 'Time zone', { hint: 'e.g. Asia/Dhaka — sets the business day for reports' })}
          {input('defaultVatRate', 'Default VAT %', { type: 'number', step: 'any' })}
          {input('invoicePrefix', 'Invoice prefix', { hint: 'e.g. INV → INV-000123' })}
          {input('receiptFooter', 'Receipt footer')}
          <label className="checkbox span-2">
            <input type="checkbox" checked={f.allowNegativeStock} onChange={(e) => setF({ ...f, allowNegativeStock: e.target.checked })} />
            Allow selling below zero stock (not recommended)
          </label>
        </div>
        <div className="row">
          <Button variant="primary" loading={save.isPending} onClick={async () => {
            try { await save.mutateAsync(undefined); await refresh(); toast('Settings saved'); } catch { /* shown */ }
          }}>Save settings</Button>
        </div>
      </div>
    </Card>
  );
}

function Users() {
  const toast = useToast();
  const { me } = useAuth();
  const { data: lookups } = useLookups();
  const { data, isLoading } = useGet<any[]>('/users');
  const { data: roles } = useGet<any[]>('/roles');
  const [adding, setAdding] = useState(false);
  const [edit, setEdit] = useState<any>(null);
  const [reset, setReset] = useState<any>(null);
  const add = useAction((v: any) => post('/users', v), ['/users', '/roles']);
  const update = useAction((v: any) => patch(`/users/${edit.id}`, v), ['/users', '/roles']);
  const resetPw = useAction((v: any) => post(`/users/${reset.id}/reset-password`, v), []);
  const whName = (ids: string[] | null) => (ids ? ids.map((id) => lookups?.warehouses.find((w) => w.id === id)?.name).join(', ') : 'All branches');
  const roleOptions = roles?.map((r) => ({ value: r.id, label: r.name })) ?? [];
  const whOptions = [{ value: '', label: 'All branches' }, ...(lookups?.warehouses.map((w) => ({ value: w.id, label: `Only ${w.name}` })) ?? [])];

  return (
    <Card pad={false} title="Users" actions={<Button variant="primary" onClick={() => setAdding(true)}>＋ Add user</Button>}>
      <DataTable loading={isLoading} rows={data} columns={[
        { key: 'name', header: 'User', render: (r) => <><strong>{r.name}</strong><div className="small muted">{r.email}</div></> },
        { key: 'role_name', header: 'Role', render: (r) => <Badge tone={r.role_name === 'Owner' ? 'red' : 'blue'}>{r.role_name}</Badge> },
        { key: 'warehouse_ids', header: 'Access', render: (r) => whName(r.warehouse_ids) },
        { key: 'last_login_at', header: 'Last sign-in', render: (r) => dateTime(r.last_login_at) },
        { key: 'is_active', header: 'Status', render: (r) => (r.is_active ? <Badge tone="green">Active</Badge> : <Badge>Disabled</Badge>) },
        { key: 'a', header: '', render: (r) => r.user_id !== me?.user.id && (
          <div className="row" style={{ justifyContent: 'flex-end' }}>
            <Button size="sm" onClick={() => setReset(r)}>Reset password</Button>
            <Button size="sm" onClick={() => setEdit(r)}>Edit</Button>
          </div>
        ) },
      ]} />
      <FormModal open={adding} title="Add user" onClose={() => setAdding(false)} initial={{ roleId: roles?.find((r) => r.name === 'Cashier')?.id }}
        fields={[
          { name: 'name', label: 'Full name', required: true },
          { name: 'email', label: 'Email (login)', type: 'email', required: true },
          { name: 'password', label: 'Initial password', type: 'password', hint: 'Not needed if this email already has a SmartERP account' },
          { name: 'roleId', label: 'Role', type: 'select', required: true, options: roleOptions },
          { name: 'warehouseId', label: 'Branch access', type: 'select', options: whOptions, span: 2 },
        ]}
        onSubmit={async (v) => {
          await add.mutateAsync({ ...v, warehouseIds: v.warehouseId ? [v.warehouseId] : null });
          toast('User added');
        }} />
      <FormModal open={!!edit} title={`Edit ${edit?.name ?? ''}`} onClose={() => setEdit(null)}
        initial={{ roleId: edit?.role_id, isActive: edit?.is_active, warehouseId: edit?.warehouse_ids?.[0] ?? '' }}
        fields={[
          { name: 'roleId', label: 'Role', type: 'select', required: true, options: roleOptions },
          { name: 'warehouseId', label: 'Branch access', type: 'select', options: whOptions },
          { name: 'isActive', label: 'Active (unchecking signs the user out)', type: 'checkbox', span: 2 },
        ]}
        onSubmit={async (v) => {
          await update.mutateAsync({ roleId: v.roleId, isActive: v.isActive, warehouseIds: v.warehouseId ? [v.warehouseId] : null });
          toast('User updated');
        }} />
      <FormModal open={!!reset} title={`Reset password for ${reset?.name ?? ''}`} onClose={() => setReset(null)}
        fields={[{ name: 'password', label: 'New password', type: 'password', required: true, span: 2, hint: 'At least 8 characters with letters and numbers' }]}
        onSubmit={async (v) => {
          await resetPw.mutateAsync(v);
          toast('Password reset; the user was signed out everywhere');
        }} />
    </Card>
  );
}

function Roles() {
  const toast = useToast();
  const { data, isLoading } = useGet<any[]>('/roles');
  const { data: catalog } = useGet<{ key: string; label: string }[]>('/permissions');
  const [edit, setEdit] = useState<any>(null);
  const save = useAction((v: any) => (v.id ? patch(`/roles/${v.id}`, v) : post('/roles', v)), ['/roles']);
  const remove = useAction((id: string) => del(`/roles/${id}`), ['/roles']);
  const groups = (catalog ?? []).reduce<Record<string, { key: string; label: string }[]>>((acc, p) => {
    const g = p.key.split('.')[0];
    (acc[g] ??= []).push(p);
    return acc;
  }, {});

  return (
    <Card pad={false} title="Roles & permissions" actions={<Button variant="primary" onClick={() => setEdit({ name: '', description: '', permissions: [] })}>＋ New role</Button>}>
      <DataTable loading={isLoading} rows={data} columns={[
        { key: 'name', header: 'Role', render: (r) => <><strong>{r.name}</strong> {r.is_system && <Badge>built-in</Badge>}<div className="small muted">{r.description}</div></> },
        { key: 'permissions', header: 'Permissions', render: (r) => (r.permissions.includes('*') ? 'Everything' : `${r.permissions.length} permissions`) },
        { key: 'member_count', header: 'Users', num: true },
        { key: 'a', header: '', render: (r) => !r.permissions.includes('*') && (
          <div className="row" style={{ justifyContent: 'flex-end' }}>
            <Button size="sm" onClick={() => setEdit({ ...r })}>Edit</Button>
            {!r.is_system && <Button size="sm" variant="danger" onClick={async () => {
              if (confirm(`Delete role ${r.name}?`)) await remove.mutateAsync(r.id).catch((e) => toast(e.message, 'error'));
            }}>Delete</Button>}
          </div>
        ) },
      ]} />
      {edit && (
        <Modal open size="wide" title={edit.id ? `Edit ${edit.name}` : 'New role'} onClose={() => setEdit(null)} footer={
          <>
            <Button onClick={() => setEdit(null)}>Cancel</Button>
            <Button variant="primary" loading={save.isPending} onClick={async () => {
              try {
                await save.mutateAsync({ id: edit.id, name: edit.name, description: edit.description || null, permissions: edit.permissions });
                toast('Role saved');
                setEdit(null);
              } catch { /* shown */ }
            }}>Save role</Button>
          </>
        }>
          <div className="stack">
            <ErrorBox error={save.error} />
            <div className="grid grid-2">
              <Field label="Name"><input className="input" value={edit.name} onChange={(e) => setEdit({ ...edit, name: e.target.value })} /></Field>
              <Field label="Description"><input className="input" value={edit.description ?? ''} onChange={(e) => setEdit({ ...edit, description: e.target.value })} /></Field>
            </div>
            <div className="grid grid-3">
              {Object.entries(groups).map(([g, perms]) => (
                <div key={g} className="card card-pad" style={{ padding: 14 }}>
                  <strong style={{ textTransform: 'capitalize' }}>{g}</strong>
                  {perms.map((p) => (
                    <label key={p.key} className="checkbox small" style={{ marginTop: 6 }}>
                      <input type="checkbox" checked={edit.permissions.includes(p.key)} onChange={(e) => setEdit({
                        ...edit, permissions: e.target.checked ? [...edit.permissions, p.key] : edit.permissions.filter((x: string) => x !== p.key),
                      })} />
                      {p.label}
                    </label>
                  ))}
                </div>
              ))}
            </div>
          </div>
        </Modal>
      )}
    </Card>
  );
}

export default function Configuration() {
  const { can } = useAuth();
  const tabs = [
    ...(can('settings.manage') ? [{ value: 'settings' as const, label: 'Business settings' }] : []),
    ...(can('users.manage') ? [{ value: 'users' as const, label: 'Users' }, { value: 'roles' as const, label: 'Roles' }] : []),
  ];
  const [tab, setTab] = useState(tabs[0]?.value ?? 'users');
  return (
    <Page title="Configuration" subtitle="Business profile, users and access control">
      <Tabs value={tab} onChange={setTab} tabs={tabs} />
      {tab === 'settings' && <Settings />}
      {tab === 'users' && <Users />}
      {tab === 'roles' && <Roles />}
    </Page>
  );
}
