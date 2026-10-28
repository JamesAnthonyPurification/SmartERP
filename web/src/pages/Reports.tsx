import { ReactNode, useState } from 'react';
import { downloadCsv, Lookups, useGet, useLookups } from '../api';
import { Button, Card, DataTable, Field, Page, Spinner, Tabs } from '../components/ui';
import { date, money, monthStart, num, titleCase } from '../format';

type Tab = 'sales' | 'pl' | 'bs' | 'tb' | 'stock' | 'purchases' | 'expenses' | 'receivables' | 'payables' | 'day';

const TABS: { value: Tab; label: string }[] = [
  { value: 'sales', label: 'Sales' },
  { value: 'pl', label: 'Profit & Loss' },
  { value: 'bs', label: 'Balance Sheet' },
  { value: 'tb', label: 'Trial Balance' },
  { value: 'stock', label: 'Stock Valuation' },
  { value: 'purchases', label: 'Purchases' },
  { value: 'expenses', label: 'Expenses' },
  { value: 'receivables', label: 'Receivables' },
  { value: 'payables', label: 'Payables' },
  { value: 'day', label: 'Daily Cash' },
];

function Section({ title, rows, total }: { title: string; rows: { code: string; name: string; amount: number }[]; total: number }) {
  return (
    <div>
      <h4 className="card-title" style={{ fontSize: 15, marginBottom: 6 }}>{title}</h4>
      {rows.map((r, i) => (
        <div className="list-row" key={`${r.code}-${i}`}><span>{r.code} {r.name}</span><span className="mono">{money(r.amount)}</span></div>
      ))}
      <div className="list-row" style={{ fontWeight: 700 }}><span>Total {title.toLowerCase()}</span><span className="mono">{money(total)}</span></div>
    </div>
  );
}

export default function Reports() {
  const { data: lookups } = useLookups();
  if (!lookups) return <Spinner />;
  return <ReportsInner lookups={lookups} />;
}

