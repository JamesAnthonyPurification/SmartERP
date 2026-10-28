import { useState } from 'react';
import { post, useAction, useGet, useLookups } from '../api';
import { useAuth } from '../auth';
import { Line, LineEditor } from '../components/LineEditor';
import { Button, Card, DataTable, ErrorBox, Field, Modal, Page, Pagination, Tabs, useDebounced, useToast } from '../components/ui';
import { dateTime, money, num, titleCase } from '../format';

const REASONS = [
  { value: 'count', label: 'Physical count correction' },
  { value: 'damage', label: 'Damaged' },
  { value: 'expired', label: 'Expired' },
  { value: 'lost', label: 'Lost / theft' },
  { value: 'opening', label: 'Opening stock' },
  { value: 'other', label: 'Other' },
];

function AdjustModal({ mode, onClose }: { mode: 'adjust' | 'transfer'; onClose: () => void }) {
  const { data: lookups } = useLookups();
  const toast = useToast();
  const allowed = lookups?.warehouses.filter((w) => w.allowed) ?? [];
  const [warehouseId, setWarehouseId] = useState(allowed[0]?.id ?? '');
  const [toId, setToId] = useState(lookups?.warehouses.find((w) => w.id !== allowed[0]?.id)?.id ?? '');
  const [reason, setReason] = useState('count');
  const [note, setNote] = useState('');
  const [lines, setLines] = useState<Line[]>([]);
  const save = useAction(
    () =>
      mode === 'adjust'
        ? post('/adjustments', {
            warehouseId, reason, note: note || null,
            items: lines.map((l) => ({ productId: l.productId, qtyChange: Number(l.qty), unitCost: l.unitCost === '' ? null : Number(l.unitCost) })),
          })
        : post('/transfers', { fromWarehouseId: warehouseId, toWarehouseId: toId, note: note || null, items: lines.map((l) => ({ productId: l.productId, qty: Number(l.qty) })) }),
    ['/adjustments', '/transfers', '/products', '/dashboard', '/stock', '/pos'],
  );

  return (
    <Modal open size="xwide" title={mode === 'adjust' ? 'Stock adjustment' : 'Transfer stock'} onClose={onClose} footer={
      <>
        <Button onClick={onClose}>Cancel</Button>
        <Button variant="primary" loading={save.isPending} disabled={!lines.length} onClick={async () => {
          try {
            const r = await save.mutateAsync(undefined);
            toast(`${r.number} saved`);
            onClose();
          } catch { /* shown */ }
        }}>Save</Button>
      </>
    }>
      <div className="stack">
        <ErrorBox error={save.error} />
        <div className="grid grid-3">
          <Field label={mode === 'adjust' ? 'Warehouse' : 'From'}>
            <select className="select" value={warehouseId} onChange={(e) => setWarehouseId(e.target.value)}>
              {allowed.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
            </select>
          </Field>
          {mode === 'adjust' ? (
            <Field label="Reason">
              <select className="select" value={reason} onChange={(e) => setReason(e.target.value)}>
                {REASONS.map((r) => <option key={r.value} value={r.value}>{r.label}</option>)}
              </select>
            </Field>
          ) : (
            <Field label="To">
              <select className="select" value={toId} onChange={(e) => setToId(e.target.value)}>
                {lookups?.warehouses.filter((w) => w.id !== warehouseId).map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
              </select>
            </Field>
          )}
          <Field label="Note"><input className="input" value={note} onChange={(e) => setNote(e.target.value)} /></Field>
        </div>
        {mode === 'adjust' && <div className="info-box">Use a positive quantity to add stock and a negative quantity to remove it. Cost is only used when adding.</div>}
        <LineEditor lines={lines} onChange={setLines} warehouseId={warehouseId} signed={mode === 'adjust'} withCost={mode === 'adjust'} />
      </div>
    </Modal>
  );
}

function StockLevels() {
  const { data: lookups } = useLookups();
  const [warehouseId, setWarehouseId] = useState('');
  const [q, setQ] = useState('');
  const dq = useDebounced(q);
  const { data, isLoading } = useGet<any[]>('/stock', { warehouseId, q: dq });
  return (
    <Card pad={false}>
      <div className="card-body" style={{ paddingBottom: 0 }}>
        <div className="toolbar">
          <input className="input search" placeholder="Search product…" value={q} onChange={(e) => setQ(e.target.value)} />
          <select className="select" value={warehouseId} onChange={(e) => setWarehouseId(e.target.value)}>
            <option value="">All locations</option>
            {lookups?.warehouses.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
          </select>
        </div>
      </div>
      <DataTable loading={isLoading} rows={data} rowKey="key" columns={[
        { key: 'name', header: 'Product', render: (r) => <><strong>{r.name}</strong><div className="small muted">{r.sku}</div></> },
        { key: 'warehouse_name', header: 'Location' },
        { key: 'qty', header: 'Qty', num: true, render: (r) => <span className={r.qty <= r.reorder_level ? 'red' : ''}>{num(r.qty)} {r.unit}</span> },
        { key: 'avg_cost', header: 'Avg cost', num: true, render: (r) => money(r.avg_cost) },
        { key: 'value', header: 'Value', num: true, render: (r) => money(r.value) },
      ]} />
    </Card>
  );
}

function Movements() {
  const [page, setPage] = useState(1);
  const [q, setQ] = useState('');
  const dq = useDebounced(q);
  const { data, isLoading } = useGet<any>('/stock/movements', { page, pageSize: 50, q: dq });
  return (
    <Card pad={false}>
      <div className="card-body" style={{ paddingBottom: 0 }}>
        <div className="toolbar"><input className="input search" placeholder="Search product or reference…" value={q} onChange={(e) => setQ(e.target.value)} /></div>
      </div>
      <DataTable loading={isLoading} rows={data?.rows} columns={[
        { key: 'created_at', header: 'When', render: (r) => dateTime(r.created_at) },
        { key: 'product_name', header: 'Product' },
        { key: 'warehouse_name', header: 'Location' },
        { key: 'kind', header: 'Type', render: (r) => titleCase(r.kind) },
        { key: 'ref_number', header: 'Ref' },
        { key: 'qty_change', header: 'Change', num: true, render: (r) => <span className={r.qty_change < 0 ? 'red' : 'green'}>{r.qty_change > 0 ? '+' : ''}{num(r.qty_change)}</span> },
        { key: 'balance_after', header: 'Balance', num: true, render: (r) => num(r.balance_after) },
        { key: 'user_name', header: 'By' },
      ]} />
      <Pagination page={page} pageSize={50} total={data?.total ?? 0} onChange={setPage} />
    </Card>
  );
}

export default function StockAdjust() {
  const { can } = useAuth();
  const [tab, setTab] = useState<'adjustments' | 'transfers' | 'levels' | 'movements'>('adjustments');
  const [modal, setModal] = useState<'adjust' | 'transfer' | null>(null);
  const adjustments = useGet<any>(tab === 'adjustments' ? '/adjustments' : null, { pageSize: 100 });
  const transfers = useGet<any>(tab === 'transfers' ? '/transfers' : null, { pageSize: 100 });
  const items = (r: any, withCost = false) =>
    (r.items ?? []).map((i: any) => `${i.product} ${i.qty > 0 && withCost ? '+' : ''}${num(i.qty)}`).join(', ');

  return (
    <Page title="Stock Adjust" subtitle="Corrections, write-offs, transfers and the full stock ledger" actions={can('inventory.adjust') && (
      <>
        <Button onClick={() => setModal('transfer')}>⇄ Transfer</Button>
        <Button variant="primary" onClick={() => setModal('adjust')}>＋ Adjustment</Button>
      </>
    )}>
      <Tabs value={tab} onChange={setTab} tabs={[
        { value: 'adjustments', label: 'Adjustments' }, { value: 'transfers', label: 'Transfers' },
        { value: 'levels', label: 'Stock levels' }, { value: 'movements', label: 'Stock ledger' },
      ]} />
      {tab === 'adjustments' && (
        <Card pad={false}>
          <DataTable loading={adjustments.isLoading} rows={adjustments.data?.rows} empty="No adjustments yet." columns={[
            { key: 'number', header: 'Number', render: (r) => <strong>{r.number}</strong> },
            { key: 'created_at', header: 'When', render: (r) => dateTime(r.created_at) },
            { key: 'reason', header: 'Reason', render: (r) => titleCase(r.reason) },
            { key: 'warehouse_name', header: 'Location' },
            { key: 'items', header: 'Items', render: (r) => items(r, true) },
            { key: 'user_name', header: 'By' },
          ]} />
        </Card>
      )}
      {tab === 'transfers' && (
        <Card pad={false}>
          <DataTable loading={transfers.isLoading} rows={transfers.data?.rows} empty="No transfers yet." columns={[
            { key: 'number', header: 'Number', render: (r) => <strong>{r.number}</strong> },
            { key: 'created_at', header: 'When', render: (r) => dateTime(r.created_at) },
            { key: 'from_name', header: 'From' },
            { key: 'to_name', header: 'To' },
            { key: 'items', header: 'Items', render: (r) => items(r) },
            { key: 'user_name', header: 'By' },
          ]} />
        </Card>
      )}
      {tab === 'levels' && <StockLevels />}
      {tab === 'movements' && <Movements />}
      {modal && <AdjustModal mode={modal} onClose={() => setModal(null)} />}
    </Page>
  );
}
