import { Link } from 'react-router-dom';
import { useGet } from '../api';
import { useAuth } from '../auth';
import { MonthlyChart } from '../components/BarChart';
import { Button, Card, Empty, Page, Spinner, StatusBadge } from '../components/ui';
import { dateTime, longDate, money, num, pct } from '../format';

function Trend({ change }: { change: number | null }) {
  if (change === null) return <div className="stat-trend up">▲ N/A vs last period</div>;
  const up = change >= 0;
  return <div className={`stat-trend ${up ? 'up' : 'down'}`}>{up ? '▲' : '▼'} {pct(change)} vs last period</div>;
}

const PROFIT_TONES = {
  today: { color: 'var(--green)', bg: 'var(--green-50)', label: 'TODAY', icon: '📅', title: 'Daily Profit' },
  month: { color: 'var(--blue)', bg: 'var(--blue-50)', label: 'THIS MONTH', icon: '📊', title: 'Monthly Profit' },
  year: { color: 'var(--purple)', bg: 'var(--purple-50)', label: 'THIS YEAR', icon: '📈', title: 'Yearly Profit' },
  lifetime: { color: 'var(--amber)', bg: 'var(--amber-50)', label: 'LIFETIME', icon: '🏆', title: 'All-Time Profit' },
} as const;

