'use client';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { useRequireAuth } from '@/components/auth';
import { RouteMap } from '@/components/RouteMap';
import { Alert, Badge, Card, ErrorText, PageTitle, Spinner, StatusBadge } from '@/components/ui';
import { useI18n, type MessageKey } from '@/i18n';
import { api, post } from '@/lib/api';
import { dateTime, km, money } from '@/lib/format';

interface Place {
  addressLine: string;
  postcode: string;
  city: string;
  country: string;
  lat: number;
  lng: number;
  windowStart: string;
  windowEnd: string;
  contactName: string | null;
  contactPhone: string | null;
}
interface Detail {
  id: string;
  number: string;
  reference: string | null;
  status: string;
  serviceLevel: string;
  cargo: { description: string };
  totals: { weightKg: number; palletPlaces: number; loadingMetres: number };
  vehicleClass: string;
  route: { distanceKm: number; source: string };
  pickup: Place;
  delivery: Place;
  currency: string;
  estimatedTotalMinor: number;
  maxPriceMinor: number;
  fundedMinor: number;
  customs: {
    result: string;
    assessment: {
      procedures: Array<{ kind: string; reason: string; certainty: string }>;
      notes: string[];
      rulesVersion: string;
    };
  };
  search: { radiusKm: number; publishedAt: string | null; expiresAt: string | null };
  offers: Array<{
    id: string;
    carrierName: string;
    status: string;
    totalMinor: number;
    overMaxMinor: number;
    expiresAt: string;
  }>;
  booking: {
    carrierName: string;
    netMinor: number;
    vatMinor: number;
    totalMinor: number;
    bookedAt: string;
  } | null;
  payments: Array<{
    id: string;
    purpose: string;
    amountMinor: number;
    status: string;
    providerRef: string;
    failureReason: string | null;
    provider: string;
  }>;
  events: Array<{ kind: string; at: string; data: Record<string, unknown> }>;
}

