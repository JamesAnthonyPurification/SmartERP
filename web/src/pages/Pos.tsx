import { useEffect, useMemo, useRef, useState } from 'react';
import { post, useAction, useGet, useLookups } from '../api';
import { FormModal } from '../components/FormModal';
import { Button, Card, Empty, ErrorBox, Field, Modal, Page, Spinner, useDebounced, useToast } from '../components/ui';
import { money, num } from '../format';

interface CartLine {
  productId: string;
  name: string;
  unit: string;
  qty: number;
  unitPrice: number;
  vatRate: number;
  stock: number;
}

const CART_KEY = 'serp.pos.cart';
const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

/** Mirrors the server's priceSale so the cashier sees the exact total. */
function priceCart(lines: CartLine[], discount: number) {
  const nets = lines.map((l) => round2(l.qty * l.unitPrice));
  const subtotal = round2(nets.reduce((a, b) => a + b, 0));
  const d = Math.min(Math.max(discount, 0), subtotal);
  let remaining = d;
  let vat = 0;
  let total = 0;
  nets.forEach((net, i) => {
    const share = i === nets.length - 1 ? remaining : subtotal > 0 ? round2((d * net) / subtotal) : 0;
    remaining = round2(remaining - share);
    const taxable = Math.max(0, round2(net - share));
    const v = round2((taxable * lines[i].vatRate) / 100);
    vat = round2(vat + v);
    total = round2(total + taxable + v);
  });
  return { subtotal, discount: d, vat, total };
}

function loadCart(): CartLine[] {
  try {
    return JSON.parse(localStorage.getItem(CART_KEY) ?? '[]');
  } catch {
    return [];
  }
}

function CustomerPicker({ value, onChange }: { value: any; onChange: (c: any) => void }) {
  const [q, setQ] = useState('');
  const [open, setOpen] = useState(false);
  const [adding, setAdding] = useState(false);
  const dq = useDebounced(q, 200);
  const { data } = useGet<any>(open ? '/customers' : null, { q: dq, pageSize: 10 });
  const toast = useToast();

  if (value) {
    return (
      <div className="row between card" style={{ padding: '8px 12px' }}>
        <div>
          <strong>{value.name}</strong>
          <div className="small muted">
            {value.phone ?? value.code}
            {value.due > 0 && <span className="red"> · Previous due {money(value.due)}</span>}
          </div>
        </div>
        <button className="link small" onClick={() => onChange(null)}>Change</button>
      </div>
    );
  }
  return (
    <div className="ac">
      <div className="row">
        <input
          className="input"
          placeholder="Walk-in customer — search name / phone"
          value={q}
          onChange={(e) => { setQ(e.target.value); setOpen(true); }}
          onFocus={() => setOpen(true)}
          onBlur={() => setTimeout(() => setOpen(false), 150)}
        />
        <Button onClick={() => setAdding(true)} title="New customer">＋</Button>
      </div>
      {open && data?.rows?.length > 0 && (
        <div className="ac-list">
          {data.rows.map((c: any) => (
            <div key={c.id} className="ac-item" onMouseDown={() => { onChange(c); setQ(''); }}>
              <div><strong>{c.name}</strong><div className="small muted">{c.phone ?? c.code}</div></div>
              {c.due > 0 && <span className="small red">Due {money(c.due)}</span>}
            </div>
          ))}
        </div>
      )}
      <FormModal
        open={adding}
        title="New customer"
        onClose={() => setAdding(false)}
        fields={[
          { name: 'name', label: 'Name', required: true, span: 2 },
          { name: 'phone', label: 'Phone', type: 'tel' },
          { name: 'creditLimit', label: 'Credit limit', type: 'number', hint: 'Leave empty for no limit' },
          { name: 'address', label: 'Address', type: 'textarea', span: 2 },
        ]}
        onSubmit={async (v) => {
          const c = await post('/customers', v);
          onChange({ ...c, due: 0 });
          toast(`Customer ${c.name} added`);
        }}
      />
    </div>
  );
}

