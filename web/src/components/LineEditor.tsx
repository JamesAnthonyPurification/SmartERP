import { money, num } from '../format';
import { ProductHit, ProductSearch } from './ProductSearch';

export interface Line {
  productId: string;
  name: string;
  unit: string;
  stock: number;
  qty: number | string;
  unitCost?: number | string;
}

/**
 * Editable product lines used by Stock In, adjustments, transfers and production.
 * `signed` allows negative quantities (stock adjustments).
 */
export function LineEditor({
  lines, onChange, warehouseId, withCost, signed, costLabel = 'Unit cost',
}: {
  lines: Line[];
  onChange: (lines: Line[]) => void;
  warehouseId?: string;
  withCost?: boolean;
  signed?: boolean;
  costLabel?: string;
}) {
  const add = (p: ProductHit) => {
    if (lines.some((l) => l.productId === p.id)) return;
    onChange([...lines, { productId: p.id, name: p.name, unit: p.unit, stock: p.stock, qty: signed ? '' : 1, unitCost: p.purchase_price || p.avg_cost }]);
  };
  const set = (i: number, patch: Partial<Line>) => onChange(lines.map((l, j) => (j === i ? { ...l, ...patch } : l)));
  const total = lines.reduce((s, l) => s + Number(l.qty || 0) * Number(l.unitCost || 0), 0);

  return (
    <div className="stack" style={{ gap: 10 }}>
      <ProductSearch onSelect={add} warehouseId={warehouseId} showCost={withCost} placeholder="Add product — search or scan…" />
      {lines.length > 0 && (
        <div className="table-wrap">
          <table className="table table-compact">
            <thead>
              <tr>
                <th>Product</th>
                <th className="num">In stock</th>
                <th style={{ width: 120 }}>{signed ? 'Qty (+/−)' : 'Qty'}</th>
                {withCost && <th style={{ width: 130 }}>{costLabel}</th>}
                {withCost && <th className="num">Line total</th>}
                <th />
              </tr>
            </thead>
            <tbody>
              {lines.map((l, i) => (
                <tr key={l.productId}>
                  <td><strong>{l.name}</strong></td>
                  <td className="num">{num(l.stock)} {l.unit}</td>
                  <td>
                    <input className="input sm" type="number" step="any" min={signed ? undefined : 0} value={l.qty} aria-label="Quantity"
                      onChange={(e) => set(i, { qty: e.target.value })} />
                  </td>
                  {withCost && (
                    <td>
                      <input className="input sm" type="number" step="any" min="0" value={l.unitCost ?? ''} aria-label={costLabel}
                        onChange={(e) => set(i, { unitCost: e.target.value })} />
                    </td>
                  )}
                  {withCost && <td className="num">{money(Number(l.qty || 0) * Number(l.unitCost || 0))}</td>}
                  <td><button className="modal-close" onClick={() => onChange(lines.filter((_, j) => j !== i))} aria-label="Remove">×</button></td>
                </tr>
              ))}
            </tbody>
            {withCost && (
              <tfoot>
                <tr>
                  <td colSpan={4}>Total</td>
                  <td className="num">{money(total)}</td>
                  <td />
                </tr>
              </tfoot>
            )}
          </table>
        </div>
      )}
    </div>
  );
}
