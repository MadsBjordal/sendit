'use client';
import { useEffect, useState } from 'react';
import { TripPanel } from '@/components/TripPanel';
import { Messages } from '@/components/Messages';
import { useRequireAuth } from '@/components/auth';
import {
  Badge,
  Card,
  Empty,
  ErrorText,
  PageTitle,
  problemText,
  Spinner,
  StatusBadge,
} from '@/components/ui';
import { useI18n, type MessageKey } from '@/i18n';
import { api, post } from '@/lib/api';
import { dateTime, km, money } from '@/lib/format';

interface Job {
  bookingId: string;
  number: string;
  status: string;
  shipper: string;
  pickup: {
    addressLine: string;
    postcode: string;
    city: string;
    lat: number;
    lng: number;
    country: string;
    windowStart: string;
    windowEnd: string;
    contactName: string | null;
    contactPhone: string | null;
    instructions: string | null;
  };
  delivery: {
    addressLine: string;
    postcode: string;
    city: string;
    lat: number;
    lng: number;
    country: string;
    windowStart: string;
    windowEnd: string;
    contactName: string | null;
    contactPhone: string | null;
    instructions: string | null;
  };
  cargo: { description: string };
  weightKg: number;
  palletPlaces: number;
  distanceKm: number;
  customs: { result: string };
  payoutMinor: number;
  currency: string;
  guarantee: { status: string; funded: boolean; terms: string } | null;
  driverId: string | null;
  shipmentId: string;
}
interface Offer {
  id: string;
  number: string;
  status: string;
  payoutMinor: number;
  currency: string;
  expiresAt: string;
}

export default function Bookings() {
  const { me } = useRequireAuth('carrier');
  const { t, locale } = useI18n();
  const [jobs, setJobs] = useState<Job[] | null>(null);
  const [offers, setOffers] = useState<Offer[]>([]);
  const [error, setError] = useState<unknown>(null);
  const load = () => {
    api<Job[]>('/api/carrier/bookings').then(setJobs).catch(setError);
    api<Offer[]>('/api/carrier/offers')
      .then(setOffers)
      .catch(() => {});
  };
  useEffect(() => {
    if (me) load();
  }, [me]);
  if (!me) return <Spinner />;
  const open = offers.filter((o) => o.status === 'pending_customer' || o.status === 'approved');
  return (
    <div className="space-y-6">
      <PageTitle title={t('nav.jobs')} />
      <ErrorText error={error} />
      {open.length > 0 && (
        <div>
          <h2 className="mb-2 font-semibold">{t('jobs.openOffers')}</h2>
          <div className="space-y-2">
            {open.map((o) => (
              <Card key={o.id} className="flex flex-wrap items-center justify-between gap-3 py-3">
                <div>
                  <span className="font-mono text-sm text-ink-soft">{o.number}</span> ·{' '}
                  {money(o.payoutMinor, o.currency, locale)}
                  <div className="text-xs text-ink-soft">
                    {t('detail.offerExpires', { at: dateTime(o.expiresAt, locale) })}
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <StatusBadge status={o.status} />
                  {o.status === 'pending_customer' && (
                    <button
                      className="btn-ghost text-sm"
                      onClick={() => post(`/api/carrier/offers/${o.id}/withdraw`).then(load)}
                    >
                      {t('jobs.withdraw')}
                    </button>
                  )}
                </div>
              </Card>
            ))}
          </div>
        </div>
      )}
      {!jobs && !error && <Spinner />}
      {jobs && jobs.length === 0 && <Empty title={t('jobs.empty')} />}
      {jobs?.map((j) => (
        <Card key={j.bookingId}>
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <div className="font-mono text-sm text-ink-soft">
                {j.number} · {j.shipper}
              </div>
              <div className="text-lg font-semibold">
                {j.pickup.city} → {j.delivery.city}
              </div>
            </div>
            <div className="text-right">
              <div className="text-2xl font-extrabold">
                {money(j.payoutMinor, j.currency, locale)}
              </div>
              {j.guarantee?.funded && <Badge tone="green">{t('loads.guaranteed')}</Badge>}
            </div>
          </div>
          <div className="mt-4 grid gap-4 sm:grid-cols-2">
            {(['pickup', 'delivery'] as const).map((k) => (
              <div key={k} className="text-sm">
                <div className="text-xs font-bold uppercase tracking-wider text-ink-soft">
                  {t(k === 'pickup' ? 'book.from' : 'book.to')}
                </div>
                <div className="font-medium">{j[k].addressLine}</div>
                <div className="text-ink-soft">
                  {j[k].postcode} {j[k].city}, {j[k].country}
                </div>
                <div className="text-ink-soft">
                  {dateTime(j[k].windowStart, locale)} – {dateTime(j[k].windowEnd, locale)}
                </div>
                {j[k].contactName && (
                  <div>
                    {j[k].contactName} · {j[k].contactPhone}
                  </div>
                )}
                {j[k].instructions && <div className="text-ink-soft">{j[k].instructions}</div>}
              </div>
            ))}
          </div>
          <div className="mt-3 flex flex-wrap gap-1.5">
            <StatusBadge status={j.status} />
            <Badge>{j.cargo.description}</Badge>
            <Badge>{j.weightKg} kg</Badge>
            <Badge>{km(j.distanceKm, locale)}</Badge>
            {j.customs.result !== 'not_required' && (
              <Badge tone="amber">{t(`customs.${j.customs.result}` as MessageKey)}</Badge>
            )}
          </div>
          {j.guarantee && <p className="mt-3 text-xs text-ink-soft">{j.guarantee.terms}</p>}
          <JobActions job={j} onChanged={load} />
        </Card>
      ))}
    </div>
  );
}

