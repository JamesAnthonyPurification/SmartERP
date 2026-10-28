import { createContext, ReactNode, useCallback, useContext, useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { ApiError, get, post } from './api';
import { setCurrencySymbol } from './format';

export interface Me {
  user: { id: string; email: string; name: string; isPlatformAdmin: boolean };
  tenant: {
    id: string;
    name: string;
    slug: string;
    status: string;
    companyName: string;
    tagline: string;
    currencySymbol: string;
    roleName: string;
    permissions: string[];
    warehouseIds: string[] | null;
  } | null;
  memberships: { id: string; name: string; slug: string; status: string }[];
}

interface AuthState {
  me: Me | null;
  loading: boolean;
  login: (email: string, password: string, tenant?: string) => Promise<void>;
  logout: () => Promise<void>;
  switchTenant: (tenantId: string) => Promise<void>;
  refresh: () => Promise<void>;
  can: (perm: string | string[]) => boolean;
}

const AuthContext = createContext<AuthState>(null as unknown as AuthState);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [me, setMe] = useState<Me | null>(null);
  const [loading, setLoading] = useState(true);
  const qc = useQueryClient();

  const apply = useCallback((m: Me | null) => {
    setMe(m);
    if (m?.tenant) setCurrencySymbol(m.tenant.currencySymbol);
  }, []);

  const refresh = useCallback(async () => {
    try {
      apply(await get<Me>('/auth/me'));
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) apply(null);
      else throw err;
    } finally {
      setLoading(false);
    }
  }, [apply]);

  useEffect(() => {
    refresh().catch(() => setLoading(false));
    const onUnauthorized = () => apply(null);
    window.addEventListener('serp:unauthorized', onUnauthorized);
    return () => window.removeEventListener('serp:unauthorized', onUnauthorized);
  }, [refresh, apply]);

  const value: AuthState = {
    me,
    loading,
    login: async (email, password, tenant) => {
      qc.clear();
      apply(await post<Me>('/auth/login', { email, password, tenant: tenant || undefined }));
    },
    logout: async () => {
      await post('/auth/logout').catch(() => undefined);
      qc.clear();
      apply(null);
    },
    switchTenant: async (tenantId) => {
      const m = await post<Me>('/auth/switch-tenant', { tenantId });
      qc.clear(); // never show one tenant's cached data inside another
      apply(m);
    },
    refresh,
    can: (perm) => {
      const granted = me?.tenant?.permissions ?? [];
      if (granted.includes('*')) return true;
      return (Array.isArray(perm) ? perm : [perm]).some((p) => granted.includes(p));
    },
  };

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export const useAuth = () => useContext(AuthContext);
