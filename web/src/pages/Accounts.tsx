import { useState } from 'react';
import { Link } from 'react-router-dom';
import { patch, post, useAction, useGet, useLookups } from '../api';
import { useAuth } from '../auth';
import { FormModal } from '../components/FormModal';
import { Badge, Button, Card, DataTable, ErrorBox, Field, Modal, Page, Pagination, Tabs, useToast } from '../components/ui';
import { date, money, titleCase } from '../format';

const TYPE_TONE = { asset: 'blue', liability: 'amber', equity: 'purple', income: 'green', expense: 'red' } as const;

function ManualJournal({ onClose }: { onClose: () => void }) {
  const { data: lookups } = useLookups();
  const toast = useToast();
  const [memo, setMemo] = useState('');
  const [entryDate, setEntryDate] = useState(lookups?.settings.today ?? '');
  const [lines, setLines] = useState([{ accountId: '', debit: '', credit: '' }, { accountId: '', debit: '', credit: '' }]);
  const save = useAction(() => post('/journal', {
    date: entryDate, memo,
    lines: lines.filter((l) => l.accountId).map((l) => ({ accountId: l.accountId, debit: Number(l.debit || 0), credit: Number(l.credit || 0) })),
  }), ['/journal', '/accounts', '/dashboard', '/reports']);
  const dr = lines.reduce((s, l) => s + Number(l.debit || 0), 0);
  const cr = lines.reduce((s, l) => s + Number(l.credit || 0), 0);
  const set = (i: number, k: string, v: string) => setLines(lines.map((l, j) => (j === i ? { ...l, [k]: v } : l)));

  return (
    <Modal open size="wide" title="Manual journal entry" onClose={onClose} footer={
      <>
        <span className={`grow ${Math.abs(dr - cr) < 0.005 ? 'green' : 'red'}`}>Debit {money(dr)} · Credit {money(cr)}</span>
        <Button onClick={onClose}>Cancel</Button>
        <Button variant="primary" loading={save.isPending} disabled={Math.abs(dr - cr) >= 0.005 || dr === 0 || memo.length < 3} onClick={async () => {
          try { await save.mutateAsync(undefined); toast('Journal posted'); onClose(); } catch { /* shown */ }
        }}>Post entry</Button>
      </>
    }>
      <div className="stack">
        <div className="info-box">Use manual entries for opening balances, owner capital, loans and corrections. Every entry must balance.</div>
        <ErrorBox error={save.error} />
        <div className="grid grid-2">
          <Field label="Date"><input className="input" type="date" value={entryDate} onChange={(e) => setEntryDate(e.target.value)} /></Field>
          <Field label="Description *"><input className="input" value={memo} onChange={(e) => setMemo(e.target.value)} /></Field>
        </div>
        <table className="table table-compact">
          <thead><tr><th>Account</th><th style={{ width: 140 }}>Debit</th><th style={{ width: 140 }}>Credit</th><th /></tr></thead>
          <tbody>
            {lines.map((l, i) => (
              <tr key={i}>
                <td>
                  <select className="select sm" value={l.accountId} onChange={(e) => set(i, 'accountId', e.target.value)}>
                    <option value="">Select account…</option>
                    {lookups?.accounts.map((a) => <option key={a.id} value={a.id}>{a.code} {a.name}</option>)}
                  </select>
                </td>
                <td><input className="input sm" type="number" min="0" step="any" value={l.debit} onChange={(e) => set(i, 'debit', e.target.value)} /></td>
                <td><input className="input sm" type="number" min="0" step="any" value={l.credit} onChange={(e) => set(i, 'credit', e.target.value)} /></td>
                <td>{lines.length > 2 && <button className="modal-close" onClick={() => setLines(lines.filter((_, j) => j !== i))}>×</button>}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <Button size="sm" onClick={() => setLines([...lines, { accountId: '', debit: '', credit: '' }])}>＋ Add line</Button>
      </div>
    </Modal>
  );
}

function Journal() {
  const [page, setPage] = useState(1);
  const [q, setQ] = useState('');
  const { data, isLoading } = useGet<any>('/journal', { page, pageSize: 30, q });
  return (
    <Card pad={false}>
      <div className="card-body" style={{ paddingBottom: 0 }}>
        <input className="input search" placeholder="Search memo or entry #…" value={q} onChange={(e) => setQ(e.target.value)} />
      </div>
      <DataTable loading={isLoading} rows={data?.rows} empty="No journal entries." columns={[
        { key: 'number', header: 'Entry', render: (r) => <><strong>{r.number}</strong><div className="small muted">{date(r.entry_date)}</div></> },
        { key: 'memo', header: 'Description', render: (r) => <>{r.memo}<div className="small muted">{titleCase(r.ref_type ?? 'manual')} · {r.user_name}</div></> },
        { key: 'lines', header: 'Lines', render: (r) => (
          <table className="table-compact" style={{ width: '100%' }}>
            <tbody>
              {r.lines?.map((l: any, i: number) => (
                <tr key={i}>
                  <td style={{ paddingLeft: l.credit > 0 ? 24 : 0 }}>{l.account}</td>
                  <td className="num">{l.debit > 0 ? money(l.debit) : ''}</td>
                  <td className="num">{l.credit > 0 ? money(l.credit) : ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) },
      ]} />
      <Pagination page={page} pageSize={30} total={data?.total ?? 0} onChange={setPage} />
    </Card>
  );
}

export default function Accounts() {
  const { can } = useAuth();
  const toast = useToast();
  const [tab, setTab] = useState<'chart' | 'journal'>('chart');
  const [edit, setEdit] = useState<any>(null);
  const [journal, setJournal] = useState(false);
  const { data, isLoading } = useGet<any[]>('/accounts');
  const save = useAction((v: any) => (v.id ? patch(`/accounts/${v.id}`, v) : post('/accounts', v)), ['/accounts', '/lookups']);

  return (
    <Page title="Accounts" subtitle="Chart of accounts and the double-entry general ledger" actions={
      <>
        {can('finance.manage') && <Button onClick={() => setJournal(true)}>✍️ Manual journal</Button>}
        {can('accounts.manage') && <Button variant="primary" onClick={() => setEdit({ type: 'expense', isActive: true })}>＋ Account</Button>}
      </>
    }>
      <Tabs value={tab} onChange={setTab} tabs={[{ value: 'chart', label: 'Chart of accounts' }, { value: 'journal', label: 'Journal' }]} />
      {tab === 'journal' ? <Journal /> : (
        <Card pad={false}>
          <DataTable loading={isLoading} rows={data} columns={[
            { key: 'code', header: 'Code', render: (r) => <strong>{r.code}</strong> },
            { key: 'name', header: 'Account', render: (r) => <>{r.name} {r.is_money && <Badge tone="blue">{r.money_kind}</Badge>} {r.system_key && <span className="small muted">system</span>}{r.account_number && <div className="small muted">{r.bank_name} {r.account_number}</div>}</> },
            { key: 'type', header: 'Type', render: (r) => <Badge tone={TYPE_TONE[r.type as keyof typeof TYPE_TONE]}>{r.type}</Badge> },
            { key: 'total_debit', header: 'Debits', num: true, render: (r) => money(r.total_debit) },
            { key: 'total_credit', header: 'Credits', num: true, render: (r) => money(r.total_credit) },
            { key: 'balance', header: 'Balance', num: true, render: (r) => <strong>{money(r.balance)}</strong> },
            { key: 'actions', header: '', render: (r) => (
              <div className="row" style={{ justifyContent: 'flex-end' }}>
                <Link className="btn btn-sm btn-ghost" to={`/statements?type=account&id=${r.id}`}>Ledger</Link>
                {can('accounts.manage') && <Button size="sm" onClick={() => setEdit({ id: r.id, name: r.name, bankName: r.bank_name, accountNumber: r.account_number, isActive: r.is_active, system: !!r.system_key })}>Edit</Button>}
              </div>
            ) },
          ]} />
        </Card>
      )}
      {journal && <ManualJournal onClose={() => setJournal(false)} />}
      <FormModal open={!!edit} title={edit?.id ? 'Edit account' : 'New account'} initial={edit} onClose={() => setEdit(null)}
        fields={edit?.id ? [
          { name: 'name', label: 'Name', required: true, span: 2 },
          { name: 'bankName', label: 'Bank name' },
          { name: 'accountNumber', label: 'Account number' },
          { name: 'isActive', label: 'Active', type: 'checkbox' },
        ] : [
          { name: 'code', label: 'Code', required: true, hint: 'e.g. 1011, 5310' },
          { name: 'name', label: 'Name', required: true },
          { name: 'type', label: 'Type', type: 'select', required: true, options: ['asset', 'liability', 'equity', 'income', 'expense'].map((t) => ({ value: t, label: titleCase(t) })) },
          { name: 'moneyKind', label: 'Cash/bank account?', type: 'select', options: [{ value: 'cash', label: 'Cash' }, { value: 'bank', label: 'Bank' }, { value: 'mobile', label: 'Mobile wallet' }],
            hint: 'Makes it selectable as a payment method', when: (v) => v.type === 'asset' },
          { name: 'bankName', label: 'Bank name', when: (v) => v.moneyKind === 'bank' },
          { name: 'accountNumber', label: 'Account number', when: (v) => !!v.moneyKind },
          { name: 'isActive', label: 'Active', type: 'checkbox' },
        ]}
        onSubmit={async (v) => {
          await save.mutateAsync({ ...v, id: edit?.id });
          toast('Account saved');
        }} />
    </Page>
  );
}
