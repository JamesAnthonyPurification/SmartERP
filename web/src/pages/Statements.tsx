import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Lookups, useGet, useLookups } from '../api';
import { Button, Card, DataTable, Empty, Field, Page, Spinner, Tabs } from '../components/ui';
import { date, money, monthStart, titleCase } from '../format';

type Kind = 'customer' | 'supplier' | 'account';

export default function Statements() {
  const { data: lookups } = useLookups();
  if (!lookups) return <Spinner />;
  return <StatementsInner lookups={lookups} />;
}

function StatementsInner({ lookups }: { lookups: Lookups }) {
  const [params, setParams] = useSearchParams();
  const kind = (params.get('type') as Kind) ?? 'customer';
  const id = params.get('id') ?? '';
  const today = lookups.settings.today;
  const [from, setFrom] = useState(`${today.slice(0, 4)}-01-01`);
  const [to, setTo] = useState(today);

  const parties = useGet<any>(kind === 'customer' ? '/customers' : kind === 'supplier' ? '/suppliers' : null, { pageSize: 500, status: 'all' });
  const accounts = useGet<any[]>(kind === 'account' ? '/accounts' : null);
  const options: { id: string; name: string }[] =
    kind === 'account' ? (accounts.data ?? []).map((a) => ({ id: a.id, name: `${a.code} ${a.name}` })) : (parties.data?.rows ?? []);
  const path = id ? (kind === 'account' ? `/accounts/${id}/ledger` : `/${kind}s/${id}/statement`) : null;
  const { data, isLoading } = useGet<any>(path, { from, to });
  const name = data?.party?.name ?? (data?.account ? `${data.account.code} ${data.account.name}` : '');

  return (
    <Page title="Statements" subtitle="Customer, supplier and account statements with running balance" actions={data && <Button onClick={() => window.print()}>🖨️ Print</Button>}>
      <Tabs value={kind} onChange={(v) => setParams({ type: v })} tabs={[
        { value: 'customer', label: 'Customer' }, { value: 'supplier', label: 'Supplier' }, { value: 'account', label: 'Account ledger' },
      ]} />
      <Card>
        <div className="toolbar">
          <Field label={titleCase(kind)}>
            <select className="select" value={id} onChange={(e) => setParams({ type: kind, id: e.target.value })} style={{ minWidth: 260 }}>
              <option value="">Select…</option>
              {options.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
            </select>
          </Field>
          <Field label="From"><input className="input" type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></Field>
          <Field label="To"><input className="input" type="date" value={to} onChange={(e) => setTo(e.target.value)} /></Field>
          <Button size="sm" onClick={() => { setFrom(monthStart(today)); setTo(today); }}>This month</Button>
        </div>
        {!id ? <Empty icon="📄">Choose a {kind} to view the statement.</Empty> : isLoading || !data ? <Spinner /> : (
          <div className="stack">
            <div className="row between wrap">
              <div>
                <div className="display" style={{ fontSize: 20 }}>{name}</div>
                <div className="muted">{lookups?.settings.company_name} · {date(data.from)} – {date(data.to)}</div>
              </div>
              <div className="right">
                <div className="muted">Closing balance</div>
                <div className="display" style={{ fontSize: 26 }}>{money(data.closing)}</div>
                {kind !== 'account' && <div className="small muted">{kind === 'customer' ? 'Customer owes you' : 'You owe the supplier'}</div>}
              </div>
            </div>
            <DataTable rowKey="_row" rows={[{ at: data.from, ref: '', description: 'Opening balance', debit: null, credit: null, balance: data.opening, opening: true }, ...data.rows.map((r: any) => ({
              ...r, at: r.at ?? r.entry_date, ref: r.ref ?? r.number, description: r.description ?? r.memo,
            }))]} columns={[
              { key: 'at', header: 'Date', render: (r) => date(r.at) },
              { key: 'ref', header: 'Reference' },
              { key: 'description', header: 'Description', render: (r) => (r.opening ? <em>{r.description}</em> : r.description) },
              { key: 'debit', header: 'Debit', num: true, render: (r) => (r.debit ? money(r.debit) : '') },
              { key: 'credit', header: 'Credit', num: true, render: (r) => (r.credit ? money(r.credit) : '') },
              { key: 'balance', header: 'Balance', num: true, render: (r) => <strong>{money(r.balance)}</strong> },
            ]} footer={
              data.totalDebit !== undefined && (
                <tr><td colSpan={3}>Period totals</td><td className="num">{money(data.totalDebit)}</td><td className="num">{money(data.totalCredit)}</td><td className="num">{money(data.closing)}</td></tr>
              )
            } />
          </div>
        )}
      </Card>
    </Page>
  );
}
