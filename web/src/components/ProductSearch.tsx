import { KeyboardEvent, useEffect, useRef, useState } from 'react';
import { useGet } from '../api';
import { money, num } from '../format';
import { useDebounced } from './ui';

export interface ProductHit {
  id: string;
  sku: string;
  barcode: string | null;
  name: string;
  unit: string;
  sale_price: number;
  purchase_price: number;
  avg_cost: number;
  vat_rate: number;
  stock: number;
}

/**
 * Type-ahead product finder. A barcode scanner "types" the code and presses
 * Enter, which selects an exact barcode/SKU match immediately.
 */
export function ProductSearch({
  onSelect, warehouseId, placeholder = 'Search product by name, SKU or barcode…', autoFocus, showCost,
}: {
  onSelect: (p: ProductHit) => void;
  warehouseId?: string;
  placeholder?: string;
  autoFocus?: boolean;
  showCost?: boolean;
}) {
  const [q, setQ] = useState('');
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const dq = useDebounced(q.trim(), 180);
  const { data } = useGet<{ rows: ProductHit[] }>(dq ? '/products' : null, { q: dq, pageSize: 12, warehouseId });
  const rows = data?.rows ?? [];
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => setActive(0), [dq]);
  useEffect(() => {
    const close = (e: MouseEvent) => box.current && !box.current.contains(e.target as Node) && setOpen(false);
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, []);

  const choose = (p: ProductHit) => {
    onSelect(p);
    setQ('');
    setOpen(false);
  };

  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown') setActive((a) => Math.min(a + 1, rows.length - 1));
    else if (e.key === 'ArrowUp') setActive((a) => Math.max(a - 1, 0));
    else if (e.key === 'Enter') {
      e.preventDefault();
      const exact = rows.find((r) => r.barcode === q.trim() || r.sku.toLowerCase() === q.trim().toLowerCase());
      const pick = exact ?? rows[active];
      if (pick && (dq === q.trim() || exact)) choose(pick);
    } else if (e.key === 'Escape') setOpen(false);
  };

  return (
    <div className="ac" ref={box}>
      <input
        className="input"
        value={q}
        autoFocus={autoFocus}
        placeholder={placeholder}
        onChange={(e) => {
          setQ(e.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onKeyDown={onKey}
      />
      {open && dq && (
        <div className="ac-list">
          {rows.length === 0 && <div className="ac-item muted">No products found</div>}
          {rows.map((p, i) => (
            <div key={p.id} className={`ac-item ${i === active ? 'active' : ''}`} onMouseDown={() => choose(p)}>
              <div>
                <div style={{ fontWeight: 600 }}>{p.name}</div>
                <div className="small muted">{p.sku}{p.barcode ? ` · ${p.barcode}` : ''}</div>
              </div>
              <div className="right small nowrap">
                <div>{money(showCost ? p.purchase_price : p.sale_price)}</div>
                <div className={p.stock > 0 ? 'muted' : 'red'}>Stock {num(p.stock)} {p.unit}</div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
