import { describe, expect, it } from 'vitest';
import { priceSale } from '../src/services/sales';

describe('priceSale', () => {
  it('computes VAT per line on the discounted amount', () => {
    const r = priceSale(
      [
        { qty: 2, unitPrice: 100, discount: 0, vatRate: 5 },
        { qty: 1, unitPrice: 300, discount: 0, vatRate: 0 },
      ],
      50,
    );
    expect(r.subtotal).toBe(500);
    expect(r.discount).toBe(50);
    expect(r.lines[0].taxable).toBe(180);
    expect(r.lines[0].vat).toBe(9);
    expect(r.vatAmount).toBe(9);
    expect(r.total).toBe(459);
    expect(r.lines.reduce((s, l) => s + l.lineTotal, 0)).toBeCloseTo(r.total, 10);
  });

  it('keeps line totals summing exactly to the invoice total under awkward rounding', () => {
    const r = priceSale(
      [
        { qty: 3, unitPrice: 33.33, discount: 0, vatRate: 7.5 },
        { qty: 7, unitPrice: 1.01, discount: 0.03, vatRate: 15 },
        { qty: 1, unitPrice: 0.99, discount: 0, vatRate: 5 },
      ],
      10.01,
    );
    const sum = Math.round(r.lines.reduce((s, l) => s + l.lineTotal, 0) * 100) / 100;
    expect(sum).toBe(r.total);
    expect(Math.round((r.subtotal - r.discount + r.vatAmount) * 100) / 100).toBe(r.total);
  });

  it('rejects discounts larger than the amount', () => {
    expect(() => priceSale([{ qty: 1, unitPrice: 10, discount: 0, vatRate: 0 }], 11)).toThrow();
    expect(() => priceSale([{ qty: 1, unitPrice: 10, discount: 11, vatRate: 0 }], 0)).toThrow();
  });
});
