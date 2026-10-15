'use client';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { useRequireAuth } from '@/components/auth';
import { Badge, Empty, ErrorText, PageTitle, Spinner, StatusBadge } from '@/components/ui';
import { useI18n, type MessageKey } from '@/i18n';
import { api } from '@/lib/api';
import { date, money } from '@/lib/format';

interface Row {
  id: string;
  number: string;
  reference: string | null;
  status: string;
  serviceLevel: string;
  from: { city: string; country: string; windowStart: string };
  to: { city: string; country: string };
  maxPriceMinor: number;
  currency: string;
  pendingOffers: number;
}

export default function Shipments() {
  const { me } = useRequireAuth('shipper');
  const { t, locale } = useI18n();
  const [rows, setRows] = useState<Row[] | null>(null);
  const [error, setError] = useState<unknown>(null);
  useEffect(() => {
    if (me) api<Row[]>('/api/shipments').then(setRows).catch(setError);
  }, [me]);
  if (!me) return <Spinner />;
  return (
    <div>
      <PageTitle
        title={t('nav.shipments')}
        actions={
          <Link href="/book" className="btn-primary">
            {t('book.title')}
          </Link>
        }
      />
      <ErrorText error={error} />
      {!rows && !error && <Spinner />}
      {rows && rows.length === 0 && (
        <Empty title={t('shipments.empty')}>
          <Link href="/book" className="btn-primary mt-4">
            {t('book.title')}
          </Link>
        </Empty>
      )}
      {rows && rows.length > 0 && (
        <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-card">
          {rows.map((r) => (
            <Link
              key={r.id}
              href={`/shipments/${r.id}`}
              className="flex flex-wrap items-center gap-x-4 gap-y-1 border-b border-slate-100 px-4 py-3 last:border-0 hover:bg-slate-50"
            >
              <div className="w-28 font-mono text-sm text-ink-soft">{r.number}</div>
              <div className="min-w-48 flex-1 font-medium">
                {r.from.city} ({r.from.country}) → {r.to.city} ({r.to.country})
                {r.reference && <span className="ml-2 text-sm text-ink-faint">{r.reference}</span>}
              </div>
              <div className="text-sm text-ink-soft">{date(r.from.windowStart, locale)}</div>
              <div className="text-sm text-ink-soft">
                {t(`level.${r.serviceLevel}` as MessageKey)}
              </div>
              <div className="w-28 text-right text-sm">
                {money(r.maxPriceMinor, r.currency, locale)}
              </div>
              {r.pendingOffers > 0 && (
                <Badge tone="amber">{t('shipments.offersWaiting', { n: r.pendingOffers })}</Badge>
              )}
              <StatusBadge status={r.status} />
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
