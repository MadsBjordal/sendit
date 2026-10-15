'use client';
import { useCallback, useEffect, useState } from 'react';
import { RouteMap, type MapPoint } from '@/components/RouteMap';
import { Alert, Badge, Card } from '@/components/ui';
import { useI18n, type MessageKey } from '@/i18n';
import { api, post } from '@/lib/api';
import { dateTime, km } from '@/lib/format';

interface Trip {
  role: string;
  status: string;
  driverAssigned: boolean;
  podFileId: string | null;
  position: { lat: number; lng: number; at: string } | null;
  eta: { at: string; remainingKm: number } | null;
  acceptDeadline: string | null;
  events: Array<{
    action: string;
    occurredAt: string;
    countedUnits: number | null;
    discrepancy: string | null;
    damage: boolean;
    damageNote: string | null;
    recipientName: string | null;
    signatureFileId: string | null;
    photoFileIds: string[];
    delayMinutes: number | null;
    note: string | null;
    country: string | null;
  }>;
}

const STEPS = [
  'pickup.arrived',
  'pickup.loaded',
  'delivery.arrived',
  'delivery.delivered',
] as const;

/** Progress on the road: steps, live position with an estimated arrival, evidence and proof of delivery. */
export function TripPanel({
  shipmentId,
  pickup,
  delivery,
  onChanged,
}: {
  shipmentId: string;
  pickup: MapPoint;
  delivery: MapPoint;
  onChanged?(): void;
}) {
  const { t, locale } = useI18n();
  const [trip, setTrip] = useState<Trip | null>(null);
  const [busy, setBusy] = useState(false);
  const load = useCallback(
    () =>
      api<Trip>(`/api/shipments/${shipmentId}/trip`)
        .then(setTrip)
        .catch(() => {}),
    [shipmentId],
  );
  useEffect(() => {
    load();
    const timer = setInterval(load, 15_000);
    return () => clearInterval(timer);
  }, [load]);
  if (
    !trip ||
    !['booked', 'in_transit', 'delivered', 'completed', 'disputed'].includes(trip.status)
  )
    return null;
  const done = new Set(trip.events.map((e) => e.action));
  const points: MapPoint[] = [
    pickup,
    delivery,
    ...(trip.position
      ? [
          {
            lat: trip.position.lat,
            lng: trip.position.lng,
            label: t('trip.truckHere'),
            kind: 'vehicle' as const,
          },
        ]
      : []),
  ];
  return (
    <Card className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="font-semibold">{t('trip.title')}</div>
        {!trip.driverAssigned && trip.status === 'booked' && (
          <Badge tone="amber">{t('trip.noDriverYet')}</Badge>
        )}
      </div>
      <ol className="grid grid-cols-4 gap-2">
        {STEPS.map((s) => (
          <li
            key={s}
            className={`rounded-xl px-2 py-2 text-center text-xs font-medium ${done.has(s) ? 'bg-emerald-50 text-emerald-700' : 'bg-slate-100 text-ink-faint'}`}
          >
            {done.has(s) ? '✓ ' : ''}
            {t(`trip.${s}` as MessageKey)}
          </li>
        ))}
      </ol>
      {trip.eta && (
        <div className="text-sm">
          {t('trip.eta', {
            at: dateTime(trip.eta.at, locale),
            km: km(trip.eta.remainingKm, locale),
          })}{' '}
          <span className="text-ink-faint">({t('book.estimated')})</span>
        </div>
      )}
      {trip.position && <RouteMap points={points} height={240} />}
      <ul className="space-y-2 text-sm">
        {trip.events.map((e, i) => (
          <li key={i} className="flex flex-wrap gap-x-3">
            <span className="w-40 shrink-0 text-ink-faint">{dateTime(e.occurredAt, locale)}</span>
            <span className="font-medium">{t(`trip.${e.action}` as MessageKey)}</span>
            {e.countedUnits != null && <span>{t('trip.units', { n: e.countedUnits })}</span>}
            {e.recipientName && <span>{t('trip.receivedBy', { name: e.recipientName })}</span>}
            {e.delayMinutes && (
              <span className="text-amber-700">{t('trip.delay', { min: e.delayMinutes })}</span>
            )}
            {e.country && <span>{e.country}</span>}
            {e.discrepancy && <span className="text-amber-700">{e.discrepancy}</span>}
            {e.damage && (
              <span className="text-red-700">
                {t('trip.damage')}: {e.damageNote}
              </span>
            )}
            {e.note && <span className="text-ink-soft">{e.note}</span>}
            {[...(e.signatureFileId ? [e.signatureFileId] : []), ...e.photoFileIds].map((f) => (
              <a key={f} href={`/api/files/${f}`} target="_blank" rel="noreferrer">
                <img
                  src={`/api/files/${f}`}
                  alt=""
                  className="h-12 w-12 rounded-lg border border-slate-200 object-cover"
                />
              </a>
            ))}
          </li>
        ))}
      </ul>
      {trip.podFileId && (
        <a
          className="btn-secondary"
          href={`/api/files/${trip.podFileId}`}
          target="_blank"
          rel="noreferrer"
        >
          {t('trip.downloadPod')}
        </a>
      )}
      {trip.status === 'delivered' && trip.role === 'shipper' && (
        <Alert tone="blue" title={t('trip.confirmTitle')}>
          {t('trip.confirmText', { at: dateTime(trip.acceptDeadline, locale) })}
          <div className="mt-2 flex flex-wrap gap-2">
            <button
              className="btn-primary px-3 py-1.5 text-sm"
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                await post(`/api/shipments/${shipmentId}/confirm-delivery`).catch(() => {});
                setBusy(false);
                load();
                onChanged?.();
              }}
            >
              {t('trip.confirm')}
            </button>
            <a
              className="btn-secondary px-3 py-1.5 text-sm"
              href={`/shipments/${shipmentId}/dispute`}
            >
              {t('trip.reportProblem')}
            </a>
          </div>
        </Alert>
      )}
    </Card>
  );
}
