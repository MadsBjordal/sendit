'use client';
import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import { api, ApiError } from '@/lib/api';

export interface Me {
  user: {
    id: string;
    email: string;
    name: string;
    locale: string;
    emailVerified: boolean;
    platformRole: string | null;
    mfaEnabled: boolean;
  };
  org: {
    id: string;
    kind: 'shipper' | 'carrier' | 'customs_provider' | 'platform';
    name: string;
    status: string;
    country: string;
  } | null;
  role: string | null;
  mfaPassed: boolean;
  organisations: Array<{ id: string; name: string; kind: string; role: string }>;
  brand: { name: string; shortName: string; supportEmail: string };
}

const Ctx = createContext<{ me: Me | null; loading: boolean; refresh(): Promise<void> }>({
  me: null,
  loading: true,
  refresh: async () => {},
});

export function AuthProvider({ children }: { children: ReactNode }) {
  const [me, setMe] = useState<Me | null>(null);
  const [loading, setLoading] = useState(true);
  const refresh = useCallback(async () => {
    try {
      setMe(await api<Me>('/api/auth/me'));
    } catch (e) {
      if (!(e instanceof ApiError && e.status === 401)) console.error(e);
      setMe(null);
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    refresh();
  }, [refresh]);
  return <Ctx.Provider value={{ me, loading, refresh }}>{children}</Ctx.Provider>;
}

export function useAuth() {
  return useContext(Ctx);
}

/** For pages that need a login (and optionally a company type): sends others to the login page. */
export function useRequireAuth(
  kind?: Me['org'] extends infer O ? (O extends { kind: infer K } ? K | K[] : never) : never,
) {
  const { me, loading, refresh } = useAuth();
  const router = useRouter();
  const kinds = kind ? (Array.isArray(kind) ? kind : [kind]) : null;
  const allowed = !!me && (!kinds || (!!me.org && kinds.includes(me.org.kind)));
  useEffect(() => {
    if (loading) return;
    if (!me) router.replace('/login');
    else if (!allowed) router.replace('/');
  }, [loading, me, allowed, router]);
  return { me: allowed ? me : null, loading: loading || !allowed, refresh };
}

export function homeFor(me: Me | null): string {
  if (!me) return '/login';
  if (me.user.platformRole) return '/admin';
  if (me.org?.kind === 'carrier') return '/carrier/loads';
  if (me.org?.kind === 'shipper') return '/book';
  if (me.org?.kind === 'customs_provider') return '/customs/jobs';
  return '/team';
}
