import { useMutation, useQuery, useQueryClient, UseQueryOptions } from '@tanstack/react-query';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

type Query = Record<string, string | number | boolean | null | undefined>;

export function buildUrl(path: string, query?: Query) {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(query ?? {})) {
    if (v !== undefined && v !== null && v !== '') params.set(k, String(v));
  }
  const qs = params.toString();
  return `/api${path}${qs ? `?${qs}` : ''}`;
}

export async function api<T = any>(path: string, opts: { method?: string; body?: unknown; query?: Query } = {}): Promise<T> {
  const res = await fetch(buildUrl(path, opts.query), {
    method: opts.method ?? 'GET',
    headers: opts.body !== undefined ? { 'content-type': 'application/json' } : {},
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    credentials: 'same-origin',
  });
  const isJson = (res.headers.get('content-type') ?? '').includes('json');
  const data = isJson ? await res.json() : await res.text();
  if (!res.ok) {
    if (res.status === 401 && !path.startsWith('/auth/')) window.dispatchEvent(new Event('serp:unauthorized'));
    throw new ApiError(res.status, (isJson && data?.message) || res.statusText || 'Request failed');
  }
  return data as T;
}

export const get = <T = any>(path: string, query?: Query) => api<T>(path, { query });
export const post = <T = any>(path: string, body: unknown = {}) => api<T>(path, { method: 'POST', body });
export const put = <T = any>(path: string, body: unknown = {}) => api<T>(path, { method: 'PUT', body });
export const patch = <T = any>(path: string, body: unknown = {}) => api<T>(path, { method: 'PATCH', body });
export const del = <T = any>(path: string) => api<T>(path, { method: 'DELETE' });

/** Cached GET. The query key is the path + params, so mutations can invalidate by path prefix. */
export function useGet<T = any>(path: string | null, query?: Query, opts?: Partial<UseQueryOptions<T>>) {
  return useQuery<T>({
    queryKey: [path, query ?? {}],
    queryFn: () => get<T>(path!, query),
    enabled: !!path,
    ...opts,
  });
}

/** Mutation that refreshes every cached query whose path starts with one of `invalidate`. */
export function useAction<TInput, TResult = any>(fn: (input: TInput) => Promise<TResult>, invalidate: string[] = []) {
  const qc = useQueryClient();
  return useMutation<TResult, ApiError, TInput>({
    mutationFn: fn,
    onSuccess: () =>
      qc.invalidateQueries({
        predicate: (q) => typeof q.queryKey[0] === 'string' && invalidate.some((p) => (q.queryKey[0] as string).startsWith(p)),
      }),
  });
}

export function downloadCsv(path: string, query?: Query) {
  const a = document.createElement('a');
  a.href = buildUrl(path, { ...query, format: 'csv' });
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
}

export interface Paged<T> {
  rows: T[];
  total: number;
  [k: string]: any;
}

export interface Lookups {
  warehouses: { id: string; code: string; name: string; kind: string; is_default: boolean; allowed: boolean }[];
  categories: { id: string; name: string }[];
  accounts: { id: string; code: string; name: string; type: string; is_money: boolean; money_kind: string | null; system_key: string | null }[];
  settings: {
    company_name: string;
    tagline: string;
    currency_symbol: string;
    currency_code: string;
    timezone: string;
    default_vat_rate: number;
    invoice_prefix: string;
    allow_negative_stock: boolean;
    receipt_footer: string;
    address: string | null;
    phone: string | null;
    email: string | null;
    tax_id: string | null;
    today: string;
  };
}

export const useLookups = (enabled = true) => useGet<Lookups>(enabled ? '/lookups' : null, undefined, { staleTime: 60_000 });
