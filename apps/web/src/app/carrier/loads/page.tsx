'use client';
import Link from 'next/link';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { parseMajor } from '@freight/shared';
import { useRequireAuth } from '@/components/auth';
import { RouteMap } from '@/components/RouteMap';
import { Alert, Badge, Empty, ErrorText, problemText, Spinner } from '@/components/ui';
import { useI18n, type MessageKey } from '@/i18n';
import { api, post } from '@/lib/api';
import { dateTime, km, money } from '@/lib/format';

interface Stop {
  city: string;
  postcode: string;
  country: string;
  lat: number;
  lng: number;
  windowStart: string;
  windowEnd: string;
}
interface Load {
  id: string;
  number: string;
  serviceLevel: string;
  from: Stop;
  to: Stop;
  cargo: {
    description: string;
    weightKg: number;
    palletPlaces: number;
    loadingMetres: number;
    temperature: unknown;
  };
  distanceKm: number;
  customs: string;
  payoutMinor: number;
  currency: string;
  guaranteed: boolean;
  vehicles: Array<{
    id: string;
    registration: string;
    vehicleClass: string;
    cabotageConfirmationNeeded: boolean;
    distanceToPickupKm: number;
  }>;
  myOffer: { status: string; payoutMinor: number; expiresAt: string } | null;
  searchExpiresAt: string;
}
interface Board {
  loads: Load[];
  canAccept: boolean;
  problems: Array<{ code: string }>;
}

type Sort = 'nearest' | 'payout' | 'perKm' | 'soonest';

