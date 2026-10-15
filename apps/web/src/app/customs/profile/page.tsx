'use client';
import { useEffect, useState } from 'react';
import { useRequireAuth } from '@/components/auth';
import { Alert, Card, ErrorText, Field, PageTitle, Spinner } from '@/components/ui';
import { useI18n, type MessageKey } from '@/i18n';
import { api } from '@/lib/api';

const SERVICES = [
  'export_declaration',
  'import_declaration',
  'transit_declaration',
  'safety_security_filing',
  'gvms_reference',
  'fiscal_formalities',
  'classification',
  'origin_documents',
  'consultation',
];

export default function CustomsProfile() {
  const { me } = useRequireAuth('customs_provider');
  const { t } = useI18n();
  const [countries, setCountries] = useState<
    Array<{ code: string; name: string; enabled: boolean }>
  >([]);
  const [p, setP] = useState({
    countries: [] as string[],
    services: [] as string[],
    prices: {} as Record<string, string>,
    workingHours: '',
    dailyCapacity: '20',
    contactPhone: '',
    contactEmail: '',
    active: true,
  });
  const [loaded, setLoaded] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<unknown>(null);
  useEffect(() => {
    if (!me) return;
    api('/api/countries')
      .then(setCountries)
      .catch(() => {});
    api('/api/customs-provider/profile')
      .then((x) => {
        if (x)
          setP({
            countries: x.countries,
            services: x.services,
            prices: Object.fromEntries(
              Object.entries(x.prices as Record<string, number>).map(([k, v]) => [
                k,
                String(v / 100),
              ]),
            ),
            workingHours: x.workingHours ?? '',
            dailyCapacity: String(x.dailyCapacity),
            contactPhone: x.contactPhone ?? '',
            contactEmail: x.contactEmail ?? '',
            active: x.active,
          });
        setLoaded(true);
      })
      .catch(setError);
  }, [me]);
  if (!me || !loaded) return <Spinner />;
  const toggle = (list: string[], v: string) =>
    list.includes(v) ? list.filter((x) => x !== v) : [...list, v];
  const save = async () => {
    try {
      await api('/api/customs-provider/profile', {
        method: 'PUT',
        body: {
          countries: p.countries,
          services: p.services,
          prices: Object.fromEntries(
            Object.entries(p.prices)
              .filter(([, v]) => v)
              .map(([k, v]) => [k, Math.round(Number(v.replace(',', '.')) * 100)]),
          ),
          workingHours: p.workingHours || null,
          dailyCapacity: Number(p.dailyCapacity) || 20,
          contactPhone: p.contactPhone || null,
          contactEmail: p.contactEmail || null,
          active: p.active,
        },
      });
      setSaved(true);
    } catch (e) {
      setError(e);
    }
  };
  return (
    <div className="max-w-3xl space-y-5">
      <PageTitle title={t('nav.customsProfile')} subtitle={t('customsProfile.subtitle')} />
      <Card>
        <div className="mb-2 font-semibold">{t('customsProfile.countries')}</div>
        <div className="flex flex-wrap gap-2">
          {countries.map((c) => (
            <button
              key={c.code}
              onClick={() => setP({ ...p, countries: toggle(p.countries, c.code) })}
              className={`rounded-full border px-3 py-1 text-sm ${p.countries.includes(c.code) ? 'border-brand bg-brand-soft font-semibold text-brand-dark' : 'border-slate-200'}`}
            >
              {c.name}
            </button>
          ))}
        </div>
      </Card>
      <Card>
        <div className="mb-2 font-semibold">{t('customsProfile.services')}</div>
        <div className="space-y-2">
          {SERVICES.map((s) => (
            <div key={s} className="flex flex-wrap items-center gap-3">
              <label className="flex flex-1 items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={p.services.includes(s)}
                  onChange={() => setP({ ...p, services: toggle(p.services, s) })}
                />
                {t(`service.${s}` as MessageKey)}
              </label>
              {p.services.includes(s) && (
                <input
                  className="input w-32 py-1.5"
                  inputMode="decimal"
                  placeholder={t('customsProfile.price')}
                  value={p.prices[s] ?? ''}
                  onChange={(e) => setP({ ...p, prices: { ...p.prices, [s]: e.target.value } })}
                />
              )}
            </div>
          ))}
        </div>
      </Card>
      <Card className="grid gap-3 sm:grid-cols-2">
        <Field label={t('customsProfile.hours')}>
          <input
            className="input"
            value={p.workingHours}
            onChange={(e) => setP({ ...p, workingHours: e.target.value })}
            placeholder="Mon–Fri 07:00–19:00"
          />
        </Field>
        <Field label={t('customsProfile.capacity')}>
          <input
            className="input"
            inputMode="numeric"
            value={p.dailyCapacity}
            onChange={(e) => setP({ ...p, dailyCapacity: e.target.value })}
          />
        </Field>
        <Field label={t('customsProfile.phone')} hint={t('customsProfile.phoneHint')}>
          <input
            className="input"
            type="tel"
            value={p.contactPhone}
            onChange={(e) => setP({ ...p, contactPhone: e.target.value })}
          />
        </Field>
        <Field label={t('auth.email')}>
          <input
            className="input"
            type="email"
            value={p.contactEmail}
            onChange={(e) => setP({ ...p, contactEmail: e.target.value })}
          />
        </Field>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={p.active}
            onChange={(e) => setP({ ...p, active: e.target.checked })}
          />
          {t('customsProfile.active')}
        </label>
      </Card>
      <ErrorText error={error} />
      {saved && <Alert tone="green" title={t('settings.saved')} />}
      <button className="btn-primary" onClick={save}>
        {t('common.save')}
      </button>
    </div>
  );
}
