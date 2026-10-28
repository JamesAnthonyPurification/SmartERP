import { lazy, ReactNode, Suspense } from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';
import { useAuth } from './auth';
import { Layout, MENU } from './components/Layout';
import { Empty, Spinner } from './components/ui';
import { Login } from './pages/Login';

const pages = {
  Dashboard: lazy(() => import('./pages/Dashboard')),
  Pos: lazy(() => import('./pages/Pos')),
  Products: lazy(() => import('./pages/Products')),
  StockIn: lazy(() => import('./pages/StockIn')),
  StockAdjust: lazy(() => import('./pages/StockAdjust')),
  Customers: lazy(() => import('./pages/Customers')),
  Suppliers: lazy(() => import('./pages/Suppliers')),
  Returns: lazy(() => import('./pages/Returns')),
  Replacements: lazy(() => import('./pages/Replacements')),
  Sales: lazy(() => import('./pages/Sales')),
  CollectDue: lazy(() => import('./pages/CollectDue')),
  Finance: lazy(() => import('./pages/Finance')),
  BankDeposit: lazy(() => import('./pages/BankDeposit')),
  Reports: lazy(() => import('./pages/Reports')),
  Statements: lazy(() => import('./pages/Statements')),
  Accounts: lazy(() => import('./pages/Accounts')),
  Production: lazy(() => import('./pages/Production')),
  Warehouses: lazy(() => import('./pages/Warehouses')),
  Employees: lazy(() => import('./pages/Employees')),
  Attendance: lazy(() => import('./pages/Attendance')),
  Payroll: lazy(() => import('./pages/Payroll')),
  Configuration: lazy(() => import('./pages/Configuration')),
  Activity: lazy(() => import('./pages/Activity')),
  Platform: lazy(() => import('./pages/Platform')),
  PrintInvoice: lazy(() => import('./pages/PrintInvoice')),
};

function Guard({ perm, children }: { perm?: string | string[]; children: ReactNode }) {
  const { can, me } = useAuth();
  if (!me?.tenant) return <Navigate to="/" replace />;
  if (perm && !can(perm)) return <Empty icon="🔒">You do not have access to this page.</Empty>;
  return <>{children}</>;
}

function Home() {
  const { me, can } = useAuth();
  if (!me?.tenant) {
    return me?.user.isPlatformAdmin ? <Navigate to="/platform" replace /> : <Empty icon="🏢">Select a business to continue.</Empty>;
  }
  if (can('dashboard.view')) return <pages.Dashboard />;
  const first = MENU.flatMap((s) => s.items).find((i) => i.to !== '/' && can(i.perm));
  return first ? <Navigate to={first.to} replace /> : <Empty icon="🔒">Your role has no modules assigned. Ask your administrator.</Empty>;
}

export function App() {
  const { me, loading } = useAuth();
  if (loading) return <Spinner />;
  if (!me) return <Login />;

  const r = (path: string, el: ReactNode, perm?: string | string[]) => (
    <Route path={path} element={<Guard perm={perm}>{el}</Guard>} />
  );
  return (
    <Suspense fallback={<Spinner />}>
      <Routes>
        <Route path="/print/sale/:id" element={<pages.PrintInvoice />} />
        <Route element={<Layout />}>
          <Route index element={<Home />} />
          {r('/pos', <pages.Pos />, 'pos.sell')}
          {r('/products', <pages.Products />, 'products.view')}
          {r('/stock-in', <pages.StockIn />, 'inventory.receive')}
          {r('/stock-adjust', <pages.StockAdjust />, ['inventory.adjust', 'inventory.view'])}
          {r('/customers', <pages.Customers />, 'customers.view')}
          {r('/suppliers', <pages.Suppliers />, 'suppliers.view')}
          {r('/returns', <pages.Returns />, 'returns.manage')}
          {r('/replacements', <pages.Replacements />, 'returns.manage')}
          {r('/sales', <pages.Sales mode="history" />, ['sales.view', 'pos.sell'])}
          {r('/manage-sales', <pages.Sales mode="manage" />, 'sales.void')}
          {r('/collect-due', <pages.CollectDue />, 'collections.manage')}
          {r('/finance', <pages.Finance />, 'finance.view')}
          {r('/bank-deposit', <pages.BankDeposit />, 'finance.view')}
          {r('/reports', <pages.Reports />, 'reports.view')}
          {r('/statements', <pages.Statements />, 'reports.view')}
          {r('/accounts', <pages.Accounts />, 'finance.view')}
          {r('/production', <pages.Production />, 'production.manage')}
          {r('/warehouses', <pages.Warehouses />, ['warehouses.manage', 'inventory.view'])}
          {r('/employees', <pages.Employees />, 'hr.view')}
          {r('/attendance', <pages.Attendance />, 'attendance.manage')}
          {r('/payroll', <pages.Payroll />, 'payroll.manage')}
          {r('/configuration', <pages.Configuration />, ['settings.manage', 'users.manage'])}
          {r('/activity', <pages.Activity />, 'audit.view')}
          <Route path="/platform" element={me.user.isPlatformAdmin ? <pages.Platform /> : <Navigate to="/" replace />} />
          <Route path="*" element={<Empty icon="🧭">Page not found.</Empty>} />
        </Route>
      </Routes>
    </Suspense>
  );
}