export default function ShipmentPage() {
  const { me } = useRequireAuth('shipper');
  const { t, locale } = useI18n();
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const [s, setS] = useState<Detail | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(
    () => api<Detail>(`/api/shipments/${id}`).then(setS).catch(setError),
    [id],
  );
  useEffect(() => {
    if (!me) return;
    load();
    const timer = setInterval(load, 5_000); // live updates while carriers respond
    return () => clearInterval(timer);
  }, [me, load]);

  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      await load();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };

  if (!me || (!s && !error)) return <Spinner />;
  if (!s) return <ErrorText error={error} />;
  const m = (n: number) => money(n, s.currency, locale);
  const pendingPayment = s.payments.find((p) => p.status === 'pending');
  const failedPrepayment = s.status === 'awaiting_payment' && !pendingPayment;
  const waiting = s.offers.filter(
    (o) => o.status === 'pending_customer' || o.status === 'approved',
  );
  const notified = s.events
    .filter((e) => e.kind === 'matching.round')
    .reduce((n, e) => n + Number(e.data.carriersNotified ?? 0), 0);

  return (
    <div className="space-y-5">
      <PageTitle
        title={
          <span className="flex flex-wrap items-center gap-3">
            {s.pickup.city} → {s.delivery.city} <StatusBadge status={s.status} />
          </span>
        }
        subtitle={`${s.number}${s.reference ? ` · ${s.reference}` : ''} · ${t(`level.${s.serviceLevel}` as MessageKey)}`}
      />
      <ErrorText error={error} />

      {s.status === 'awaiting_payment' && (
        <Alert tone="amber" title={t('detail.awaitingPayment')}>
          {pendingPayment ? (
            <Link
              className="font-semibold underline"
              href={`/pay/${pendingPayment.providerRef}?shipment=${s.id}`}
            >
              {t('detail.payNow', { amount: m(pendingPayment.amountMinor) })}
            </Link>
          ) : failedPrepayment ? (
            <button
              className="font-semibold underline"
              disabled={busy}
              onClick={() =>
                act(async () => {
                  const p = await post<{ paymentRef: string }>(`/api/shipments/${s.id}/pay`);
                  router.push(`/pay/${p.paymentRef}?shipment=${s.id}`);
                })
              }
            >
              {t('detail.retryPayment')}
            </button>
          ) : null}
        </Alert>
      )}

      {s.status === 'searching' && (
        <Card className="flex items-center gap-4">
          <span className="relative flex h-4 w-4">
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-brand opacity-60" />
            <span className="relative inline-flex h-4 w-4 rounded-full bg-brand" />
          </span>
          <div>
            <div className="font-semibold">{t('detail.searching')}</div>
            <div className="text-sm text-ink-soft">
              {t('detail.searchingText', {
                radius: s.search.radiusKm,
                n: notified,
                until: dateTime(s.search.expiresAt, locale),
              })}
            </div>
          </div>
        </Card>
      )}

      {waiting.map((o) => (
        <Card key={o.id} className="border-amber-300">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <div className="font-semibold">
                {t('detail.offerTitle', { carrier: o.carrierName })}
              </div>
              <div className="mt-1 text-2xl font-bold">{m(o.totalMinor)}</div>
              <div className="text-sm text-amber-800">
                {t('detail.offerOver', { over: m(o.overMaxMinor), max: m(s.maxPriceMinor) })}
              </div>
              <div className="mt-1 text-xs text-ink-soft">
                {t('detail.offerExpires', { at: dateTime(o.expiresAt, locale) })}
              </div>
            </div>
            {o.status === 'pending_customer' ? (
              <div className="flex gap-2">
                <button
                  className="btn-secondary"
                  disabled={busy}
                  onClick={() => act(() => post(`/api/shipments/${s.id}/offers/${o.id}/reject`))}
                >
                  {t('detail.reject')}
                </button>
                <button
                  className="btn-primary"
                  disabled={busy}
                  onClick={() =>
                    act(async () => {
                      const r = await post<{ result: string; payment?: { paymentRef: string } }>(
                        `/api/shipments/${s.id}/offers/${o.id}/approve`,
                      );
                      if (r.payment) router.push(`/pay/${r.payment.paymentRef}?shipment=${s.id}`);
                    })
                  }
                >
                  {t('detail.approve')}
                </button>
              </div>
            ) : (
              pendingPayment && (
                <Link
                  className="btn-primary"
                  href={`/pay/${pendingPayment.providerRef}?shipment=${s.id}`}
                >
                  {t('detail.payDifference', { amount: m(pendingPayment.amountMinor) })}
                </Link>
              )
            )}
          </div>
          <p className="mt-3 text-xs text-ink-soft">{t('detail.offerNote')}</p>
        </Card>
      ))}

      {s.booking && (
        <Card className="border-emerald-300">
          <div className="text-sm font-semibold text-emerald-700">{t('detail.booked')}</div>
          <div className="mt-1 text-lg font-semibold">{s.booking.carrierName}</div>
          <div className="mt-1 text-sm text-ink-soft">
            {t('detail.finalPrice')}:{' '}
            <span className="font-semibold text-ink">{m(s.booking.totalMinor)}</span>
            {s.booking.vatMinor > 0 && ` (${t('book.inclVat', { vat: m(s.booking.vatMinor) })})`}
          </div>
          {s.fundedMinor > s.booking.totalMinor && (
            <div className="text-xs text-ink-soft">
              {t('detail.refundPending', { amount: m(s.fundedMinor - s.booking.totalMinor) })}
            </div>
          )}
        </Card>
      )}

      <div className="grid gap-5 lg:grid-cols-2">
        <Card className="space-y-4">
          {(['pickup', 'delivery'] as const).map((k) => {
            const p = s[k];
            return (
              <div key={k}>
                <div className="text-xs font-bold uppercase tracking-wider text-ink-soft">
                  {t(k === 'pickup' ? 'book.from' : 'book.to')}
                </div>
                <div className="font-medium">{p.addressLine}</div>
                <div className="text-sm text-ink-soft">
                  {p.postcode} {p.city}, {p.country}
                </div>
                <div className="text-sm text-ink-soft">
                  {dateTime(p.windowStart, locale)} – {dateTime(p.windowEnd, locale)}
                </div>
                {p.contactName && (
                  <div className="text-sm text-ink-soft">
                    {p.contactName} {p.contactPhone}
                  </div>
                )}
              </div>
            );
          })}
          <div>
            <div className="text-xs font-bold uppercase tracking-wider text-ink-soft">
              {t('book.what')}
            </div>
            <div className="font-medium">{s.cargo.description}</div>
            <div className="mt-1 flex flex-wrap gap-1.5">
              <Badge>{s.totals.weightKg} kg</Badge>
              <Badge>{t('book.palletPlaces', { n: s.totals.palletPlaces })}</Badge>
              <Badge>{s.totals.loadingMetres} ldm</Badge>
              <Badge>{t(`vehicle.${s.vehicleClass}` as MessageKey)}</Badge>
              <Badge>
                {km(s.route.distanceKm, locale)} ({t('book.estimated')})
              </Badge>
            </div>
          </div>
          <div className="text-sm text-ink-soft">
            {t('book.maximum')}:{' '}
            <span className="font-semibold text-ink">{m(s.maxPriceMinor)}</span> ·{' '}
            {t('detail.estimate')}: {m(s.estimatedTotalMinor)}
          </div>
        </Card>
        <RouteMap
          points={[
            { lat: s.pickup.lat, lng: s.pickup.lng, label: s.pickup.city, kind: 'pickup' },
            { lat: s.delivery.lat, lng: s.delivery.lng, label: s.delivery.city, kind: 'delivery' },
          ]}
          height={340}
        />
      </div>

      <Card>
        <div className="mb-2 font-semibold">{t('detail.customs')}</div>
        <div className="flex items-center gap-2">
          <Badge
            tone={
              s.customs.result === 'required'
                ? 'amber'
                : s.customs.result === 'not_required'
                  ? 'green'
                  : 'gray'
            }
          >
            {t(`customs.${s.customs.result}` as MessageKey)}
          </Badge>
          <span className="text-xs text-ink-faint">
            {t('detail.rulesVersion', { v: s.customs.assessment.rulesVersion })}
          </span>
        </div>
        {s.customs.assessment.procedures.length > 0 && (
          <ul className="mt-2 list-disc pl-5 text-sm text-ink-soft">
            {s.customs.assessment.procedures.map((p, i) => (
              <li key={i}>{p.reason}</li>
            ))}
          </ul>
        )}
        {s.customs.result !== 'not_required' && (
          <p className="mt-2 text-xs text-ink-faint">{t('customs.laterPhase')}</p>
        )}
      </Card>

      <Card>
        <div className="mb-3 font-semibold">{t('detail.history')}</div>
        <ol className="space-y-2 text-sm">
          {s.events.map((e, i) => (
            <li key={i} className="flex gap-3">
              <span className="w-44 shrink-0 text-ink-faint">{dateTime(e.at, locale)}</span>
              <span>
                {t(`event.${e.kind}` as MessageKey) === `event.${e.kind}`
                  ? e.kind
                  : t(
                      `event.${e.kind}` as MessageKey,
                      Object.fromEntries(
                        Object.entries(e.data).map(([k, v]) => [
                          k,
                          typeof v === 'number' && k.endsWith('Minor') ? m(v) : String(v),
                        ]),
                      ),
                    )}
              </span>
            </li>
          ))}
        </ol>
      </Card>

      {['awaiting_payment', 'searching'].includes(s.status) && (
        <div>
          <button
            className="btn-danger"
            disabled={busy}
            onClick={() => {
              const reason = prompt(t('detail.cancelReason'));
              if (reason) act(() => post(`/api/shipments/${s.id}/cancel`, { reason }));
            }}
          >
            {t('detail.cancel')}
          </button>
          <p className="mt-1 text-xs text-ink-faint">{t('detail.cancelNote')}</p>
        </div>
      )}
    </div>
  );
}
