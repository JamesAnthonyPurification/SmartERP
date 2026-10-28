let currencySymbol = '৳';
export const setCurrencySymbol = (s: string) => {
  currencySymbol = s || '৳';
};

const nf = (d: number) => new Intl.NumberFormat('en-IN', { minimumFractionDigits: d, maximumFractionDigits: d });
const n0 = nf(0);
const n2 = nf(2);

export const money = (v: number | null | undefined, decimals: 0 | 2 = 2) =>
  `${(v ?? 0) < 0 ? '-' : ''}${currencySymbol}${(decimals ? n2 : n0).format(Math.abs(v ?? 0))}`;

export const num = (v: number | null | undefined) =>
  new Intl.NumberFormat('en-IN', { maximumFractionDigits: 3 }).format(v ?? 0);

export const date = (v: string | null | undefined) => {
  if (!v) return '—';
  const d = new Date(v.length === 10 ? `${v}T00:00:00` : v);
  return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
};

export const dateTime = (v: string | null | undefined) => {
  if (!v) return '—';
  return new Date(v).toLocaleString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
};

export const longDate = (v: string) =>
  new Date(`${v}T00:00:00`).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });

export const pct = (v: number | null | undefined) => (v === null || v === undefined ? 'N/A' : `${v > 0 ? '+' : ''}${v.toFixed(1)}%`);

export const titleCase = (s: string) => s.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());

/** YYYY-MM-DD in the browser's local time zone (toISOString would give the UTC date). */
export const localToday = () => new Date().toLocaleDateString('en-CA');

export const monthStart = (today: string) => `${today.slice(0, 8)}01`;
