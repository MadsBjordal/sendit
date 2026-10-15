'use client';
import { useEffect, useState } from 'react';
import { VEHICLE_CLASS_BY_ID, type VehicleClass } from '@freight/shared';
import { AddressSearch, type Place } from '@/components/AddressSearch';
import { useRequireAuth } from '@/components/auth';
import { Badge, Card, Empty, ErrorText, Field, PageTitle, Spinner } from '@/components/ui';
import { useI18n, type MessageKey } from '@/i18n';
import { api, post } from '@/lib/api';

interface Vehicle {
  id: string;
  registration: string;
  registrationCountry: string;
  vehicleClass: VehicleClass;
  payloadKg: number;
  palletPlaces: number;
  lengthCm: number;
  widthCm: number;
  heightCm: number;
  equipment: string[];
  tempMinC: number | null;
  tempMaxC: number | null;
  available: boolean;
  baseLat: number;
  baseLng: number;
}
const CLASSES: VehicleClass[] = [
  'van_light',
  'van_large',
  'box_truck',
  'rigid_truck',
  'curtainsider',
  'articulated',
  'refrigerated',
];

export default function Fleet() {
  const { me } = useRequireAuth('carrier');
  const { t } = useI18n();
  const [vehicles, setVehicles] = useState<Vehicle[] | null>(null);
  const [countries, setCountries] = useState<
    Array<{ code: string; name: string; enabled: boolean }>
  >([]);
  const [operating, setOperating] = useState<string[]>([]);
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const load = () => {
    api<Vehicle[]>('/api/carrier/vehicles').then(setVehicles).catch(setError);
    api('/api/carrier/profile')
      .then((p) => setOperating(p.operatingCountries))
      .catch(() => {});
  };
  useEffect(() => {
    if (!me) return;
    load();
    api('/api/countries')
      .then(setCountries)
      .catch(() => {});
  }, [me]);
  if (!me) return <Spinner />;

  const toggleCountry = async (code: string) => {
    const next = operating.includes(code)
      ? operating.filter((c) => c !== code)
      : [...operating, code];
    setOperating(next);
    await api('/api/carrier/operating-countries', {
      method: 'PUT',
      body: { countries: next },
    }).catch(setError);
  };
  const setAvailable = async (v: Vehicle, available: boolean) => {
    const { id: _id, ...rest } = v;
    await api(`/api/carrier/vehicles/${v.id}`, {
      method: 'PUT',
      body: { ...rest, tempMinC: v.tempMinC, tempMaxC: v.tempMaxC, available },
    }).catch(setError);
    load();
  };

  return (
    <div className="space-y-6">
      <PageTitle
        title={t('nav.fleet')}
        actions={
          <button className="btn-primary" onClick={() => setAdding(true)}>
            + {t('fleet.add')}
          </button>
        }
      />
      <ErrorText error={error} />
      {adding && (
        <VehicleForm onDone={() => (setAdding(false), load())} onCancel={() => setAdding(false)} />
      )}
      {!vehicles && <Spinner />}
      {vehicles?.length === 0 && !adding && (
        <Empty title={t('fleet.empty')}>{t('fleet.emptyText')}</Empty>
      )}
      <div className="grid gap-3 md:grid-cols-2">
        {vehicles?.map((v) => (
          <Card key={v.id}>
            <div className="flex items-start justify-between">
              <div>
                <div className="font-mono text-lg font-semibold">{v.registration}</div>
                <div className="text-sm text-ink-soft">
                  {t(`vehicle.${v.vehicleClass}` as MessageKey)} · {v.registrationCountry}
                </div>
              </div>
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={v.available}
                  onChange={(e) => setAvailable(v, e.target.checked)}
                />
                {t('fleet.available')}
              </label>
            </div>
            <div className="mt-3 flex flex-wrap gap-1.5">
              <Badge>{v.payloadKg} kg</Badge>
              <Badge>{t('book.palletPlaces', { n: v.palletPlaces })}</Badge>
              <Badge>
                {v.lengthCm}×{v.widthCm}×{v.heightCm} cm
              </Badge>
              {v.equipment.map((e) => (
                <Badge key={e} tone="blue">
                  {t(`equipment.${e}` as MessageKey)}
                </Badge>
              ))}
            </div>
          </Card>
        ))}
      </div>
      <Card>
        <div className="mb-1 font-semibold">{t('fleet.countries')}</div>
        <p className="mb-3 text-sm text-ink-soft">{t('fleet.countriesText')}</p>
        <div className="flex flex-wrap gap-2">
          {countries
            .filter((c) => c.enabled)
            .map((c) => (
              <button
                key={c.code}
                onClick={() => toggleCountry(c.code)}
                className={`rounded-full border px-3 py-1 text-sm ${operating.includes(c.code) ? 'border-brand bg-brand-soft font-semibold text-brand-dark' : 'border-slate-200'}`}
              >
                {c.name}
              </button>
            ))}
        </div>
      </Card>
    </div>
  );
}

