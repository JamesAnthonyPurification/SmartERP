import { useState } from 'react';
import { money } from '../format';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function niceMax(v: number) {
  if (v <= 0) return 1000;
  const mag = 10 ** Math.floor(Math.log10(v));
  const n = v / mag;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10) * mag;
}

const short = (v: number) => (v >= 1e7 ? `${(v / 1e7).toFixed(1)}Cr` : v >= 1e5 ? `${(v / 1e5).toFixed(1)}L` : v >= 1e3 ? `${Math.round(v / 1e3)}k` : String(Math.round(v)));

/** Monthly sales bars with profit shown as an inner bar. */
export function MonthlyChart({ data }: { data: { month: string; sales: number; profit: number }[] }) {
  const [hover, setHover] = useState<number | null>(null);
  const W = 820;
  const H = 280;
  const pad = { l: 56, r: 12, t: 16, b: 34 };
  const max = niceMax(Math.max(...data.map((d) => d.sales), 0));
  const iw = W - pad.l - pad.r;
  const ih = H - pad.t - pad.b;
  const slot = iw / data.length;
  const bw = Math.min(34, slot * 0.6);
  const y = (v: number) => pad.t + ih - (Math.max(v, 0) / max) * ih;

  return (
    <div style={{ position: 'relative' }}>
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" role="img" aria-label="Monthly sales for the last 12 months">
        {[0, 0.25, 0.5, 0.75, 1].map((f) => (
          <g key={f}>
            <line className="chart-grid" x1={pad.l} x2={W - pad.r} y1={y(max * f)} y2={y(max * f)} />
            <text className="chart-label" x={pad.l - 8} y={y(max * f) + 4} textAnchor="end">{short(max * f)}</text>
          </g>
        ))}
        <line className="chart-axis" x1={pad.l} x2={W - pad.r} y1={pad.t + ih} y2={pad.t + ih} />
        {data.map((d, i) => {
          const x = pad.l + slot * i + (slot - bw) / 2;
          const [yy, mm] = d.month.split('-');
          return (
            <g key={d.month} onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover(null)}>
              <rect x={pad.l + slot * i} y={pad.t} width={slot} height={ih} fill="transparent" />
              <rect className="chart-bar secondary" x={x} y={y(d.sales)} width={bw} height={pad.t + ih - y(d.sales)} rx={5} />
              <rect className="chart-bar" x={x + bw * 0.2} y={y(d.profit)} width={bw * 0.6} height={pad.t + ih - y(d.profit)} rx={3} />
              <text className="chart-label" x={x + bw / 2} y={H - 12} textAnchor="middle">
                {MONTHS[Number(mm) - 1]}{mm === '01' || i === 0 ? ` ${yy.slice(2)}` : ''}
              </text>
            </g>
          );
        })}
      </svg>
      {hover !== null && (
        <div className="card" style={{ position: 'absolute', top: 8, left: 64, padding: '8px 12px', pointerEvents: 'none' }}>
          <strong>{data[hover].month}</strong>
          <div className="small">Sales {money(data[hover].sales, 0)}</div>
          <div className="small">Gross profit {money(data[hover].profit, 0)}</div>
        </div>
      )}
      <div className="row small muted" style={{ justifyContent: 'center' }}>
        <span><span style={{ color: '#fca5a5' }}>■</span> Sales</span>
        <span><span style={{ color: 'var(--red)' }}>■</span> Gross profit</span>
      </div>
    </div>
  );
}
