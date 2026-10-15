'use client';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect } from 'react';
import { homeFor, useAuth } from '@/components/auth';
import { Spinner } from '@/components/ui';
import { useI18n } from '@/i18n';

export default function Home() {
  const { me, loading } = useAuth();
  const { t } = useI18n();
  const router = useRouter();
  useEffect(() => {
    if (!loading && me) router.replace(homeFor(me));
  }, [loading, me, router]);
  if (loading || me) return <Spinner />;
  return (
    <div className="mx-auto max-w-3xl py-10 text-center">
      <h1 className="text-4xl font-extrabold tracking-tight sm:text-5xl">{t('home.title')}</h1>
      <p className="mx-auto mt-4 max-w-xl text-lg text-ink-soft">{t('home.subtitle')}</p>
      <div className="mt-8 flex flex-wrap justify-center gap-3">
        <Link href="/register?kind=shipper" className="btn-primary px-6 py-3 text-base">
          {t('home.ship')}
        </Link>
        <Link href="/register?kind=carrier" className="btn-secondary px-6 py-3 text-base">
          {t('home.carry')}
        </Link>
      </div>
      <p className="mt-6 text-sm text-ink-soft">
        {t('home.haveAccount')}{' '}
        <Link href="/login" className="font-semibold text-brand">
          {t('auth.login')}
        </Link>
      </p>
      <div className="mt-14 grid gap-4 text-left sm:grid-cols-3">
        {(['home.point1', 'home.point2', 'home.point3'] as const).map((k) => (
          <div key={k} className="card">
            <div className="font-semibold">{t(`${k}.title` as never)}</div>
            <div className="mt-1 text-sm text-ink-soft">{t(`${k}.text` as never)}</div>
          </div>
        ))}
      </div>
    </div>
  );
}
