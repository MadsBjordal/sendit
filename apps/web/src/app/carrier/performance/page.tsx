'use client';
import { useEffect, useState } from 'react';
import { useRequireAuth } from '@/components/auth';
import { Badge, Card, ErrorText, PageTitle, Spinner } from '@/components/ui';
import { useI18n, type MessageKey } from '@/i18n';
import { api } from '@/lib/api';

interface Performance {
  jobs: number;
  delivered: number;
  onTimeDelivery: number | null;
  onTimePickup: number | null;
  trackingShare: number | null;
  claimRate: number | null;
  standing: 'new' | 'good' | 'fair' | 'at_risk';
}

const TONE = { new: 'gray', good: 'green', fair: 'amber', at_risk: 'red' } as const;

/** Like the performance screen in carrier apps: how reliable the company has been, from our own records. */
export default function PerformancePage() {
  const { me } = useRequireAuth('carrier');
  const { t } = useI18n();
  const [p, setP] = useState<Performance | null>(null);
  const [error, setError] = useState<unknown>(null);
  useEffect(() => {
    if (me) api<Performance>('/api/carrier/performance').then(setP).catch(setError);
  }, [me]);
  if (!me) return <Spinner />;
  if (!p) return error ? <ErrorText error={error} /> : <Spinner />;
  const pct = (v: number | null) => (v === null ? '–' : `${Math.round(v * 100)} %`);
  const rows: Array<[MessageKey, string, MessageKey]> = [
    ['perf.onTimeDelivery', pct(p.onTimeDelivery), 'perf.onTimeDeliveryHint'],
    ['perf.onTimePickup', pct(p.onTimePickup), 'perf.onTimePickupHint'],
    ['perf.tracking', pct(p.trackingShare), 'perf.trackingHint'],
    ['perf.claims', pct(p.claimRate), 'perf.claimsHint'],
  ];
  return (
    <div className="space-y-5">
      <PageTitle title={t('nav.performance')} subtitle={t('perf.subtitle')} />
      <Card className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <div className="text-xs text-ink-soft">{t('perf.standing')}</div>
          <Badge tone={TONE[p.standing]}>{t(`perf.standing.${p.standing}` as MessageKey)}</Badge>
        </div>
        <div className="text-sm text-ink-soft">
          {t('perf.counts', { jobs: p.jobs, delivered: p.delivered })}
        </div>
      </Card>
      <div className="grid gap-3 sm:grid-cols-2">
        {rows.map(([k, v, hint]) => (
          <Card key={k}>
            <div className="text-xs text-ink-soft">{t(k)}</div>
            <div className="text-3xl font-extrabold">{v}</div>
            <p className="mt-1 text-xs text-ink-soft">{t(hint)}</p>
          </Card>
        ))}
      </div>
    </div>
  );
}