export default function Loads() {
  const { me } = useRequireAuth('carrier');
  const { t, locale } = useI18n();
  const [board, setBoard] = useState<Board | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [radius, setRadius] = useState(0);
  const [level, setLevel] = useState('');
  const [sort, setSort] = useState<Sort>('nearest');
  const [open, setOpen] = useState<string | null>(null);
  // Opened from a return-load suggestion: /carrier/loads?load=<id>
  useEffect(() => {
    const id = new URLSearchParams(window.location.search).get('load');
    if (id) setOpen(id);
  }, []);

  const load = useCallback(
    () => api<Board>('/api/carrier/loads').then(setBoard).catch(setError),
    [],
  );
  useEffect(() => {
    if (!me) return;
    load();
    const timer = setInterval(load, 10_000);
    return () => clearInterval(timer);
  }, [me, load]);

  const shown = useMemo(() => {
    if (!board) return [];
    const perKm = (l: Load) =>
      l.payoutMinor / Math.max(1, l.distanceKm + l.vehicles[0]!.distanceToPickupKm);
    return board.loads
      .filter((l) => !radius || l.vehicles[0]!.distanceToPickupKm <= radius)
      .filter((l) => !level || l.serviceLevel === level)
      .sort((a, b) =>
        sort === 'payout'
          ? b.payoutMinor - a.payoutMinor
          : sort === 'perKm'
            ? perKm(b) - perKm(a)
            : sort === 'soonest'
              ? a.from.windowStart.localeCompare(b.from.windowStart)
              : a.vehicles[0]!.distanceToPickupKm - b.vehicles[0]!.distanceToPickupKm,
      );
  }, [board, radius, level, sort]);

  if (!me) return <Spinner />;
  const selected =
    shown.find((l) => l.id === open) ?? board?.loads.find((l) => l.id === open) ?? null;

  return (
    <div>
      <h1 className="mb-4 text-2xl font-bold tracking-tight">{t('loads.title')}</h1>
      {board && !board.canAccept && (
        <div className="mb-4">
          <Alert tone="amber" title={t('loads.cannotAccept')}>
            <ul className="list-disc pl-5">
              {board.problems.map((p, i) => (
                <li key={i}>{problemText(t, p)}</li>
              ))}
              {me.org?.status !== 'verified' && <li>{t('problem.carrier_not_verified')}</li>}
            </ul>
            <Link
              href="/carrier/verification"
              className="mt-1 inline-block font-semibold underline"
            >
              {t('nav.verification')}
            </Link>
          </Alert>
        </div>
      )}
      <div className="mb-4 flex flex-wrap gap-2">
        <select
          className="input w-auto py-1.5 text-sm"
          value={radius}
          onChange={(e) => setRadius(Number(e.target.value))}
          aria-label={t('loads.nearYou')}
        >
          <option value={0}>{t('loads.anywhere')}</option>
          {[50, 100, 200, 400].map((r) => (
            <option key={r} value={r}>
              {t('loads.within', { km: r })}
            </option>
          ))}
        </select>
        <select
          className="input w-auto py-1.5 text-sm"
          value={level}
          onChange={(e) => setLevel(e.target.value)}
          aria-label={t('book.service')}
        >
          <option value="">{t('loads.allLevels')}</option>
          {['standard', 'priority', 'express'].map((l) => (
            <option key={l} value={l}>
              {t(`level.${l}` as MessageKey)}
            </option>
          ))}
        </select>
        <select
          className="input w-auto py-1.5 text-sm"
          value={sort}
          onChange={(e) => setSort(e.target.value as Sort)}
          aria-label={t('loads.sort')}
        >
          {(['nearest', 'payout', 'perKm', 'soonest'] as const).map((s) => (
            <option key={s} value={s}>
              {t(`loads.sort.${s}` as MessageKey)}
            </option>
          ))}
        </select>
        <span className="self-center text-sm text-ink-soft">
          {t('loads.count', { n: shown.length })}
        </span>
      </div>
      <ErrorText error={error} />
      {!board && !error && <Spinner />}
      {board && shown.length === 0 && (
        <Empty title={t('loads.empty')}>{t('loads.emptyText')}</Empty>
      )}
      <div className="grid gap-3 md:grid-cols-2">
        {shown.map((l) => (
          <button
            key={l.id}
            onClick={() => setOpen(l.id)}
            className="card text-left transition hover:border-brand/50"
          >
            <div className="flex items-start justify-between gap-3">
              <div>
                <div className="text-2xl font-extrabold">
                  {money(l.payoutMinor, l.currency, locale)}
                </div>
                <div className="text-xs text-ink-soft">
                  {money(Math.round(l.payoutMinor / Math.max(1, l.distanceKm)), l.currency, locale)}
                  /km · {km(l.distanceKm, locale)}
                </div>
              </div>
              <div className="flex flex-col items-end gap-1">
                {l.guaranteed && <Badge tone="green">{t('loads.guaranteed')}</Badge>}
                {l.serviceLevel !== 'standard' && (
                  <Badge tone={l.serviceLevel === 'express' ? 'red' : 'amber'}>
                    {t(`level.${l.serviceLevel}` as MessageKey)}
                  </Badge>
                )}
                {l.myOffer && <Badge tone="blue">{t('loads.yourOffer')}</Badge>}
              </div>
            </div>
            <Timeline load={l} />
            <div className="mt-3 flex flex-wrap gap-1.5 text-xs">
              <Badge>{l.cargo.weightKg} kg</Badge>
              <Badge>{t('book.palletPlaces', { n: l.cargo.palletPlaces })}</Badge>
              {l.customs !== 'not_required' && (
                <Badge tone="amber">{t(`customs.${l.customs}` as MessageKey)}</Badge>
              )}
              <Badge>{t('loads.deadhead', { km: l.vehicles[0]!.distanceToPickupKm })}</Badge>
            </div>
          </button>
        ))}
      </div>
      {selected && (
        <LoadSheet
          load={selected}
          canAccept={!!board?.canAccept}
          onClose={() => setOpen(null)}
          onDone={load}
        />
      )}
    </div>
  );
}

