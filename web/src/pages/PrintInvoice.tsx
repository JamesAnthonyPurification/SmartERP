import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { useGet, useLookups } from '../api';
import { Button, Spinner } from '../components/ui';
import { dateTime, money, num } from '../format';

export default function PrintInvoice() {
  const { id } = useParams();
  const { data: sale, error } = useGet<any>(`/sales/${id}`);
  const { data: lookups } = useLookups();
  const [a4, setA4] = useState(false);

  useEffect(() => {
    if (sale && lookups) {
      document.title = sale.number;
      const t = setTimeout(() => window.print(), 400);
      return () => clearTimeout(t);
    }
  }, [sale, lookups]);

  if (error) return <div className="print-page">{(error as Error).message}</div>;
  if (!sale || !lookups) return <Spinner />;
  const s = lookups.settings;
  const collected = sale.collections.reduce((a: number, c: any) => a + c.amount, 0);

  return (
    <div className="print-page">
      <div className="no-print row" style={{ justifyContent: 'center', marginBottom: 16 }}>
        <Button variant="primary" onClick={() => window.print()}>🖨️ Print</Button>
        <Button onClick={() => setA4(!a4)}>{a4 ? 'Thermal 80mm' : 'A4 invoice'}</Button>
        <Button onClick={() => window.close()}>Close</Button>
      </div>
      <div className={`receipt ${a4 ? 'a4' : ''}`}>
        <div style={{ textAlign: 'center' }}>
          <div style={{ fontSize: a4 ? 22 : 16, fontWeight: 700 }}>{s.company_name}</div>
          {s.address && <div>{s.address}</div>}
          {s.phone && <div>Phone: {s.phone}</div>}
          {s.tax_id && <div>BIN/VAT Reg: {s.tax_id}</div>}
          <div style={{ marginTop: 6, fontWeight: 700 }}>{sale.status === 'void' ? 'VOID — ' : ''}{a4 ? 'TAX INVOICE' : 'SALES RECEIPT'}</div>
        </div>
        <div className="rule" />
        <table>
          <tbody>
            <tr><td>Invoice</td><td style={{ textAlign: 'right' }}><strong>{sale.number}</strong></td></tr>
            <tr><td>Date</td><td style={{ textAlign: 'right' }}>{dateTime(sale.sale_date)}</td></tr>
            <tr><td>Customer</td><td style={{ textAlign: 'right' }}>{sale.customer_name ?? 'Walk-in customer'}</td></tr>
            {sale.customer_phone && <tr><td>Phone</td><td style={{ textAlign: 'right' }}>{sale.customer_phone}</td></tr>}
            <tr><td>Served by</td><td style={{ textAlign: 'right' }}>{sale.cashier_name} · {sale.warehouse_name}</td></tr>
          </tbody>
        </table>
        <div className="rule" />
        <table>
          <thead>
            <tr><th style={{ textAlign: 'left' }}>Item</th><th style={{ textAlign: 'right' }}>Qty</th><th style={{ textAlign: 'right' }}>Rate</th><th style={{ textAlign: 'right' }}>Amount</th></tr>
          </thead>
          <tbody>
            {sale.items.map((i: any) => (
              <tr key={i.id}>
                <td>{i.product_name}{i.vat_rate > 0 ? ` (VAT ${i.vat_rate}%)` : ''}</td>
                <td style={{ textAlign: 'right' }}>{num(i.qty)}</td>
                <td style={{ textAlign: 'right' }}>{money(i.unit_price)}</td>
                <td style={{ textAlign: 'right' }}>{money(i.qty * i.unit_price - i.discount)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="rule" />
        <table>
          <tbody>
            <tr><td>Subtotal</td><td style={{ textAlign: 'right' }}>{money(sale.subtotal)}</td></tr>
            {sale.discount > 0 && <tr><td>Discount</td><td style={{ textAlign: 'right' }}>-{money(sale.discount)}</td></tr>}
            {sale.vat_amount > 0 && <tr><td>VAT</td><td style={{ textAlign: 'right' }}>{money(sale.vat_amount)}</td></tr>}
            <tr><td><strong>TOTAL</strong></td><td style={{ textAlign: 'right' }}><strong>{money(sale.total)}</strong></td></tr>
            {sale.payments.map((p: any, i: number) => (
              <tr key={i}><td>Paid ({p.account_name})</td><td style={{ textAlign: 'right' }}>{money(p.amount)}</td></tr>
            ))}
            {collected > 0 && <tr><td>Collected later</td><td style={{ textAlign: 'right' }}>{money(collected)}</td></tr>}
            {sale.returned_amount > 0 && <tr><td>Returned</td><td style={{ textAlign: 'right' }}>-{money(sale.returned_amount)}</td></tr>}
            <tr><td><strong>Due</strong></td><td style={{ textAlign: 'right' }}><strong>{money(sale.due_amount)}</strong></td></tr>
          </tbody>
        </table>
        <div className="rule" />
        <div style={{ textAlign: 'center', marginTop: 6 }}>{s.receipt_footer}</div>
        <div style={{ textAlign: 'center', fontSize: 10, marginTop: 8 }}>Powered by SmartERP</div>
      </div>
    </div>
  );
}
