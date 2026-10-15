'use client';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useMemo, useRef, useState } from 'react';
import { parseMajor } from '@freight/shared';
import { AddressSearch, type Place } from '@/components/AddressSearch';
import { useRequireAuth } from '@/components/auth';
import { RouteMap } from '@/components/RouteMap';
import { Alert, Badge, Card, ErrorText, Field, Spinner } from '@/components/ui';
import { useI18n, type MessageKey } from '@/i18n';
import { api, post } from '@/lib/api';
import { km, money } from '@/lib/format';

type Level = 'standard' | 'priority' | 'express';
interface Line {
  quantity: number;
  kind: 'eur_pallet' | 'industrial_pallet' | 'package' | 'other';
  lengthCm: number;
  widthCm: number;
  heightCm: number;
  weightKg: number;
  stackable: boolean;
}
interface Quote {
  vehicleClass: string;
  distanceKm: number;
  durationMinutes: number;
  routeSource: string;
  totals: { weightKg: number; palletPlaces: number; loadingMetres: number };
  price: {
    currency: string;
    netMinor: number;
    vatMinor: number;
    totalMinor: number;
    taxBasis: string;
    indicative: boolean;
  };
  customs: {
    result: string;
    procedures: Array<{
      kind: string;
      territory: string | null;
      certainty: string;
      reason: string;
    }>;
    notes: string[];
  };
}

const PALLET_SIZES: Record<Line['kind'], [number, number]> = {
  eur_pallet: [120, 80],
  industrial_pallet: [120, 100],
  package: [60, 40],
  other: [120, 80],
};

function addDays(d: number) {
  const x = new Date();
  x.setDate(x.getDate() + d);
  return x.toISOString().slice(0, 10);
}
const toIso = (date: string, time: string) => new Date(`${date}T${time}`).toISOString();