export default function Dashboard() {
  const { me, can } = useAuth();
  const { data, isLoading, refetch, isFetching } = useGet<any>('/dashboard', undefined, { refetchInterval: 60_000 });
  if (isLoading || !data) return <Spinner />;
  const { sales, profit, stock, balances, money: accounts } = data;

  const quick = [
    { to: '/pos', icon: '🛒', title: 'New Sale', sub: 'Open POS terminal', perm: 'pos.sell' },
    { to: '/stock-in', icon: '📦', title: 'Stock In', sub: 'Receive inventory', perm: 'inventory.receive' },
    { to: '/collect-due', icon: '💰', title: 'Collect Due', sub: 'Receive customer payment', perm: 'collections.manage' },
    { to: '/returns', icon: '↩️', title: 'Returns', sub: 'Process a return', perm: 'returns.manage' },
    { to: '/customers', icon: '👥', title: 'Customers', sub: 'Manage customers', perm: 'customers.view' },
    { to: '/reports', icon: '📊', title: 'Reports', sub: 'View & print reports', perm: 'reports.view' },
    { to: '/attendance', icon: '📅', title: 'Attendance', sub: 'Mark today', perm: 'attendance.manage' },
    { to: '/finance', icon: '💵', title: 'Expenses', sub: 'Record an expense', perm: 'finance.manage' },
  ].filter((q) => can(q.perm));

  return (
    <Page
      title="Dashboard"
      subtitle={`${me!.tenant!.companyName} — Live Overview`}
      actions={
        <>
          <Button variant="ghost" onClick={() => refetch()} loading={isFetching}>🔄 Refresh</Button>
          <span className="card" style={{ padding: '9px 16px' }}>{longDate(data.today)}</span>
        </>
      }
    >
      <div className="grid grid-4">
        <div className="stat hot">
          <div className="stat-label">Today's Sales</div>
          <div className="stat-value">{money(sales.today.total, 0)}</div>
          <div className="stat-sub">{sales.today.invoices} invoices today</div>
          <Trend change={sales.today.change} />
        </div>
        <div className="stat">
          <span className="stat-icon">🗓️</span>
          <div className="stat-label">This Week</div>
          <div className="stat-value">{money(sales.week.total, 0)}</div>
          <div className="stat-sub">Current week total (from Saturday)</div>
          <Trend change={sales.week.change} />
        </div>
        <div className="stat">
          <span className="stat-icon">📈</span>
          <div className="stat-label">This Month</div>
          <div className="stat-value">{money(sales.month.total, 0)}</div>
          <div className="stat-sub">VAT: {money(sales.month.vat, 0)} · {sales.month.invoices} invoices</div>
          <Trend change={sales.month.change} />
        </div>
        <div className="stat">
          <span className="stat-icon">🏆</span>
          <div className="stat-label">This Year</div>
          <div className="stat-value">{money(sales.year.total, 0)}</div>
          <div className="stat-sub">Total: {sales.year.invoices} invoices</div>
          <Trend change={sales.year.change} />
        </div>

        <div className="stat">
          <span className="stat-icon">🔋</span>
          <div className="stat-label">Total Products</div>
          <div className="stat-value">{num(stock.total_products)}</div>
          <div className="stat-sub">Active products · {stock.low_stock} low stock</div>
        </div>
        <div className="stat">
          <span className="stat-icon">📦</span>
          <div className="stat-label">Units in Stock</div>
          <div className="stat-value">{num(stock.units)}</div>
          <div className="stat-sub">Total inventory</div>
        </div>
        <div className="stat">
          <span className="stat-icon">💰</span>
          <div className="stat-label">Stock Value</div>
          <div className="stat-value">{money(stock.stock_value, 0)}</div>
          <div className="stat-sub">At purchase (average) cost</div>
        </div>
        <Link to="/products" className={`stat ${stock.out_of_stock > 0 ? 'hot' : ''}`}>
          <span className="stat-icon">⚠️</span>
          <div className="stat-label">Out of Stock</div>
          <div className="stat-value">{num(stock.out_of_stock)}</div>
          <div className="stat-sub">{stock.out_of_stock > 0 ? 'Needs restocking' : 'All products available'}</div>
        </Link>
      </div>

      <div className="profit-panel mt">
        <div className="row between mb">
          <h3 className="card-title">💰 Profit Overview</h3>
          <div className="right">
            <div className="muted">Profit Margin</div>
            <div className="display green" style={{ fontSize: 30 }}>{profit.margin.toFixed(1)}%</div>
          </div>
        </div>
        <div className="grid grid-4">
          {(Object.keys(PROFIT_TONES) as (keyof typeof PROFIT_TONES)[]).map((k) => {
            const tone = PROFIT_TONES[k];
            const p = profit[k];
            return (
              <div key={k} className="profit-card" style={{ borderColor: tone.bg === 'var(--green-50)' ? '#bbf7d0' : tone.bg, boxShadow: `0 0 0 1px ${tone.bg}` }}>
                <div className="row between">
                  <span style={{ fontSize: 26 }}>{tone.icon}</span>
                  <span className="tag" style={{ color: tone.color, background: tone.bg }}>{tone.label}</span>
                </div>
                <div className="value" style={{ color: p.profit < 0 ? 'var(--red)' : undefined }}>{money(p.profit)}</div>
                <div className="muted">{tone.title}</div>
                <div className="foot">
                  <span>Sales: {money(p.sales)}</span>
                  <span>Cost: {money(p.cost)}</span>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      <div className="grid grid-2-1 mt">
        <Card title="Monthly Revenue (Last 12 Months)">
          <MonthlyChart data={data.monthly} />
        </Card>
        <Card title="Top Products (30d)">
          {data.topProducts.length === 0 ? (
            <Empty icon="🔋">Appears after first sales</Empty>
          ) : (
            data.topProducts.map((p: any, i: number) => (
              <div key={p.id} className="list-row">
                <div className="row">
                  <span className="badge red">{i + 1}</span>
                  <div>
                    <div style={{ fontWeight: 600 }}>{p.name}</div>
                    <div className="small muted">{num(p.qty)} {p.unit} sold</div>
                  </div>
                </div>
                <strong className="mono">{money(p.revenue, 0)}</strong>
              </div>
            ))
          )}
        </Card>
      </div>

      <div className="grid grid-3 mt">
        <Card title="Cash & Bank">
          {accounts.map((a: any) => (
            <div key={a.id} className="list-row">
              <span>{a.money_kind === 'cash' ? '💵' : a.money_kind === 'bank' ? '🏦' : '📱'} {a.name}</span>
              <strong className="mono">{money(a.balance)}</strong>
            </div>
          ))}
          <div className="list-row"><span>Customer dues (receivable)</span><strong className="mono">{money(balances.receivable)}</strong></div>
          <div className="list-row"><span>Supplier payable</span><strong className="mono">{money(balances.payable)}</strong></div>
          <div className="list-row"><span>Expenses this month</span><strong className="mono">{money(balances.month_expenses)}</strong></div>
        </Card>
        <Card title="Recent Sales" actions={<Link className="link small" to="/sales">View all</Link>}>
          {data.recentSales.length === 0 && <Empty icon="🧾">No sales yet</Empty>}
          {data.recentSales.map((s: any) => (
            <div key={s.id} className="list-row">
              <div>
                <div style={{ fontWeight: 600 }}>{s.number} <StatusBadge status={s.status} /></div>
                <div className="small muted">{s.customer_name ?? 'Walk-in'} · {dateTime(s.sale_date)}</div>
              </div>
              <div className="right">
                <strong className="mono">{money(s.total)}</strong>
                {s.due_amount > 0 && <div className="small red">Due {money(s.due_amount)}</div>}
              </div>
            </div>
          ))}
        </Card>
        <Card title="Low Stock Alerts" actions={<Link className="link small" to="/stock-in">Restock</Link>}>
          {data.lowStock.length === 0 && <Empty icon="✅">Stock levels are healthy</Empty>}
          {data.lowStock.map((p: any) => (
            <div key={p.id} className="list-row">
              <span>{p.name}</span>
              <span className={p.qty <= 0 ? 'badge red' : 'badge amber'}>{num(p.qty)} / {num(p.reorder_level)} {p.unit}</span>
            </div>
          ))}
        </Card>
      </div>

      {quick.length > 0 && (
        <Card title="Quick Actions" className="mt">
          <div className="grid grid-4">
            {quick.map((q) => (
              <Link key={q.to} to={q.to} className="quick-action">
                <span className="icon">{q.icon}</span>
                <strong>{q.title}</strong>
                <span className="small muted">{q.sub}</span>
              </Link>
            ))}
          </div>
        </Card>
      )}
    </Page>
  );
}