function Timeline({ load }: { load: Load }) {
  const { locale } = useI18n();
  return (
    <ol className="mt-4 space-y-3">
      {[load.from, load.to].map((s, i) => (
        <li key={i} className="relative flex gap-3 pl-5">
          <span
            className={`absolute left-0 top-1.5 h-2.5 w-2.5 rounded-full ${i === 0 ? 'bg-brand' : 'border-2 border-ink bg-white'}`}
          />
          {i === 0 && (
            <span className="absolute left-[4px] top-4 h-[calc(100%+4px)] w-px bg-slate-300" />
          )}
          <div>
            <div className="font-semibold">
              {s.city}, {s.country} <span className="font-normal text-ink-faint">{s.postcode}</span>
            </div>
            <div className="text-xs text-ink-soft">{dateTime(s.windowStart, locale)}</div>
          </div>
        </li>
      ))}
    </ol>
  );
}

/** Load details as a sheet: map, schedule, cargo, then accept (or ask a different payout). */
function LoadSheet({
  load,
  canAccept,
  onClose,
  onDone,
}: {
  load: Load;
  canAccept: boolean;
  onClose(): void;
  onDone(): void;
}) {
  const { t, locale } = useI18n();
  const [vehicleId, setVehicleId] = useState(load.vehicles[0]!.id);
  const [cabotage, setCabotage] = useState(false);
  const [ask, setAsk] = useState(false);
  const [askText, setAskText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [result, setResult] = useState<{ result: string; [k: string]: unknown } | null>(null);
  const [idemKey] = useState(() => crypto.randomUUID());
  const vehicle = load.vehicles.find((v) => v.id === vehicleId)!;
  const m = (n: number) => money(n, load.currency, locale);

  const accept = async (payoutMinor?: number) => {
    setBusy(true);
    setError(null);
    try {
      const r = await post<{ result: string }>(`/api/carrier/loads/${load.id}/accept`, {
        vehicleId,
        idempotencyKey: `${idemKey}-${payoutMinor ?? 'listed'}`,
        cabotageConfirmed: cabotage,
        ...(payoutMinor ? { payoutMinor } : {}),
      });
      setResult(r);
      onDone();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-[1200] flex items-end justify-center bg-slate-900/40 sm:items-center"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        className="max-h-[92vh] w-full max-w-xl overflow-auto rounded-t-3xl bg-white p-5 shadow-xl sm:rounded-3xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-3 flex items-center justify-between">
          <div className="font-semibold">{t('loads.details')}</div>
          <button className="btn-ghost px-2 py-1" onClick={onClose} aria-label={t('common.close')}>
            ✕
          </button>
        </div>
        <RouteMap
          height={200}
          points={[
            { lat: load.from.lat, lng: load.from.lng, label: load.from.city, kind: 'pickup' },
            { lat: load.to.lat, lng: load.to.lng, label: load.to.city, kind: 'delivery' },
          ]}
        />
        <div className="mt-4 flex items-end justify-between">
          <div>
            <div className="text-3xl font-extrabold">{m(load.payoutMinor)}</div>
            <div className="text-xs text-ink-soft">{t('loads.payoutNote')}</div>
          </div>
          <div className="text-right text-sm text-ink-soft">
            {km(load.distanceKm, locale)} ({t('book.estimated')})
          </div>
        </div>
        <div className="mt-4">
          <div className="text-xs font-bold uppercase tracking-wider text-ink-soft">
            {t('loads.schedule')}
          </div>
          <Timeline load={load} />
          <div className="mt-2 text-xs text-ink-faint">
            {t('loads.windows', {
              a: dateTime(load.from.windowEnd, locale),
              b: dateTime(load.to.windowEnd, locale),
            })}
          </div>
        </div>
        <div className="mt-4 rounded-xl bg-slate-50 p-3 text-sm">
          <div className="font-medium">{load.cargo.description}</div>
          <div className="text-ink-soft">
            {load.cargo.weightKg} kg · {t('book.palletPlaces', { n: load.cargo.palletPlaces })} ·{' '}
            {load.cargo.loadingMetres} ldm
          </div>
          {load.customs !== 'not_required' && (
            <div className="mt-1 text-amber-800">{t(`customs.${load.customs}` as MessageKey)}</div>
          )}
          <div className="mt-1 text-xs text-ink-faint">{t('loads.addressAfter')}</div>
        </div>

        {result ? (
          <div className="mt-4 space-y-3">
            {result.result === 'booked' && (
              <Alert tone="green" title={t('loads.booked')}>
                {t('loads.bookedText', { amount: m(Number(result.payoutMinor)) })}
                <div className="mt-1 text-xs">
                  {String((result.guarantee as { terms: string }).terms)}
                </div>
              </Alert>
            )}
            {result.result === 'offer_pending' && (
              <Alert tone="blue" title={t('loads.offerSent')}>
                {t('loads.offerSentText', { at: dateTime(String(result.expiresAt), locale) })}
              </Alert>
            )}
            {result.result === 'already_assigned' && <Alert tone="gray" title={t('loads.taken')} />}
            {result.result === 'not_eligible' && (
              <Alert tone="red" title={t('loads.notEligible')}>
                <ul className="list-disc pl-5">
                  {(result.problems as Array<{ code: string }>).map((p, i) => (
                    <li key={i}>{problemText(t, p)}</li>
                  ))}
                </ul>
              </Alert>
            )}
            {result.result === 'not_available' && (
              <Alert tone="gray" title={t('loads.notAvailable')} />
            )}
            <button className="btn-secondary w-full" onClick={onClose}>
              {t('common.close')}
            </button>
          </div>
        ) : (
          <div className="mt-4 space-y-3">
            <label className="block">
              <span className="label">{t('loads.vehicle')}</span>
              <select
                className="input"
                value={vehicleId}
                onChange={(e) => setVehicleId(e.target.value)}
              >
                {load.vehicles.map((v) => (
                  <option key={v.id} value={v.id}>
                    {v.registration} · {t(`vehicle.${v.vehicleClass}` as MessageKey)} ·{' '}
                    {t('loads.deadhead', { km: v.distanceToPickupKm })}
                  </option>
                ))}
              </select>
            </label>
            {vehicle.cabotageConfirmationNeeded && (
              <label className="flex gap-2 rounded-xl border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
                <input
                  type="checkbox"
                  checked={cabotage}
                  onChange={(e) => setCabotage(e.target.checked)}
                />
                {t('loads.cabotageConfirm')}
              </label>
            )}
            <ErrorText error={error} />
            {!ask ? (
              <>
                <button
                  className="btn-primary w-full py-3 text-base"
                  disabled={busy || !canAccept}
                  onClick={() => accept()}
                >
                  {t('loads.accept', { amount: m(load.payoutMinor) })}
                </button>
                <button
                  className="btn-ghost w-full text-sm"
                  disabled={!canAccept}
                  onClick={() => setAsk(true)}
                >
                  {t('loads.askDifferent')}
                </button>
              </>
            ) : (
              <div className="space-y-2 rounded-xl border border-slate-200 p-3">
                <div className="font-semibold">{t('loads.askTitle')}</div>
                <div className="relative">
                  <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-ink-soft">
                    €
                  </span>
                  <input
                    className="input pl-7 text-lg"
                    inputMode="decimal"
                    autoFocus
                    value={askText}
                    onChange={(e) => setAskText(e.target.value)}
                  />
                </div>
                <p className="text-xs text-ink-soft">{t('loads.askNote')}</p>
                <div className="flex gap-2">
                  <button className="btn-secondary flex-1" onClick={() => setAsk(false)}>
                    {t('common.cancel')}
                  </button>
                  <button
                    className="btn-primary flex-1"
                    disabled={busy || !parseMajor(askText)}
                    onClick={() => accept(parseMajor(askText)!)}
                  >
                    {t('loads.askSubmit')}
                  </button>
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
