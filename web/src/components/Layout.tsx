import { useEffect, useState } from 'react';
import { NavLink, Outlet, useLocation } from 'react-router-dom';
import { post, useGet, useLookups } from '../api';
import { useAuth } from '../auth';
import { localToday, longDate } from '../format';
import { FormModal } from './FormModal';
import { Button, Modal, useToast } from './ui';

interface NavItem {
  to: string;
  label: string;
  icon: string;
  perm: string | string[];
}

export const MENU: { section: string; items: NavItem[] }[] = [
  {
    section: 'Main Menu',
    items: [
      { to: '/', label: 'Dashboard', icon: '📊', perm: 'dashboard.view' },
      { to: '/pos', label: 'POS Sales', icon: '🛒', perm: 'pos.sell' },
      { to: '/products', label: 'Products', icon: '📋', perm: 'products.view' },
      { to: '/stock-in', label: 'Stock In', icon: '📦', perm: 'inventory.receive' },
      { to: '/stock-adjust', label: 'Stock Adjust', icon: '⚙️', perm: ['inventory.adjust', 'inventory.view'] },
      { to: '/customers', label: 'Customers', icon: '👥', perm: 'customers.view' },
      { to: '/suppliers', label: 'Suppliers', icon: '🚚', perm: 'suppliers.view' },
      { to: '/returns', label: 'Returns', icon: '↩️', perm: 'returns.manage' },
      { to: '/replacements', label: 'Replacements', icon: '🔄', perm: 'returns.manage' },
      { to: '/sales', label: 'Sales History', icon: '🧾', perm: ['sales.view', 'pos.sell'] },
      { to: '/manage-sales', label: 'Manage Sales', icon: '📜', perm: 'sales.void' },
      { to: '/collect-due', label: 'Collect Due', icon: '💰', perm: 'collections.manage' },
      { to: '/finance', label: 'Finance', icon: '💵', perm: 'finance.view' },
      { to: '/bank-deposit', label: 'Bank Deposit', icon: '🏦', perm: 'finance.view' },
      { to: '/reports', label: 'Reports', icon: '📈', perm: 'reports.view' },
      { to: '/statements', label: 'Statements', icon: '📄', perm: 'reports.view' },
    ],
  },
  {
    section: 'Admin',
    items: [
      { to: '/accounts', label: 'Accounts', icon: '🏛️', perm: 'finance.view' },
      { to: '/production', label: 'Production', icon: '🏭', perm: 'production.manage' },
      { to: '/warehouses', label: 'Warehouse', icon: '🏬', perm: ['warehouses.manage', 'inventory.view'] },
      { to: '/employees', label: 'Employees', icon: '🧑‍💼', perm: 'hr.view' },
      { to: '/attendance', label: 'Attendance', icon: '📅', perm: 'attendance.manage' },
      { to: '/payroll', label: 'Payroll', icon: '💳', perm: 'payroll.manage' },
      { to: '/configuration', label: 'Configuration', icon: '🎨', perm: ['settings.manage', 'users.manage'] },
      { to: '/activity', label: 'Activity Logs', icon: '🗂️', perm: 'audit.view' },
    ],
  },
];

function useOnline() {
  const [online, setOnline] = useState(navigator.onLine);
  useEffect(() => {
    const on = () => setOnline(true);
    const off = () => setOnline(false);
    window.addEventListener('online', on);
    window.addEventListener('offline', off);
    return () => {
      window.removeEventListener('online', on);
      window.removeEventListener('offline', off);
    };
  }, []);
  return online;
}

function Notifications() {
  const [open, setOpen] = useState(false);
  const { data, refetch } = useGet<any[]>('/notifications', undefined, { refetchInterval: 120_000 });
  const unread = data?.filter((n) => !n.read_at).length ?? 0;
  return (
    <>
      <button className="btn btn-ghost" onClick={() => setOpen(true)} aria-label="Notifications" style={{ position: 'relative' }}>
        🔔
        {unread > 0 && <span className="badge red" style={{ position: 'absolute', top: -2, right: -6, padding: '0 6px' }}>{unread}</span>}
      </button>
      <Modal
        open={open}
        title="Notifications"
        onClose={() => setOpen(false)}
        footer={<Button onClick={async () => { await post('/notifications/read-all'); await refetch(); }}>Mark all as read</Button>}
      >
        {!data?.length && <div className="muted">No notifications.</div>}
        {data?.map((n) => (
          <div className="list-row" key={n.id}>
            <div>
              <div style={{ fontWeight: n.read_at ? 400 : 700 }}>{n.title}</div>
              <div className="small muted">{n.body}</div>
            </div>
            <span className="small muted nowrap">{new Date(n.created_at).toLocaleDateString()}</span>
          </div>
        ))}
      </Modal>
    </>
  );
}