interface DriverOption {
  id: string;
  name: string;
  phone: string | null;
  deadheadKm: number;
  locationSource: string;
  problems: Array<{ code: string }>;
  assigned: boolean;
}

function JobActions({ job, onChanged }: { job: Job; onChanged(): void }) {
  const { t } = useI18n();
  const [open, setOpen] = useState<'assign' | 'trip' | null>(null);
  return (
    <div className="mt-4 border-t border-slate-100 pt-3">
      <div className="flex flex-wrap gap-2">
        {['booked', 'in_transit'].includes(job.status) && (
          <button
            className={
              job.driverId ? 'btn-secondary px-3 py-1.5 text-sm' : 'btn-primary px-3 py-1.5 text-sm'
            }
            onClick={() => setOpen(open === 'assign' ? null : 'assign')}
          >
            {job.driverId ? t('jobs.changeDriver') : t('jobs.assignDriver')}
          </button>
        )}
        <button
          className="btn-ghost px-3 py-1.5 text-sm"
          onClick={() => setOpen(open === 'trip' ? null : 'trip')}
        >
          {t('jobs.progress')}
        </button>
      </div>
      {open === 'assign' && (
        <AssignDriver bookingId={job.bookingId} onDone={() => (setOpen(null), onChanged())} />
      )}
      {open === 'trip' && (
        <div className="mt-3 space-y-3">
          <TripPanel
            shipmentId={job.shipmentId}
            pickup={{
              lat: job.pickup.lat,
              lng: job.pickup.lng,
              label: job.pickup.city,
              kind: 'pickup',
            }}
            delivery={{
              lat: job.delivery.lat,
              lng: job.delivery.lng,
              label: job.delivery.city,
              kind: 'delivery',
            }}
          />
          <Messages shipmentId={job.shipmentId} />
        </div>
      )}
    </div>
  );
}

/** Like the "Assign a driver" screen: drivers with their empty kilometres to the pickup, eligible first. */
function AssignDriver({ bookingId, onDone }: { bookingId: string; onDone(): void }) {
  const { t } = useI18n();
  const [list, setList] = useState<DriverOption[] | null>(null);
  const [error, setError] = useState<unknown>(null);
  useEffect(() => {
    api<DriverOption[]>(`/api/carrier/bookings/${bookingId}/assign-options`)
      .then(setList)
      .catch(setError);
  }, [bookingId]);
  if (error) return <ErrorText error={error} />;
  if (!list) return <Spinner />;
  if (list.length === 0) return <p className="mt-3 text-sm text-ink-soft">{t('jobs.noDrivers')}</p>;
  const initials = (n: string) =>
    n
      .split(' ')
      .map((p) => p[0])
      .join('')
      .slice(0, 2)
      .toUpperCase();
  return (
    <div className="mt-3 divide-y divide-slate-100 rounded-xl border border-slate-200">
      {list.map((d) => {
        const blocking = d.problems.filter((p) => p.code !== 'driver_busy');
        return (
          <button
            key={d.id}
            disabled={blocking.length > 0}
            onClick={() =>
              post(`/api/carrier/bookings/${bookingId}/assign`, { driverId: d.id })
                .then(onDone)
                .catch(setError)
            }
            className="flex w-full items-center gap-3 px-3 py-2 text-left hover:bg-slate-50 disabled:opacity-50"
          >
            <span
              className={`grid h-9 w-9 shrink-0 place-items-center rounded-full text-sm font-bold ${d.assigned ? 'bg-ink text-white' : 'bg-slate-100'}`}
            >
              {d.assigned ? '✓' : initials(d.name)}
            </span>
            <span className="flex-1">
              <span className="block font-medium">{d.name}</span>
              <span className="block text-xs text-ink-soft">
                {blocking.length
                  ? blocking.map((p) => problemText(t, p)).join(' · ')
                  : d.problems.length
                    ? t('jobs.busy')
                    : t('jobs.available')}
              </span>
            </span>
            <span className="text-right text-xs text-ink-soft">
              {t('jobs.deadhead')}
              <span className="block font-semibold text-ink">{d.deadheadKm} km</span>
            </span>
          </button>
        );
      })}
    </div>
  );
}
