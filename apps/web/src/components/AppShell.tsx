'use client';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useState, type ReactNode } from 'react';
import { LOCALE_NAMES, useI18n, type Locale, type MessageKey } from '@/i18n';
import { api, post } from '@/lib/api';
import { useAuth } from './auth';
import { TestBanner } from './ui';

const NAV: Record<string, Array<{ href: string; key: MessageKey }>> = {
  shipper: [
    { href: '/book', key: 'nav.book' },
    { href: '/shipments', key: 'nav.shipments' },
    { href: '/team', key: 'nav.team' },
  ],
  carrier: [
    { href: '/carrier/loads', key: 'nav.loads' },
    { href: '/carrier/bookings', key: 'nav.jobs' },
    { href: '/carrier/fleet', key: 'nav.fleet' },
    { href: '/carrier/verification', key: 'nav.verification' },
    { href: '/team', key: 'nav.team' },
  ],
  staff: [{ href: '/admin', key: 'nav.admin' }],
};

export function LanguageSelect() {
  const { locale, setLocale, t } = useI18n();
  return (
    <select
      aria-label={t('common.language')}
      value={locale}
      onChange={(e) => setLocale(e.target.value as Locale)}
      className="rounded-lg border border-slate-200 bg-white px-2 py-1 text-sm"
    >
      {Object.entries(LOCALE_NAMES).map(([k, v]) => (
        <option key={k} value={k}>
          {v}
        </option>
      ))}
    </select>
  );
}

export function AppShell({ children }: { children: ReactNode }) {
  const { me, refresh } = useAuth();
  const { t } = useI18n();
  const path = usePathname();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [unread, setUnread] = useState(0);

  useEffect(() => {
    if (!me) return;
    let stop = false;
    const load = () =>
      api<Array<{ readAt: string | null }>>('/api/notifications')
        .then((n) => !stop && setUnread(n.filter((x) => !x.readAt).length))
        .catch(() => {});
    load();
    const timer = setInterval(load, 20_000);
    return () => {
      stop = true;
      clearInterval(timer);
    };
  }, [me]);

  const items =
    (me ? (me.user.platformRole ? NAV.staff : NAV[me.org?.kind ?? '']) : undefined) ?? [];
  const logout = async () => {
    await post('/api/auth/logout');
    await refresh();
    router.push('/login');
  };

  return (
    <div className="min-h-screen">
      <TestBanner />
      <header className="sticky top-0 z-[1000] border-b border-slate-200 bg-white/90 backdrop-blur">
        <div className="mx-auto flex h-14 max-w-6xl items-center gap-4 px-4">
          <Link href="/" className="flex items-center gap-2 font-bold tracking-tight">
            <span className="grid h-8 w-8 place-items-center rounded-lg bg-brand text-sm text-white">
              {(me?.brand.shortName ?? 'F').slice(0, 1)}
            </span>
            <span className="hidden sm:inline">{me?.brand.name ?? 'Project Freight'}</span>
          </Link>
          <nav className="hidden flex-1 items-center gap-1 md:flex">
            {items.map((i) => (
              <Link
                key={i.href}
                href={i.href}
                className={`rounded-lg px-3 py-1.5 text-sm font-medium ${path.startsWith(i.href) ? 'bg-brand-soft text-brand-dark' : 'text-ink-soft hover:bg-slate-100'}`}
              >
                {t(i.key)}
              </Link>
            ))}
          </nav>
          <div className="ml-auto flex items-center gap-2">
            <LanguageSelect />
            {me && (
              <>
                <span
                  className="relative hidden text-sm text-ink-soft sm:inline"
                  title={t('common.notifications')}
                >
                  🔔
                  {unread > 0 && (
                    <span className="absolute -right-2 -top-1 rounded-full bg-red-500 px-1.5 text-[10px] font-bold text-white">
                      {unread}
                    </span>
                  )}
                </span>
                <span className="hidden text-sm text-ink-soft lg:inline">{me.org?.name}</span>
                <button onClick={logout} className="btn-ghost px-2 py-1 text-sm">
                  {t('auth.logout')}
                </button>
              </>
            )}
            {items.length > 0 && (
              <button
                className="btn-ghost px-2 py-1 md:hidden"
                onClick={() => setOpen(!open)}
                aria-label={t('common.menu')}
              >
                ☰
              </button>
            )}
          </div>
        </div>
        {open && (
          <nav className="border-t border-slate-200 px-4 py-2 md:hidden">
            {items.map((i) => (
              <Link
                key={i.href}
                href={i.href}
                onClick={() => setOpen(false)}
                className="block rounded-lg px-3 py-2 text-sm font-medium text-ink-soft hover:bg-slate-100"
              >
                {t(i.key)}
              </Link>
            ))}
          </nav>
        )}
      </header>
      {me && !me.user.emailVerified && <VerifyEmailBar />}
      <main className="mx-auto max-w-6xl px-4 py-8">{children}</main>
    </div>
  );
}

function VerifyEmailBar() {
  const { t } = useI18n();
  const [sent, setSent] = useState(false);
  return (
    <div className="border-b border-amber-200 bg-amber-50 px-4 py-2 text-center text-sm text-amber-900">
      {t('auth.verifyFirst')}{' '}
      <button
        className="font-semibold underline"
        disabled={sent}
        onClick={() => post('/api/auth/resend-verification').then(() => setSent(true))}
      >
        {sent ? t('auth.verificationSent') : t('auth.resend')}
      </button>
    </div>
  );
}
