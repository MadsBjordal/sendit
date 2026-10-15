'use client';
import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { useRequireAuth } from '@/components/auth';
import { Alert, Badge, Card, Empty, ErrorText, PageTitle, Spinner } from '@/components/ui';
import { useI18n, type MessageKey } from '@/i18n';
import { api, post } from '@/lib/api';
import { dateTime, money } from '@/lib/format';

interface OpenJob {
  id: string;
  service: string;
  country: string;
  mode: string;
  listedFeeMinor: number | null;
  currency: string;
  route: string;
  pickupFrom: string;
  goods: string;
  hsCode: string | null;
  expiresAt: string;
  myQuote: { feeMinor: number } | null;
}
interface MyJob {
  id: string;
  shipmentId: string;
  service: string;
  country: string;
  status: string;
  providerFeeMinor: number | null;
  currency: string;
  route: string;
  procedures: Array<{ id: string; kind: string; status: string; reference: string | null }>;
}

export default function CustomsJobs() {
  const { me } = useRequireAuth('customs_provider');
  const { t, locale } = useI18n();
  const [open, setOpen] = useState<{ jobs: OpenJob[]; problems: string[] } | null>(null);
  const [mine, setMine] = useState<MyJob[]>([]);
  const [error, setError] = useState<unknown>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [fees, setFees] = useState<Record<string, string>>({});
  const load = useCallback(() => {
    api('/api/customs-provider/jobs/open').then(setOpen).catch(setError);
    api<MyJob[]>('/api/customs-provider/jobs')
      .then(setMine)
      .catch(() => {});
  }, []);
  useEffect(() => {
    if (!me) return;
    load();
    const timer = setInterval(load, 15_000);
    return () => clearInterval(timer);
  }, [me, load]);
  if (!me) return <Spinner />;
  const accept = async (j: OpenJob) => {
    setError(null);
    try {
      const fee = fees[j.id] ? Math.round(Number(fees[j.id]!.replace(',', '.')) * 100) : undefined;
      const r = await post<{ result: string }>(
        `/api/customs-provider/jobs/${j.id}/accept`,
        fee ? { feeMinor: fee } : {},
      );
      setMsg(t(`customsJobs.result.${r.result}` as MessageKey));
      load();
    } catch (e) {
      setError(e);
    }
  };
  return (
    <div className="space-y-6">
      <PageTitle title={t('nav.customsJobs')} />
      {open && open.problems.length > 0 && (
        <Alert tone="amber" title={t('customsJobs.cannotAccept')}>
          {open.problems.map((p) => t(`problem.${p}` as MessageKey)).join(' · ')}{' '}
          <Link className="underline" href="/customs/profile">
            {t('nav.customsProfile')}
          </Link>
        </Alert>
      )}
      {msg && <Alert tone="blue" title={msg} />}
      <ErrorText error={error} />
      <div>
        <h2 className="mb-2 font-semibold">{t('customsJobs.open')}</h2>
        {!open && <Spinner />}
        {open?.jobs.length === 0 && (
          <Empty title={t('customsJobs.none')}>{t('customsJobs.noneText')}</Empty>
        )}
        <div className="grid gap-3 md:grid-cols-2">
          {open?.jobs.map((j) => (
            <Card key={j.id}>
              <div className="flex items-start justify-between gap-2">
                <div>
                  <div className="font-semibold">
                    {t(`service.${j.service}` as MessageKey)} · {j.country}
                  </div>
                  <div className="text-sm text-ink-soft">{j.route}</div>
                </div>
                {j.listedFeeMinor != null && (
                  <div className="text-xl font-bold">
                    {money(j.listedFeeMinor, j.currency, locale)}
                  </div>
                )}
              </div>
              <div className="mt-2 text-sm">
                {j.goods}
                {j.hsCode && <span className="ml-2 font-mono text-xs">HS {j.hsCode}</span>}
              </div>
              <div className="text-xs text-ink-faint">
                {t('customsJobs.pickup', { at: dateTime(j.pickupFrom, locale) })} ·{' '}
                {t('detail.offerExpires', { at: dateTime(j.expiresAt, locale) })}
              </div>
              {j.myQuote && <Badge tone="blue">{t('loads.yourOffer')}</Badge>}
              <div className="mt-3 flex gap-2">
                <input
                  className="input w-32"
                  inputMode="decimal"
                  placeholder={
                    j.mode === 'standard' ? t('customsJobs.otherFee') : t('customsJobs.yourFee')
                  }
                  value={fees[j.id] ?? ''}
                  onChange={(e) => setFees({ ...fees, [j.id]: e.target.value })}
                />
                <button
                  className="btn-primary flex-1"
                  disabled={j.mode !== 'standard' && !fees[j.id]}
                  onClick={() => accept(j)}
                >
                  {fees[j.id] ? t('customsJobs.sendPrice') : t('customsJobs.accept')}
                </button>
              </div>
            </Card>
          ))}
        </div>
      </div>
      <div>
        <h2 className="mb-2 font-semibold">{t('customsJobs.mine')}</h2>
        {mine.length === 0 && <p className="text-sm text-ink-faint">{t('customsJobs.noneMine')}</p>}
        <div className="space-y-2">
          {mine.map((j) => (
            <Link
              key={j.id}
              href={`/customs/shipments/${j.shipmentId}`}
              className="card block hover:border-brand/50"
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="font-medium">
                  {t(`service.${j.service}` as MessageKey)} · {j.route}
                </div>
                <div className="flex items-center gap-2">
                  {j.providerFeeMinor != null && (
                    <span className="font-semibold">
                      {money(j.providerFeeMinor, j.currency, locale)}
                    </span>
                  )}
                  <Badge tone={j.status === 'completed' ? 'green' : 'blue'}>
                    {t(`customsJobs.status.${j.status}` as MessageKey)}
                  </Badge>
                </div>
              </div>
              <div className="mt-1 flex flex-wrap gap-2 text-xs">
                {j.procedures.map((p) => (
                  <span key={p.id}>
                    {t(`proc.${p.kind}` as MessageKey)}:{' '}
                    {t(`proc.status.${p.status}` as MessageKey)}{' '}
                    {p.reference && <span className="font-mono">{p.reference}</span>}
                  </span>
                ))}
              </div>
            </Link>
          ))}
        </div>
      </div>
    </div>
  );
}