export default function Pos() {
  const { data: lookups } = useLookups();
  const toast = useToast();
  const allowed = lookups?.warehouses.filter((w) => w.allowed) ?? [];
  const moneyAccounts = lookups?.accounts.filter((a) => a.is_money) ?? [];
  const [warehouseId, setWarehouseId] = useState('');
  const [categoryId, setCategoryId] = useState('');
  const [q, setQ] = useState('');
  const dq = useDebounced(q.trim(), 200);
  const [cart, setCart] = useState<CartLine[]>(loadCart);
  const [customer, setCustomer] = useState<any>(null);
  const [discount, setDiscount] = useState('');
  const [accountId, setAccountId] = useState('');
  const [tendered, setTendered] = useState('');
  const [onCredit, setOnCredit] = useState(false);
  const [note, setNote] = useState('');
  const [done, setDone] = useState<any>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!warehouseId && allowed.length) setWarehouseId(allowed[0].id);
    if (!accountId && moneyAccounts.length) setAccountId(moneyAccounts[0].id);
  }, [allowed, moneyAccounts, warehouseId, accountId]);

  useEffect(() => {
    try {
      localStorage.setItem(CART_KEY, JSON.stringify(cart));
    } catch {
      /* storage unavailable */
    }
  }, [cart]);

  const { data: products, isLoading } = useGet<any[]>(warehouseId ? '/pos/products' : null, { warehouseId, q: dq, categoryId });
  const totals = useMemo(() => priceCart(cart, Number(discount) || 0), [cart, discount]);
  const tenderedNum = Number(tendered) || 0;
  const paid = onCredit ? Math.min(tenderedNum, totals.total) : tendered === '' ? totals.total : Math.min(tenderedNum, totals.total);
  const change = !onCredit && tenderedNum > totals.total ? round2(tenderedNum - totals.total) : 0;
  const due = round2(totals.total - paid);

  const add = (p: any) => {
    setCart((c) => {
      const existing = c.find((l) => l.productId === p.id);
      if (existing) return c.map((l) => (l.productId === p.id ? { ...l, qty: l.qty + 1 } : l));
      return [...c, { productId: p.id, name: p.name, unit: p.unit, qty: 1, unitPrice: p.sale_price, vatRate: p.vat_rate, stock: p.stock }];
    });
  };
  const update = (id: string, patch: Partial<CartLine>) => setCart((c) => c.map((l) => (l.productId === id ? { ...l, ...patch } : l)));
  const reset = () => {
    setCart([]);
    setCustomer(null);
    setDiscount('');
    setTendered('');
    setOnCredit(false);
    setNote('');
    searchRef.current?.focus();
  };

  const sale = useAction(
    () =>
      post('/sales', {
        warehouseId,
        customerId: customer?.id ?? null,
        items: cart.map((l) => ({ productId: l.productId, qty: l.qty, unitPrice: l.unitPrice })),
        discount: totals.discount,
        payments: paid > 0 ? [{ accountId, amount: paid }] : [],
        note: note || null,
      }),
    ['/pos', '/dashboard', '/sales', '/products', '/customers'],
  );

  const checkout = async () => {
    if (!cart.length) return;
    try {
      const result = await sale.mutateAsync(undefined);
      setDone({ ...result, change });
      reset();
    } catch (err: any) {
      toast(err.message, 'error');
    }
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'F9') { e.preventDefault(); checkout(); }
      if (e.key === 'F2') { e.preventDefault(); searchRef.current?.focus(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  const onSearchKey = (e: React.KeyboardEvent) => {
    if (e.key !== 'Enter' || !products?.length) return;
    const exact = products.find((p) => p.barcode === q.trim() || p.sku.toLowerCase() === q.trim().toLowerCase());
    if (exact || products.length === 1) {
      add(exact ?? products[0]);
      setQ('');
    }
  };

  if (!lookups) return <Spinner />;
  if (!allowed.length) return <Empty icon="🏬">You are not assigned to any active branch.</Empty>;

  return (
    <Page
      title="POS Sales"
      subtitle="F2 search · Enter adds scanned barcode · F9 complete sale"
      actions={
        <select className="select" style={{ width: 'auto' }} value={warehouseId} onChange={(e) => setWarehouseId(e.target.value)}>
          {allowed.map((w) => <option key={w.id} value={w.id}>🏬 {w.name}</option>)}
        </select>
      }
    >
      <div className="pos">
        <div className="stack">
          <input
            ref={searchRef}
            className="input"
            style={{ minHeight: 48, fontSize: 16 }}
            placeholder="🔍 Search or scan barcode…"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={onSearchKey}
            autoFocus
          />
          <div className="chips">
            <button className={`chip ${!categoryId ? 'active' : ''}`} onClick={() => setCategoryId('')}>All</button>
            {lookups.categories.map((c) => (
              <button key={c.id} className={`chip ${categoryId === c.id ? 'active' : ''}`} onClick={() => setCategoryId(c.id)}>{c.name}</button>
            ))}
          </div>
          {isLoading ? <Spinner /> : !products?.length ? <Empty>No products match.</Empty> : (
            <div className="pos-products">
              {products.map((p) => (
                <button key={p.id} className={`pos-product ${p.stock <= 0 ? 'out' : ''}`} onClick={() => add(p)}>
                  <span className="name">{p.name}</span>
                  <span className="small muted">{p.sku}</span>
                  <span className={`small ${p.stock <= 0 ? 'red' : 'muted'}`}>{p.stock <= 0 ? 'Out of stock' : `${num(p.stock)} ${p.unit} in stock`}</span>
                  <span className="price">{money(p.sale_price)}</span>
                </button>
              ))}
            </div>
          )}
        </div>

        <Card className="pos-cart" title={`Cart (${cart.length})`} actions={cart.length > 0 && <button className="link small" onClick={reset}>Clear</button>}>
          <div className="stack" style={{ gap: 12 }}>
            <CustomerPicker value={customer} onChange={setCustomer} />
            <div>
              {cart.length === 0 && <Empty icon="🛒">Tap products or scan to add</Empty>}
              {cart.map((l) => (
                <div key={l.productId} className="cart-line">
                  <div>
                    <div style={{ fontWeight: 600, lineHeight: 1.2 }}>{l.name}</div>
                    <div className={`small ${l.qty > l.stock ? 'red' : 'muted'}`}>
                      {l.qty > l.stock ? `Only ${num(l.stock)} in stock` : `${money(round2(l.qty * l.unitPrice))}`}
                      {l.vatRate > 0 && ` · VAT ${l.vatRate}%`}
                    </div>
                  </div>
                  <input className="input sm" type="number" min="0" step="any" value={l.qty} aria-label="Quantity"
                    onChange={(e) => update(l.productId, { qty: Math.max(0, Number(e.target.value)) })} />
                  <input className="input sm" type="number" min="0" step="any" value={l.unitPrice} aria-label="Unit price"
                    onChange={(e) => update(l.productId, { unitPrice: Math.max(0, Number(e.target.value)) })} />
                  <button className="modal-close" onClick={() => setCart((c) => c.filter((x) => x.productId !== l.productId))} aria-label="Remove">×</button>
                </div>
              ))}
            </div>

            <div className="cart-totals">
              <div><span>Subtotal</span><span className="mono">{money(totals.subtotal)}</span></div>
              <div className="row between">
                <span>Discount</span>
                <input className="input sm" style={{ width: 120 }} type="number" min="0" step="any" value={discount} placeholder="0" onChange={(e) => setDiscount(e.target.value)} />
              </div>
              <div><span>VAT</span><span className="mono">{money(totals.vat)}</span></div>
              <div style={{ borderTop: '1px solid var(--border)', marginTop: 6, paddingTop: 8 }}>
                <span className="cart-grand">Total</span>
                <span className="cart-grand">{money(totals.total)}</span>
              </div>
            </div>

            <div className="pay-methods">
              {moneyAccounts.map((a) => (
                <button key={a.id} className={`pay-method ${accountId === a.id ? 'active' : ''}`} onClick={() => setAccountId(a.id)}>
                  {a.money_kind === 'cash' ? '💵' : a.money_kind === 'bank' ? '💳' : '📱'} {a.name.replace(/\s*\(.*\)/, '')}
                </button>
              ))}
            </div>

            <div className="grid grid-2" style={{ gap: 10 }}>
              <Field label={onCredit ? 'Paid now' : 'Cash received'}>
                <input className="input" type="number" min="0" step="any" value={tendered} placeholder={onCredit ? '0' : String(totals.total)} onChange={(e) => setTendered(e.target.value)} />
              </Field>
              <div className="field">
                <span>{change > 0 ? 'Change to return' : due > 0 ? 'Due' : 'Balance'}</span>
                <div className={`display ${change > 0 ? 'green' : due > 0 ? 'red' : ''}`} style={{ fontSize: 24, paddingTop: 4 }}>
                  {money(change > 0 ? change : due)}
                </div>
              </div>
            </div>
            <label className="checkbox">
              <input type="checkbox" checked={onCredit} onChange={(e) => setOnCredit(e.target.checked)} />
              Sell on credit (customer pays later)
            </label>
            {due > 0 && !customer && <div className="error-box">Select a customer to leave {money(due)} as due.</div>}
            <input className="input" placeholder="Note (optional)" value={note} onChange={(e) => setNote(e.target.value)} />
            <ErrorBox error={sale.error} />
            <Button variant="primary" size="lg" block loading={sale.isPending} disabled={!cart.length || (due > 0 && !customer)} onClick={checkout}>
              Complete Sale · {money(totals.total)}
            </Button>
          </div>
        </Card>
      </div>

      <Modal
        open={!!done}
        title="Sale completed"
        onClose={() => setDone(null)}
        footer={
          <>
            <Button onClick={() => window.open(`/print/sale/${done.id}`, '_blank', 'width=420,height=720')}>🖨️ Print receipt</Button>
            <Button variant="primary" onClick={() => setDone(null)}>New sale</Button>
          </>
        }
      >
        {done && (
          <div className="stack center">
            <div style={{ fontSize: 48 }}>✅</div>
            <div className="display" style={{ fontSize: 26 }}>{done.number}</div>
            <div>Total <strong>{money(done.total)}</strong> · Paid <strong>{money(done.paid_amount)}</strong></div>
            {done.change > 0 && <div className="display green" style={{ fontSize: 30 }}>Change {money(done.change)}</div>}
            {done.due_amount > 0 && <div className="red">Due added to {done.customer_name}: {money(done.due_amount)}</div>}
          </div>
        )}
      </Modal>
    </Page>
  );
}