function ReportsInner({ lookups }: { lookups: Lookups }) {
  const today = lookups.settings.today;
  const [tab, setTab] = useState<Tab>('sales');
  const [from, setFrom] = useState(monthStart(today));
  const [to, setTo] = useState(today);
  const [groupBy, setGroupBy] = useState('day');
  const [purchaseGroup, setPurchaseGroup] = useState('supplier');
  const [warehouseId, setWarehouseId] = useState('');
  const range = { from, to };

  const paths: Record<Tab, [string, Record<string, string>]> = {
    sales: ['/reports/sales', { ...range, groupBy, warehouseId }],
    pl: ['/reports/profit-loss', range],
    bs: ['/reports/balance-sheet', { asOf: to }],
    tb: ['/reports/trial-balance', { asOf: to }],
    stock: ['/reports/stock', { warehouseId }],
    purchases: ['/reports/purchases', { ...range, groupBy: purchaseGroup }],
    expenses: ['/reports/expenses', range],
    receivables: ['/reports/receivables', {}],
    payables: ['/reports/payables', {}],
    day: ['/reports/day-summary', { date: to }],
  };
  const [path, query] = paths[tab];
  const { data, isLoading } = useGet<any>(path, query);
  const csv = !['bs', 'day'].includes(tab);
  const usesRange = ['sales', 'pl', 'purchases', 'expenses'].includes(tab);
  const usesDate = ['bs', 'tb', 'day'].includes(tab);

  let body: ReactNode = <Spinner />;
  if (data && !isLoading) {
    switch (tab) {
      case 'sales':
        body = (
          <DataTable rowKey="label" rows={data.rows} empty="No sales in this period." columns={[
            { key: 'label', header: titleCase(groupBy) },
            { key: 'invoices', header: 'Invoices', num: true },
            ...(['product', 'category'].includes(groupBy) ? [{ key: 'qty', header: 'Qty', num: true, render: (r: any) => num(r.qty) }] : []),
            { key: 'net_sales', header: 'Net sales', num: true, render: (r: any) => money(r.net_sales) },
            { key: 'revenue', header: 'Revenue ex-VAT', num: true, render: (r: any) => money(r.revenue) },
            { key: 'cost', header: 'Cost', num: true, render: (r: any) => money(r.cost) },
            { key: 'profit', header: 'Gross profit', num: true, render: (r: any) => <strong>{money(r.profit)}</strong> },
          ]} footer={
            <tr>
              <td>Total</td><td className="num">{data.totals.invoices}</td>
              {['product', 'category'].includes(groupBy) && <td />}
              <td className="num">{money(data.totals.net_sales)}</td><td className="num">{money(data.totals.revenue)}</td>
              <td className="num">{money(data.totals.cost)}</td><td className="num">{money(data.totals.profit)}</td>
            </tr>
          } />
        );
        break;
      case 'pl':
        body = (
          <div className="stack">
            <div className="grid grid-3">
              <div className="stat" style={{ minHeight: 0 }}><div className="stat-label">Net sales</div><div className="stat-value">{money(data.netSales, 0)}</div></div>
              <div className="stat" style={{ minHeight: 0 }}><div className="stat-label">Gross profit</div><div className="stat-value">{money(data.grossProfit, 0)}</div><div className="stat-sub">After cost of goods {money(data.cogs, 0)}</div></div>
              <div className={`stat ${data.netProfit < 0 ? 'hot' : ''}`} style={{ minHeight: 0 }}><div className="stat-label">Net profit</div><div className="stat-value">{money(data.netProfit, 0)}</div></div>
            </div>
            <div className="grid grid-2">
              <Section title="Income" rows={data.income} total={data.totalIncome} />
              <Section title="Expenses" rows={data.expenses} total={data.totalExpenses} />
            </div>
          </div>
        );
        break;
      case 'bs':
        body = (
          <div className="stack">
            <div className={data.balanced ? 'info-box' : 'error-box'}>
              As of {date(data.asOf)} — Assets {money(data.totalAssets)} = Liabilities {money(data.totalLiabilities)} + Equity {money(data.totalEquity)} {data.balanced ? '✓ balanced' : '✗ out of balance'}
            </div>
            <div className="grid grid-2">
              <Section title="Assets" rows={data.assets} total={data.totalAssets} />
              <div className="stack">
                <Section title="Liabilities" rows={data.liabilities} total={data.totalLiabilities} />
                <Section title="Equity" rows={data.equity} total={data.totalEquity} />
              </div>
            </div>
          </div>
        );
        break;
      case 'tb':
        body = (
          <DataTable rowKey="code" rows={data.rows} columns={[
            { key: 'code', header: 'Code' }, { key: 'name', header: 'Account' }, { key: 'type', header: 'Type', render: (r) => titleCase(r.type) },
            { key: 'debit', header: 'Debit', num: true, render: (r) => (r.debit ? money(r.debit) : '') },
            { key: 'credit', header: 'Credit', num: true, render: (r) => (r.credit ? money(r.credit) : '') },
          ]} footer={<tr><td colSpan={3}>Total</td><td className="num">{money(data.totals.debit)}</td><td className="num">{money(data.totals.credit)}</td></tr>} />
        );
        break;
      case 'stock':
        body = (
          <DataTable rowKey="sku" rows={data.rows} columns={[
            { key: 'name', header: 'Product', render: (r) => <>{r.name}<div className="small muted">{r.sku} · {r.category}</div></> },
            { key: 'qty', header: 'Qty', num: true, render: (r) => `${num(r.qty)} ${r.unit}` },
            { key: 'avg_cost', header: 'Avg cost', num: true, render: (r) => money(r.avg_cost) },
            { key: 'cost_value', header: 'Cost value', num: true, render: (r) => money(r.cost_value) },
            { key: 'sale_value', header: 'Sale value', num: true, render: (r) => money(r.sale_value) },
            { key: 'status', header: 'Status', render: (r) => <span className={r.status === 'OK' ? 'green' : 'red'}>{r.status}</span> },
          ]} footer={<tr><td>Total</td><td className="num">{num(data.totals.qty)}</td><td /><td className="num">{money(data.totals.costValue)}</td><td className="num">{money(data.totals.saleValue)}</td><td /></tr>} />
        );
        break;
      case 'purchases':
      case 'expenses':
        body = (
          <DataTable rowKey={tab === 'expenses' ? 'code' : 'label'} rows={data.rows} empty="Nothing in this period." columns={tab === 'expenses' ? [
            { key: 'name', header: 'Category' }, { key: 'entries', header: 'Entries', num: true },
            { key: 'amount', header: 'Amount', num: true, render: (r) => money(r.amount) },
          ] : [
            { key: 'label', header: titleCase(purchaseGroup) }, { key: 'purchases', header: 'Purchases', num: true },
            { key: 'qty', header: 'Qty', num: true, render: (r) => num(r.qty) }, { key: 'amount', header: 'Amount', num: true, render: (r) => money(r.amount) },
          ]} footer={<tr><td colSpan={tab === 'expenses' ? 2 : 3}>Total</td><td className="num">{money(data.total)}</td></tr>} />
        );
        break;
      case 'receivables':
        body = (
          <DataTable rowKey="code" rows={data.rows} empty="No outstanding customer dues." columns={[
            { key: 'name', header: 'Customer', render: (r) => <>{r.name}<div className="small muted">{r.phone}</div></> },
            { key: 'invoices', header: 'Invoices', num: true },
            { key: 'd0_30', header: '0–30 days', num: true, render: (r) => money(r.d0_30) },
            { key: 'd31_60', header: '31–60', num: true, render: (r) => money(r.d31_60) },
            { key: 'd61_90', header: '61–90', num: true, render: (r) => money(r.d61_90) },
            { key: 'd90_plus', header: '90+', num: true, render: (r) => <span className={r.d90_plus ? 'red' : ''}>{money(r.d90_plus)}</span> },
            { key: 'due', header: 'Total due', num: true, render: (r) => <strong>{money(r.due)}</strong> },
          ]} footer={<tr><td colSpan={6}>Total receivable</td><td className="num">{money(data.total)}</td></tr>} />
        );
        break;
      case 'payables':
        body = (
          <DataTable rowKey="code" rows={data.rows} empty="Nothing owed to suppliers." columns={[
            { key: 'name', header: 'Supplier', render: (r) => <>{r.name}<div className="small muted">{r.phone}</div></> },
            { key: 'purchases', header: 'Open bills', num: true },
            { key: 'oldest', header: 'Oldest', render: (r) => date(r.oldest) },
            { key: 'due', header: 'Payable', num: true, render: (r) => <strong>{money(r.due)}</strong> },
          ]} footer={<tr><td colSpan={3}>Total payable</td><td className="num">{money(data.total)}</td></tr>} />
        );
        break;
      case 'day':
        body = (
          <div className="stack">
            <div className="grid grid-4">
              <div className="stat" style={{ minHeight: 0 }}><div className="stat-label">Invoices</div><div className="stat-value">{data.sales.invoices}</div><div className="stat-sub">{data.sales.voided} voided</div></div>
              <div className="stat" style={{ minHeight: 0 }}><div className="stat-label">Sales</div><div className="stat-value">{money(data.sales.total, 0)}</div></div>
              <div className="stat" style={{ minHeight: 0 }}><div className="stat-label">Paid at POS</div><div className="stat-value">{money(data.sales.paid, 0)}</div></div>
              <div className="stat" style={{ minHeight: 0 }}><div className="stat-label">Sold on credit</div><div className="stat-value">{money(data.sales.due, 0)}</div></div>
            </div>
            <DataTable rowKey="name" rows={data.accounts} columns={[
              { key: 'name', header: 'Cash / bank account' },
              { key: 'opening', header: 'Opening', num: true, render: (r) => money(r.opening) },
              { key: 'money_in', header: 'In', num: true, render: (r) => <span className="green">{money(r.money_in)}</span> },
              { key: 'money_out', header: 'Out', num: true, render: (r) => <span className="red">{money(r.money_out)}</span> },
              { key: 'closing', header: 'Closing', num: true, render: (r) => <strong>{money(r.closing)}</strong> },
            ]} />
            <DataTable rows={data.movements} empty="No money movements on this day." columns={[
              { key: 'number', header: 'Entry' }, { key: 'memo', header: 'Description' }, { key: 'account', header: 'Account' },
              { key: 'money_in', header: 'In', num: true, render: (r) => (r.money_in ? money(r.money_in) : '') },
              { key: 'money_out', header: 'Out', num: true, render: (r) => (r.money_out ? money(r.money_out) : '') },
            ]} />
          </div>
        );
        break;
    }
  }

  return (
    <Page title="Reports" subtitle={lookups?.settings.company_name} actions={
      <>
        <Button onClick={() => window.print()}>🖨️ Print</Button>
        {csv && <Button variant="primary" onClick={() => downloadCsv(path, query)}>⬇ Export CSV</Button>}
      </>
    }>
      <Tabs value={tab} onChange={setTab} tabs={TABS} />
      <Card>
        <div className="toolbar">
          {usesRange && (
            <>
              <Field label="From"><input className="input" type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></Field>
              <Field label="To"><input className="input" type="date" value={to} onChange={(e) => setTo(e.target.value)} /></Field>
            </>
          )}
          {usesDate && <Field label={tab === 'day' ? 'Date' : 'As of'}><input className="input" type="date" value={to} onChange={(e) => setTo(e.target.value)} /></Field>}
          {tab === 'sales' && (
            <Field label="Group by">
              <select className="select" value={groupBy} onChange={(e) => setGroupBy(e.target.value)}>
                {['day', 'month', 'product', 'category', 'customer', 'cashier', 'warehouse'].map((g) => <option key={g} value={g}>{titleCase(g)}</option>)}
              </select>
            </Field>
          )}
          {tab === 'purchases' && (
            <Field label="Group by">
              <select className="select" value={purchaseGroup} onChange={(e) => setPurchaseGroup(e.target.value)}>
                {['supplier', 'product', 'day'].map((g) => <option key={g} value={g}>{titleCase(g)}</option>)}
              </select>
            </Field>
          )}
          {(tab === 'sales' || tab === 'stock') && (
            <Field label="Branch">
              <select className="select" value={warehouseId} onChange={(e) => setWarehouseId(e.target.value)}>
                <option value="">All</option>
                {lookups?.warehouses.filter((w) => w.allowed).map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
              </select>
            </Field>
          )}
        </div>
        {body}
      </Card>
    </Page>
  );
}
