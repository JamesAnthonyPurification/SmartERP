import { useState } from 'react';
import { post, useAction, useGet, useLookups } from '../api';
import { Line, LineEditor } from '../components/LineEditor';
import { ProductHit, ProductSearch } from '../components/ProductSearch';
import { Button, Card, DataTable, ErrorBox, Field, Modal, Page, Pagination, useToast } from '../components/ui';
import { dateTime, money, num } from '../format';

function NewRun({ onClose }: { onClose: () => void }) {
  const { data: lookups } = useLookups();
  const toast = useToast();
  const allowed = lookups?.warehouses.filter((w) => w.allowed) ?? [];
  const moneyAccounts = lookups?.accounts.filter((a) => a.is_money) ?? [];
  const [warehouseId, setWarehouseId] = useState(allowed.find((w) => w.kind === 'factory')?.id ?? allowed[0]?.id ?? '');
  const [output, setOutput] = useState<ProductHit | null>(null);
  const [outputQty, setOutputQty] = useState('');
  const [inputs, setInputs] = useState<Line[]>([]);
  const [extraCost, setExtraCost] = useState('');
  const [accountId, setAccountId] = useState(moneyAccounts[0]?.id ?? '');
  const [note, setNote] = useState('');
  const save = useAction(() => post('/production', {
    warehouseId, outputProductId: output?.id, outputQty: Number(outputQty), extraCost: Number(extraCost || 0), accountId, note: note || null,
    inputs: inputs.map((l) => ({ productId: l.productId, qty: Number(l.qty) })),
  }), ['/production', '/products', '/dashboard', '/pos']);

  return (
    <Modal open size="xwide" title="Record production run" onClose={onClose} footer={
      <>
        <Button onClick={onClose}>Cancel</Button>
        <Button variant="primary" loading={save.isPending} disabled={!output || !inputs.length || !(Number(outputQty) > 0)} onClick={async () => {
          try {
            const r = await save.mutateAsync(undefined);
            toast(`${r.number}: unit cost ${money(r.unitCost)}`);
            onClose();
          } catch { /* shown */ }
        }}>Complete production</Button>
      </>
    }>
      <div className="stack">
        <ErrorBox error={save.error} />
        <div className="grid grid-3">
          <Field label="Factory / location">
            <select className="select" value={warehouseId} onChange={(e) => setWarehouseId(e.target.value)}>
              {allowed.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
            </select>
          </Field>
          <Field label="Finished product">
            {output ? (
              <div className="row between card" style={{ padding: '8px 12px' }}><strong>{output.name}</strong><button className="link small" onClick={() => setOutput(null)}>Change</button></div>
            ) : <ProductSearch onSelect={setOutput} warehouseId={warehouseId} />}
          </Field>
          <Field label={`Quantity produced${output ? ` (${output.unit})` : ''}`}>
            <input className="input" type="number" min="0" step="any" value={outputQty} onChange={(e) => setOutputQty(e.target.value)} />
          </Field>
        </div>
        <h4 className="card-title" style={{ fontSize: 15 }}>Raw materials consumed</h4>
        <LineEditor lines={inputs} onChange={setInputs} warehouseId={warehouseId} />
        <div className="grid grid-3">
          <Field label="Labour / overhead cost" hint="Added to the finished goods cost">
            <input className="input" type="number" min="0" step="any" value={extraCost} placeholder="0" onChange={(e) => setExtraCost(e.target.value)} />
          </Field>
          <Field label="Paid from">
            <select className="select" value={accountId} onChange={(e) => setAccountId(e.target.value)}>
              {moneyAccounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
            </select>
          </Field>
          <Field label="Batch note"><input className="input" value={note} onChange={(e) => setNote(e.target.value)} /></Field>
        </div>
      </div>
    </Modal>
  );
}

export default function Production() {
  const [page, setPage] = useState(1);
  const [open, setOpen] = useState(false);
  const { data, isLoading } = useGet<any>('/production', { page, pageSize: 30 });
  return (
    <Page title="Production" subtitle="Turn raw materials into finished goods with automatic costing" actions={<Button variant="primary" onClick={() => setOpen(true)}>＋ New production run</Button>}>
      <Card pad={false}>
        <DataTable loading={isLoading} rows={data?.rows} empty="No production runs yet." columns={[
          { key: 'number', header: 'Batch', render: (r) => <strong>{r.number}</strong> },
          { key: 'created_at', header: 'When', render: (r) => dateTime(r.created_at) },
          { key: 'output_product', header: 'Produced', render: (r) => `${num(r.output_qty)} ${r.output_unit} ${r.output_product}` },
          { key: 'inputs', header: 'Materials', render: (r) => <span className="small">{r.inputs?.map((i: any) => `${i.product} ×${num(i.qty)}`).join(', ')}</span> },
          { key: 'materials_cost', header: 'Materials', num: true, render: (r) => money(r.materials_cost) },
          { key: 'extra_cost', header: 'Overhead', num: true, render: (r) => money(r.extra_cost) },
          { key: 'unit_cost', header: 'Unit cost', num: true, render: (r) => <strong>{money(r.unit_cost)}</strong> },
          { key: 'warehouse_name', header: 'Location' },
        ]} />
        <Pagination page={page} pageSize={30} total={data?.total ?? 0} onChange={setPage} />
      </Card>
      {open && <NewRun onClose={() => setOpen(false)} />}
    </Page>
  );
}