function BookForm() {
  const { me, loading } = useRequireAuth('shipper');
  const { t, locale } = useI18n();
  const router = useRouter();

  const [from, setFrom] = useState<Place | null>(null);
  const [to, setTo] = useState<Place | null>(null);
  const [description, setDescription] = useState('');
  const [lines, setLines] = useState<Line[]>([
    {
      quantity: 4,
      kind: 'eur_pallet',
      lengthCm: 120,
      widthCm: 80,
      heightCm: 150,
      weightKg: 300,
      stackable: false,
    },
  ]);
  const [pickupDate, setPickupDate] = useState(addDays(2));
  const [pickupFrom, setPickupFrom] = useState('08:00');
  const [pickupTo, setPickupTo] = useState('16:00');
  const [deliveryDate, setDeliveryDate] = useState(addDays(4));
  const [deliveryFrom, setDeliveryFrom] = useState('08:00');
  const [deliveryTo, setDeliveryTo] = useState('17:00');
  const [level, setLevel] = useState<Level>('standard');
  const [maxText, setMaxText] = useState('');
  const [maxTouched, setMaxTouched] = useState(false);
  const [more, setMore] = useState(false);
  const [extra, setExtra] = useState({
    pickupContact: '',
    pickupPhone: '',
    pickupForklift: true,
    pickupDock: false,
    pickupNotes: '',
    deliveryContact: '',
    deliveryPhone: '',
    deliveryForklift: true,
    deliveryDock: false,
    deliveryNotes: '',
    tailLiftPickup: false,
    tailLiftDelivery: false,
    cold: false,
    minC: '2',
    maxC: '8',
    goodsStatus: 'unknown' as 'union' | 'non_union' | 'unknown',
    reference: '',
    declared: '',
    category: 'general',
  });
  const [quote, setQuote] = useState<Quote | null>(null);
  const [quoteError, setQuoteError] = useState<unknown>(null);
  const [quoting, setQuoting] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const seq = useRef(0);
  const params = useSearchParams();
  const [saved, setSaved] = useState<
    Array<
      Place & {
        id: string;
        contactName: string | null;
        contactPhone: string | null;
        hasForklift: boolean;
        hasLoadingDock: boolean;
        instructions: string | null;
      }
    >
  >([]);
  const [savePlaces, setSavePlaces] = useState(false);

  useEffect(() => {
    if (!me) return;
    api('/api/addresses')
      .then(setSaved)
      .catch(() => {});
    const repeat = params.get('repeat');
    if (!repeat) return;
    // Book again: same places, cargo, service and maximum; new dates
    api(`/api/shipments/${repeat}/template`)
      .then((tpl) => {
        const toPlace = (p: Record<string, unknown>) => ({
          ...(p as unknown as Place),
          source: 'saved',
        });
        setFrom(toPlace(tpl.pickup));
        setTo(toPlace(tpl.delivery));
        setDescription(tpl.cargo.description ?? '');
        setLines(tpl.cargo.lines);
        setLevel(tpl.serviceLevel);
        setPickupFrom(tpl.pickup.fromTime);
        setPickupTo(tpl.pickup.toTime);
        setDeliveryFrom(tpl.delivery.fromTime);
        setDeliveryTo(tpl.delivery.toTime);
        setMaxText(String(tpl.maxPriceMinor / 100));
        setMaxTouched(true);
        setExtra((e) => ({
          ...e,
          pickupContact: tpl.pickup.contactName ?? '',
          pickupPhone: tpl.pickup.contactPhone ?? '',
          pickupForklift: tpl.pickup.hasForklift,
          pickupDock: tpl.pickup.hasLoadingDock,
          pickupNotes: tpl.pickup.instructions ?? '',
          deliveryContact: tpl.delivery.contactName ?? '',
          deliveryPhone: tpl.delivery.contactPhone ?? '',
          deliveryForklift: tpl.delivery.hasForklift,
          deliveryDock: tpl.delivery.hasLoadingDock,
          deliveryNotes: tpl.delivery.instructions ?? '',
          reference: tpl.reference ?? '',
          goodsStatus: tpl.cargo.goodsStatus ?? 'unknown',
          category: tpl.cargo.category ?? 'general',
          tailLiftPickup: !!tpl.cargo.needsTailLiftPickup,
          tailLiftDelivery: !!tpl.cargo.needsTailLiftDelivery,
          cold: !!tpl.cargo.temperature,
          minC: String(tpl.cargo.temperature?.minC ?? 2),
          maxC: String(tpl.cargo.temperature?.maxC ?? 8),
        }));
      })
      .catch(() => {});
  }, [me, params]);

  const pickSaved = (which: 'from' | 'to', a: (typeof saved)[number]) => {
    const p: Place = {
      label: `${a.label}: ${a.addressLine}, ${a.postcode} ${a.city}, ${a.country}`,
      addressLine: a.addressLine,
      postcode: a.postcode,
      city: a.city,
      country: a.country,
      lat: a.lat,
      lng: a.lng,
      source: 'saved',
    };
    if (which === 'from') {
      setFrom(p);
      setExtra((e) => ({
        ...e,
        pickupContact: a.contactName ?? '',
        pickupPhone: a.contactPhone ?? '',
        pickupForklift: a.hasForklift,
        pickupDock: a.hasLoadingDock,
        pickupNotes: a.instructions ?? '',
      }));
    } else {
      setTo(p);
      setExtra((e) => ({
        ...e,
        deliveryContact: a.contactName ?? '',
        deliveryPhone: a.contactPhone ?? '',
        deliveryForklift: a.hasForklift,
        deliveryDock: a.hasLoadingDock,
        deliveryNotes: a.instructions ?? '',
      }));
    }
  };

  const quoteBody = useMemo(() => {
    if (!from || !to || lines.some((l) => !l.quantity || !l.weightKg)) return null;
    return {
      pickup: { country: from.country, postcode: from.postcode, lat: from.lat, lng: from.lng },
      delivery: { country: to.country, postcode: to.postcode, lat: to.lat, lng: to.lng },
      lines,
      serviceLevel: level,
      temperature: extra.cold ? { minC: Number(extra.minC), maxC: Number(extra.maxC) } : null,
      needsTailLiftPickup: extra.tailLiftPickup,
      needsTailLiftDelivery: extra.tailLiftDelivery,
      goodsStatus: extra.goodsStatus,
    };
  }, [
    from,
    to,
    lines,
    level,
    extra.cold,
    extra.minC,
    extra.maxC,
    extra.tailLiftPickup,
    extra.tailLiftDelivery,
    extra.goodsStatus,
  ]);

  // Live estimate, recalculated on the server whenever an input changes
  useEffect(() => {
    if (!quoteBody) return setQuote(null);
    const n = ++seq.current;
    setQuoting(true);
    const timer = setTimeout(() => {
      post<Quote>('/api/quotes', quoteBody)
        .then((q) => {
          if (n !== seq.current) return;
          setQuote(q);
          setQuoteError(null);
          if (!maxTouched) setMaxText(String(Math.ceil((q.price.totalMinor * 1.1) / 1000) * 10));
        })
        .catch((e) => n === seq.current && (setQuote(null), setQuoteError(e)))
        .finally(() => n === seq.current && setQuoting(false));
    }, 300);
    return () => clearTimeout(timer);
  }, [quoteBody, maxTouched]);

  const maxMinor = parseMajor(maxText);
  const belowEstimate = quote && maxMinor != null && maxMinor < quote.price.totalMinor;
  const canSubmit =
    !!quote && maxMinor != null && maxMinor > 0 && description.trim().length >= 2 && !busy;

  const submit = async () => {
    if (!from || !to || maxMinor == null) return;
    setBusy(true);
    setError(null);
    try {
      const res = await post<{ id: string; payment: { paymentRef: string } }>('/api/shipments', {
        pickup: {
          ...from,
          contactName: extra.pickupContact || null,
          contactPhone: extra.pickupPhone || null,
          windowStart: toIso(pickupDate, pickupFrom),
          windowEnd: toIso(pickupDate, pickupTo),
          hasForklift: extra.pickupForklift,
          hasLoadingDock: extra.pickupDock,
          instructions: extra.pickupNotes || null,
        },
        delivery: {
          ...to,
          contactName: extra.deliveryContact || null,
          contactPhone: extra.deliveryPhone || null,
          windowStart: toIso(deliveryDate, deliveryFrom),
          windowEnd: toIso(deliveryDate, deliveryTo),
          hasForklift: extra.deliveryForklift,
          hasLoadingDock: extra.deliveryDock,
          instructions: extra.deliveryNotes || null,
        },
        cargo: {
          description,
          category: extra.category,
          lines,
          declaredValueMinor: extra.declared ? parseMajor(extra.declared) : null,
          fragile: false,
          temperature: quoteBody?.temperature ?? null,
          dangerousGoods: false,
          needsTailLiftPickup: extra.tailLiftPickup,
          needsTailLiftDelivery: extra.tailLiftDelivery,
          goodsStatus: extra.goodsStatus,
          hsCode: null,
        },
        serviceLevel: level,
        maxPriceMinor: maxMinor,
        reference: extra.reference || null,
      });
      if (savePlaces)
        for (const [p, k] of [
          [from, 'pickup'],
          [to, 'delivery'],
        ] as const)
          await post('/api/addresses', {
            label: p.city,
            addressLine: p.addressLine,
            postcode: p.postcode,
            city: p.city,
            country: p.country,
            lat: p.lat,
            lng: p.lng,
            contactName: (k === 'pickup' ? extra.pickupContact : extra.deliveryContact) || null,
            contactPhone: (k === 'pickup' ? extra.pickupPhone : extra.deliveryPhone) || null,
            hasForklift: k === 'pickup' ? extra.pickupForklift : extra.deliveryForklift,
            hasLoadingDock: k === 'pickup' ? extra.pickupDock : extra.deliveryDock,
            instructions: (k === 'pickup' ? extra.pickupNotes : extra.deliveryNotes) || null,
          }).catch(() => {});
      router.push(`/pay/${res.payment.paymentRef}?shipment=${res.id}`);
    } catch (e) {
      setError(e);
      setBusy(false);
    }
  };

  if (loading || !me) return <Spinner />;
  const setLine = (i: number, patch: Partial<Line>) =>
    setLines(lines.map((l, j) => (j === i ? { ...l, ...patch } : l)));
  const x =
    (k: keyof typeof extra) =>
    (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) =>
      setExtra({
        ...extra,
        [k]: e.target.type === 'checkbox' ? (e.target as HTMLInputElement).checked : e.target.value,
      });

  return (
    <div className="grid gap-6 lg:grid-cols-[1fr_380px]">
      <div className="space-y-5">
        <h1 className="text-2xl font-bold tracking-tight">{t('book.title')}</h1>

        <Card className="space-y-4">
          <Field
            label={
              <span className="text-xs font-bold uppercase tracking-wider text-brand">
                {t('book.from')}
              </span>
            }
          >
            <AddressSearch
              id="from"
              value={from}
              onChange={setFrom}
              placeholder={t('book.searchAddress')}
            />
          </Field>
          <SavedChips list={saved} onPick={(x) => pickSaved('from', x)} />
          <Field
            label={
              <span className="text-xs font-bold uppercase tracking-wider text-emerald-700">
                {t('book.to')}
              </span>
            }
          >
            <AddressSearch
              id="to"
              value={to}
              onChange={setTo}
              placeholder={t('book.searchAddress')}
            />
          </Field>
          <SavedChips list={saved} onPick={(x) => pickSaved('to', x)} />
          {from && to && (from.source !== 'saved' || to.source !== 'saved') && (
            <label className="flex gap-2 text-sm text-ink-soft">
              <input
                type="checkbox"
                checked={savePlaces}
                onChange={(e) => setSavePlaces(e.target.checked)}
              />
              {t('book.savePlaces')}
            </label>
          )}
        </Card>

        <Card className="space-y-4">
          <div className="text-xs font-bold uppercase tracking-wider text-ink-soft">
            {t('book.what')}
          </div>
          <Field label={t('book.description')}>
            <input
              className="input"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder={t('book.descriptionPlaceholder')}
            />
          </Field>
          {lines.map((l, i) => (
            <div
              key={i}
              className="grid grid-cols-2 gap-3 rounded-xl bg-slate-50 p-3 sm:grid-cols-6"
            >
              <Field label={t('book.quantity')}>
                <input
                  className="input"
                  type="number"
                  min={1}
                  value={l.quantity}
                  onChange={(e) => setLine(i, { quantity: Number(e.target.value) })}
                />
              </Field>
              <div className="sm:col-span-2">
                <Field label={t('book.kind')}>
                  <select
                    className="input"
                    value={l.kind}
                    onChange={(e) => {
                      const kind = e.target.value as Line['kind'];
                      const [lengthCm, widthCm] = PALLET_SIZES[kind];
                      setLine(i, { kind, lengthCm, widthCm });
                    }}
                  >
                    {(['eur_pallet', 'industrial_pallet', 'package', 'other'] as const).map((k) => (
                      <option key={k} value={k}>
                        {t(`cargo.${k}` as MessageKey)}
                      </option>
                    ))}
                  </select>
                </Field>
              </div>
              <Field label={t('book.weightEach')}>
                <input
                  className="input"
                  type="number"
                  min={1}
                  value={l.weightKg}
                  onChange={(e) => setLine(i, { weightKg: Number(e.target.value) })}
                />
              </Field>
              <Field label={t('book.heightEach')}>
                <input
                  className="input"
                  type="number"
                  min={1}
                  value={l.heightCm}
                  onChange={(e) => setLine(i, { heightCm: Number(e.target.value) })}
                />
              </Field>
              {(l.kind === 'package' || l.kind === 'other') && (
                <Field label={t('book.lengthWidth')}>
                  <div className="flex gap-1">
                    <input
                      className="input"
                      type="number"
                      min={1}
                      value={l.lengthCm}
                      onChange={(e) => setLine(i, { lengthCm: Number(e.target.value) })}
                    />
                    <input
                      className="input"
                      type="number"
                      min={1}
                      value={l.widthCm}
                      onChange={(e) => setLine(i, { widthCm: Number(e.target.value) })}
                    />
                  </div>
                </Field>
              )}
              <label className="col-span-2 flex items-end gap-2 pb-3 text-sm sm:col-span-1">
                <input
                  type="checkbox"
                  checked={l.stackable}
                  onChange={(e) => setLine(i, { stackable: e.target.checked })}
                />
                {t('book.stackable')}
              </label>
              {lines.length > 1 && (
                <button
                  type="button"
                  className="btn-ghost col-span-2 text-sm sm:col-span-6 sm:justify-self-end"
                  onClick={() => setLines(lines.filter((_, j) => j !== i))}
                >
                  {t('common.remove')}
                </button>
              )}
            </div>
          ))}
          <button
            type="button"
            className="btn-ghost text-sm"
            onClick={() =>
              setLines([
                ...lines,
                {
                  quantity: 1,
                  kind: 'package',
                  lengthCm: 60,
                  widthCm: 40,
                  heightCm: 40,
                  weightKg: 20,
                  stackable: true,
                },
              ])
            }
          >
            + {t('book.addLine')}
          </button>
        </Card>

        <Card className="space-y-4">
          <div className="text-xs font-bold uppercase tracking-wider text-ink-soft">
            {t('book.when')}
          </div>
          <div className="grid gap-3 sm:grid-cols-3">
            <Field label={t('book.pickupDate')}>
              <input
                className="input"
                type="date"
                value={pickupDate}
                onChange={(e) => setPickupDate(e.target.value)}
              />
            </Field>
            <Field label={t('book.between')}>
              <input
                className="input"
                type="time"
                value={pickupFrom}
                onChange={(e) => setPickupFrom(e.target.value)}
              />
            </Field>
            <Field label={t('book.and')}>
              <input
                className="input"
                type="time"
                value={pickupTo}
                onChange={(e) => setPickupTo(e.target.value)}
              />
            </Field>
            <Field label={t('book.deliveryDate')}>
              <input
                className="input"
                type="date"
                value={deliveryDate}
                onChange={(e) => setDeliveryDate(e.target.value)}
              />
            </Field>
            <Field label={t('book.between')}>
              <input
                className="input"
                type="time"
                value={deliveryFrom}
                onChange={(e) => setDeliveryFrom(e.target.value)}
              />
            </Field>
            <Field label={t('book.and')}>
              <input
                className="input"
                type="time"
                value={deliveryTo}
                onChange={(e) => setDeliveryTo(e.target.value)}
              />
            </Field>
          </div>
        </Card>

        <Card className="space-y-3">
          <div className="text-xs font-bold uppercase tracking-wider text-ink-soft">
            {t('book.service')}
          </div>
          <div className="grid gap-3 sm:grid-cols-3" role="radiogroup">
            {(['standard', 'priority', 'express'] as const).map((l) => (
              <button
                key={l}
                type="button"
                role="radio"
                aria-checked={level === l}
                onClick={() => setLevel(l)}
                className={`rounded-xl border p-3 text-left ${level === l ? 'border-brand bg-brand-soft' : 'border-slate-200 bg-white hover:border-slate-300'}`}
              >
                <div className="font-semibold">{t(`level.${l}` as MessageKey)}</div>
                <div className="mt-0.5 text-xs text-ink-soft">
                  {t(`level.${l}.text` as MessageKey)}
                </div>
              </button>
            ))}
          </div>
          <p className="text-xs text-ink-faint">{t('book.noGuarantee')}</p>
        </Card>

        <div>
          <button
            type="button"
            className="btn-ghost text-sm"
            onClick={() => setMore(!more)}
            aria-expanded={more}
          >
            {more ? '−' : '+'} {t('book.moreDetails')}
          </button>
          {more && (
            <Card className="mt-2 space-y-4">
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label={t('book.pickupContact')}>
                  <input
                    className="input"
                    value={extra.pickupContact}
                    onChange={x('pickupContact')}
                  />
                </Field>
                <Field label={t('book.phone')}>
                  <input
                    className="input"
                    type="tel"
                    value={extra.pickupPhone}
                    onChange={x('pickupPhone')}
                  />
                </Field>
                <Field label={t('book.deliveryContact')}>
                  <input
                    className="input"
                    value={extra.deliveryContact}
                    onChange={x('deliveryContact')}
                  />
                </Field>
                <Field label={t('book.phone')}>
                  <input
                    className="input"
                    type="tel"
                    value={extra.deliveryPhone}
                    onChange={x('deliveryPhone')}
                  />
                </Field>
              </div>
              <div className="grid gap-2 text-sm sm:grid-cols-2">
                <label className="flex gap-2">
                  <input
                    type="checkbox"
                    checked={extra.pickupForklift}
                    onChange={x('pickupForklift')}
                  />
                  {t('book.forkliftPickup')}
                </label>
                <label className="flex gap-2">
                  <input
                    type="checkbox"
                    checked={extra.deliveryForklift}
                    onChange={x('deliveryForklift')}
                  />
                  {t('book.forkliftDelivery')}
                </label>
                <label className="flex gap-2">
                  <input
                    type="checkbox"
                    checked={extra.tailLiftPickup}
                    onChange={x('tailLiftPickup')}
                  />
                  {t('book.tailLiftPickup')}
                </label>
                <label className="flex gap-2">
                  <input
                    type="checkbox"
                    checked={extra.tailLiftDelivery}
                    onChange={x('tailLiftDelivery')}
                  />
                  {t('book.tailLiftDelivery')}
                </label>
                <label className="flex gap-2">
                  <input type="checkbox" checked={extra.cold} onChange={x('cold')} />
                  {t('book.temperature')}
                </label>
              </div>
              {extra.cold && (
                <div className="grid grid-cols-2 gap-3">
                  <Field label={t('book.minC')}>
                    <input
                      className="input"
                      type="number"
                      value={extra.minC}
                      onChange={x('minC')}
                    />
                  </Field>
                  <Field label={t('book.maxC')}>
                    <input
                      className="input"
                      type="number"
                      value={extra.maxC}
                      onChange={x('maxC')}
                    />
                  </Field>
                </div>
              )}
              <div className="grid gap-3 sm:grid-cols-3">
                <Field label={t('book.goodsStatus')} hint={t('book.goodsStatusHint')}>
                  <select className="input" value={extra.goodsStatus} onChange={x('goodsStatus')}>
                    <option value="unknown">{t('book.goodsStatus.unknown')}</option>
                    <option value="union">{t('book.goodsStatus.union')}</option>
                    <option value="non_union">{t('book.goodsStatus.non_union')}</option>
                  </select>
                </Field>
                <Field label={t('book.reference')}>
                  <input className="input" value={extra.reference} onChange={x('reference')} />
                </Field>
                <Field label={t('book.declaredValue')}>
                  <input
                    className="input"
                    inputMode="decimal"
                    value={extra.declared}
                    onChange={x('declared')}
                  />
                </Field>
              </div>
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label={t('book.pickupNotes')}>
                  <textarea
                    className="input"
                    rows={2}
                    value={extra.pickupNotes}
                    onChange={x('pickupNotes')}
                  />
                </Field>
                <Field label={t('book.deliveryNotes')}>
                  <textarea
                    className="input"
                    rows={2}
                    value={extra.deliveryNotes}
                    onChange={x('deliveryNotes')}
                  />
                </Field>
              </div>
              <Alert tone="gray">{t('book.dangerousNotOffered')}</Alert>
            </Card>
          )}
        </div>
      </div>

      <aside className="space-y-4 lg:sticky lg:top-20 lg:self-start">
        <RouteMap
          points={[
            ...(from ? [{ ...from, label: from.label, kind: 'pickup' as const }] : []),
            ...(to ? [{ ...to, label: to.label, kind: 'delivery' as const }] : []),
          ]}
          height={220}
        />
        <Card className="space-y-4">
          <div>
            <div className="text-xs font-bold uppercase tracking-wider text-ink-soft">
              {t('book.price')}
            </div>
            {!quoteBody && <p className="mt-1 text-sm text-ink-soft">{t('book.enterRoute')}</p>}
            {quoteBody && quoting && !quote && <Spinner />}
            {quoteError ? <ErrorText error={quoteError} /> : null}
            {quote && (
              <div className={quoting ? 'opacity-60' : ''}>
                <div className="mt-1 text-3xl font-extrabold">
                  {money(quote.price.totalMinor, quote.price.currency, locale)}
                </div>
                <div className="mt-1 text-xs text-ink-soft">
                  {quote.price.vatMinor > 0
                    ? t('book.inclVat', {
                        vat: money(quote.price.vatMinor, quote.price.currency, locale),
                      })
                    : t('book.reverseCharge')}
                </div>
                <div className="mt-2 flex flex-wrap gap-1.5">
                  <Badge>
                    {km(quote.distanceKm, locale)} ({t('book.estimated')})
                  </Badge>
                  <Badge>{t(`vehicle.${quote.vehicleClass}` as MessageKey)}</Badge>
                  <Badge>{t('book.palletPlaces', { n: quote.totals.palletPlaces })}</Badge>
                </div>
                {quote.price.indicative && (
                  <p className="mt-2 text-xs text-ink-faint">{t('book.indicative')}</p>
                )}
              </div>
            )}
          </div>
          {quote && quote.customs.result !== 'not_required' && (
            <Alert
              tone={quote.customs.result === 'required' ? 'amber' : 'gray'}
              title={t(`customs.${quote.customs.result}` as MessageKey)}
            >
              <ul className="list-disc pl-4">
                {quote.customs.procedures.map((p, i) => (
                  <li key={i}>{p.reason}</li>
                ))}
                {quote.customs.notes.map((n, i) => (
                  <li key={`n${i}`}>{n}</li>
                ))}
              </ul>
              <div className="mt-1 text-xs">{t('customs.arrangeAfter')}</div>
            </Alert>
          )}
          <Field
            label={
              <span className="text-xs font-bold uppercase tracking-wider text-ink-soft">
                {t('book.maximum')}
              </span>
            }
            hint={t('book.maximumHint')}
          >
            <div className="relative">
              <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-ink-soft">
                €
              </span>
              <input
                className="input pl-7 text-lg font-semibold"
                inputMode="decimal"
                value={maxText}
                onChange={(e) => (setMaxText(e.target.value), setMaxTouched(true))}
              />
            </div>
          </Field>
          {belowEstimate && <Alert tone="amber">{t('book.belowEstimate')}</Alert>}
          <ErrorText error={error} />
          <button
            className="btn-primary w-full py-3 text-base"
            disabled={!canSubmit}
            onClick={submit}
          >
            {t('book.request')}
          </button>
          <p className="text-xs text-ink-faint">{t('book.prepayNote')}</p>
        </Card>
      </aside>
    </div>
  );
}

function SavedChips<T extends { id: string; label: string; city: string }>({
  list,
  onPick,
}: {
  list: T[];
  onPick(a: T): void;
}) {
  const { t } = useI18n();
  if (list.length === 0) return null;
  return (
    <div className="-mt-2 flex flex-wrap items-center gap-1.5">
      <span className="text-xs text-ink-faint">{t('book.savedPlaces')}</span>
      {list.slice(0, 6).map((a) => (
        <button
          key={a.id}
          type="button"
          onClick={() => onPick(a)}
          className="rounded-full border border-slate-200 bg-white px-2.5 py-0.5 text-xs hover:border-brand"
        >
          {a.label === a.city ? a.city : `${a.label} · ${a.city}`}
        </button>
      ))}
    </div>
  );
}

export default function Book() {
  return (
    <Suspense>
      <BookForm />
    </Suspense>
  );
}