export function Layout() {
  const { me, can, logout, switchTenant } = useAuth();
  const [menuOpen, setMenuOpen] = useState(false);
  const [pwOpen, setPwOpen] = useState(false);
  const location = useLocation();
  const online = useOnline();
  const toast = useToast();
  const { data: lookups } = useLookups(!!me?.tenant);
  const today = lookups?.settings.today ?? localToday();

  useEffect(() => setMenuOpen(false), [location.pathname]);
  const t = me!.tenant;

  return (
    <div className="app">
      <aside className={`sidebar ${menuOpen ? 'open' : ''}`}>
        <div className="brand">
          <div className="brand-logo">⚡</div>
          <div>
            <div className="brand-name">SMARTERP</div>
            <div className="brand-sub">Multi-tenant POS & ERP</div>
          </div>
        </div>
        <nav className="nav">
          {t &&
            MENU.map((section) => {
              const items = section.items.filter((i) => can(i.perm));
              if (!items.length) return null;
              return (
                <div key={section.section}>
                  <div className="nav-section">{section.section}</div>
                  {items.map((i) => (
                    <NavLink key={i.to} to={i.to} end={i.to === '/'}>
                      <span className="nav-icon">{i.icon}</span>
                      {i.label}
                    </NavLink>
                  ))}
                </div>
              );
            })}
          {me!.user.isPlatformAdmin && (
            <div>
              <div className="nav-section">Platform</div>
              <NavLink to="/platform">
                <span className="nav-icon">🛡️</span>
                Tenants
              </NavLink>
            </div>
          )}
        </nav>
        <div className="sidebar-foot">
          <div className={`online ${online ? '' : 'offline'}`}>{online ? 'Online' : 'Offline'}</div>
          <div className="user-chip">
            <div className="avatar">{me!.user.name.slice(0, 1).toUpperCase()}</div>
            <div className="grow">
              <div style={{ fontWeight: 600 }}>{me!.user.name}</div>
              <div className="small muted">{t?.roleName ?? (me!.user.isPlatformAdmin ? 'Platform admin' : '')}</div>
            </div>
          </div>
          <div className="row between">
            <button className="logout" onClick={logout}>🚪 Logout</button>
            <button className="link small" onClick={() => setPwOpen(true)}>Change password</button>
          </div>
        </div>
      </aside>
      {menuOpen && <div className="modal-backdrop" style={{ zIndex: 35 }} onClick={() => setMenuOpen(false)} />}

      <div className="main">
        <header className="topbar">
          <button className="menu-toggle" onClick={() => setMenuOpen(true)} aria-label="Open menu">☰</button>
          <span className="topbar-tenant">{t?.companyName ?? 'SmartERP Platform'}</span>
          <span className="topbar-divider" />
          <span className="topbar-tagline">{t?.tagline ?? 'Tenant administration'}</span>
          <div className="topbar-right">
            {me!.memberships.length > 1 && (
              <select
                className="select sm"
                style={{ width: 'auto' }}
                value={t?.id ?? ''}
                onChange={async (e) => {
                  try {
                    await switchTenant(e.target.value);
                    toast('Switched business');
                  } catch (err: any) {
                    toast(err.message, 'error');
                  }
                }}
                aria-label="Switch business"
              >
                {!t && <option value="">Select business…</option>}
                {me!.memberships.map((m) => (
                  <option key={m.id} value={m.id} disabled={m.status !== 'active'}>{m.name}</option>
                ))}
              </select>
            )}
            {t && <Notifications />}
            <span className="hide-mobile">{longDate(today)}</span>
          </div>
        </header>
        <main className="content">
          <Outlet />
        </main>
      </div>

      <FormModal
        open={pwOpen}
        title="Change password"
        onClose={() => setPwOpen(false)}
        fields={[
          { name: 'currentPassword', label: 'Current password', type: 'password', required: true, span: 2 },
          { name: 'newPassword', label: 'New password', type: 'password', required: true, span: 2, hint: 'At least 8 characters with letters and numbers' },
        ]}
        onSubmit={async (v) => {
          await post('/auth/change-password', v);
          toast('Password changed. Other sessions were signed out.');
        }}
      />
    </div>
  );
}
