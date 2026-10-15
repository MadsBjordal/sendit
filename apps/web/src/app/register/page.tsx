'use client';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useState } from 'react';
import { useAuth } from '@/components/auth';
import { Card, ErrorText, Field } from '@/components/ui';
import { useI18n } from '@/i18n';
import { api, post } from '@/lib/api';

function RegisterForm() {
  const { t, locale } = useI18n();
  const { refresh } = useAuth();
  const router = useRouter();
  const params = useSearchParams();
  const [kind, setKind] = useState<'shipper' | 'carrier' | 'customs_provider'>(
    (params.get('kind') as 'carrier') ?? 'shipper',
  );
  const [countries, setCountries] = useState<Array<{ code: string; name: string }>>([]);
  const [f, setF] = useState({
    company: '',
    country: 'DE',
    vat: '',
    name: '',
    email: '',
    password: '',
  });
  const [accept, setAccept] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    api('/api/countries')
      .then(setCountries)
      .catch(() => {});
  }, []);
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
    setF({ ...f, [k]: e.target.value });

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await post('/api/auth/register', {
        organisation: { name: f.company, kind, country: f.country, vatNumber: f.vat || null },
        user: { name: f.name, email: f.email, password: f.password, locale },
      });
      await refresh();
      router.push(
        kind === 'carrier' ? '/carrier/verification' : kind === 'shipper' ? '/book' : '/team',
      );
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mx-auto max-w-xl">
      <h1 className="mb-6 text-2xl font-bold">{t('auth.register')}</h1>
      <div className="mb-4 grid grid-cols-3 gap-2" role="radiogroup">
        {(['shipper', 'carrier', 'customs_provider'] as const).map((k) => (
          <button
            key={k}
            type="button"
            role="radio"
            aria-checked={kind === k}
            onClick={() => setKind(k)}
            className={`rounded-xl border px-3 py-3 text-left text-sm ${kind === k ? 'border-brand bg-brand-soft' : 'border-slate-200 bg-white'}`}
          >
            <div className="font-semibold">{t(`register.kind.${k}` as never)}</div>
            <div className="text-xs text-ink-soft">{t(`register.kind.${k}.text` as never)}</div>
          </button>
        ))}
      </div>
      <Card>
        <form onSubmit={submit} className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label={t('register.company')}>
              <input
                className="input"
                required
                minLength={2}
                value={f.company}
                onChange={set('company')}
                autoComplete="organization"
              />
            </Field>
            <Field label={t('register.country')}>
              <select className="input" value={f.country} onChange={set('country')}>
                {countries.map((c) => (
                  <option key={c.code} value={c.code}>
                    {c.name}
                  </option>
                ))}
              </select>
            </Field>
          </div>
          <Field label={t('register.vat')} hint={t('common.optional')}>
            <input className="input" value={f.vat} onChange={set('vat')} />
          </Field>
          <Field label={t('register.name')}>
            <input
              className="input"
              required
              value={f.name}
              onChange={set('name')}
              autoComplete="name"
            />
          </Field>
          <Field label={t('auth.email')}>
            <input
              className="input"
              type="email"
              required
              value={f.email}
              onChange={set('email')}
              autoComplete="email"
            />
          </Field>
          <Field label={t('auth.password')} hint={t('register.passwordHint')}>
            <input
              className="input"
              type="password"
              required
              minLength={12}
              value={f.password}
              onChange={set('password')}
              autoComplete="new-password"
            />
          </Field>
          <label className="flex items-start gap-2 text-sm text-ink-soft">
            <input
              type="checkbox"
              className="mt-1"
              checked={accept}
              onChange={(e) => setAccept(e.target.checked)}
              required
            />
            {t('register.terms')}
          </label>
          {kind !== 'shipper' && (
            <p className="text-sm text-ink-soft">{t('register.reviewNote')}</p>
          )}
          <ErrorText error={error} />
          <button className="btn-primary w-full" disabled={busy || !accept}>
            {t('register.submit')}
          </button>
        </form>
      </Card>
      <p className="mt-4 text-center text-sm">
        <Link href="/login" className="text-brand">
          {t('home.haveAccount')} {t('auth.login')}
        </Link>
      </p>
    </div>
  );
}

export default function Register() {
  return (
    <Suspense>
      <RegisterForm />
    </Suspense>
  );
}