function VehicleForm({ onDone, onCancel }: { onDone(): void; onCancel(): void }) {
  const { t } = useI18n();
  const [cls, setCls] = useState<VehicleClass>('curtainsider');
  const d = VEHICLE_CLASS_BY_ID.get(cls)!;
  const [f, setF] = useState({
    registration: '',
    registrationCountry: 'DE',
    payloadKg: d.payloadKg,
    palletPlaces: d.palletPlaces,
    lengthCm: d.lengthCm,
    widthCm: d.widthCm,
    heightCm: d.heightCm,
    tailLift: false,
    tempMinC: -20,
    tempMaxC: 20,
  });
  const [base, setBase] = useState<Place | null>(null);
  const [error, setError] = useState<unknown>(null);
  const choose = (c: VehicleClass) => {
    const x = VEHICLE_CLASS_BY_ID.get(c)!;
    setCls(c);
    setF({
      ...f,
      payloadKg: x.payloadKg,
      palletPlaces: x.palletPlaces,
      lengthCm: x.lengthCm,
      widthCm: x.widthCm,
      heightCm: x.heightCm,
      tailLift: x.equipment.includes('tail_lift'),
    });
  };
  const num = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setF({ ...f, [k]: Number(e.target.value) });
  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!base) return;
    const equipment = [
      ...(f.tailLift ? ['tail_lift'] : []),
      ...(cls === 'refrigerated' ? ['refrigeration'] : []),
    ];
    try {
      await post('/api/carrier/vehicles', {
        registration: f.registration,
        registrationCountry: f.registrationCountry,
        vehicleClass: cls,
        payloadKg: f.payloadKg,
        palletPlaces: f.palletPlaces,
        lengthCm: f.lengthCm,
        widthCm: f.widthCm,
        heightCm: f.heightCm,
        equipment,
        tempMinC: cls === 'refrigerated' ? f.tempMinC : null,
        tempMaxC: cls === 'refrigerated' ? f.tempMaxC : null,
        baseLat: base.lat,
        baseLng: base.lng,
        available: true,
      });
      onDone();
    } catch (err) {
      setError(err);
    }
  };
  return (
    <Card>
      <form className="space-y-4" onSubmit={save}>
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label={t('fleet.registration')}>
            <input
              className="input font-mono uppercase"
              required
              value={f.registration}
              onChange={(e) => setF({ ...f, registration: e.target.value })}
            />
          </Field>
          <Field label={t('fleet.regCountry')}>
            <input
              className="input uppercase"
              required
              maxLength={2}
              value={f.registrationCountry}
              onChange={(e) => setF({ ...f, registrationCountry: e.target.value.toUpperCase() })}
            />
          </Field>
          <Field label={t('fleet.type')}>
            <select
              className="input"
              value={cls}
              onChange={(e) => choose(e.target.value as VehicleClass)}
            >
              {CLASSES.map((c) => (
                <option key={c} value={c}>
                  {t(`vehicle.${c}` as MessageKey)}
                </option>
              ))}
            </select>
          </Field>
        </div>
        <p className="text-xs text-ink-soft">{t('fleet.realNumbers')}</p>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
          <Field label={t('fleet.payload')}>
            <input
              className="input"
              type="number"
              value={f.payloadKg}
              onChange={num('payloadKg')}
            />
          </Field>
          <Field label={t('fleet.pallets')}>
            <input
              className="input"
              type="number"
              value={f.palletPlaces}
              onChange={num('palletPlaces')}
            />
          </Field>
          <Field label={t('fleet.length')}>
            <input className="input" type="number" value={f.lengthCm} onChange={num('lengthCm')} />
          </Field>
          <Field label={t('fleet.width')}>
            <input className="input" type="number" value={f.widthCm} onChange={num('widthCm')} />
          </Field>
          <Field label={t('fleet.height')}>
            <input className="input" type="number" value={f.heightCm} onChange={num('heightCm')} />
          </Field>
        </div>
        <label className="flex gap-2 text-sm">
          <input
            type="checkbox"
            checked={f.tailLift}
            onChange={(e) => setF({ ...f, tailLift: e.target.checked })}
          />
          {t('equipment.tail_lift')}
        </label>
        {cls === 'refrigerated' && (
          <div className="grid grid-cols-2 gap-3">
            <Field label={t('book.minC')}>
              <input
                className="input"
                type="number"
                value={f.tempMinC}
                onChange={num('tempMinC')}
              />
            </Field>
            <Field label={t('book.maxC')}>
              <input
                className="input"
                type="number"
                value={f.tempMaxC}
                onChange={num('tempMaxC')}
              />
            </Field>
          </div>
        )}
        <Field label={t('fleet.base')} hint={t('fleet.baseHint')}>
          <AddressSearch
            id="base"
            value={base}
            onChange={setBase}
            placeholder={t('book.searchAddress')}
          />
        </Field>
        <ErrorText error={error} />
        <div className="flex gap-2">
          <button type="button" className="btn-secondary" onClick={onCancel}>
            {t('common.cancel')}
          </button>
          <button className="btn-primary" disabled={!base}>
            {t('common.save')}
          </button>
        </div>
      </form>
    </Card>
  );
}
