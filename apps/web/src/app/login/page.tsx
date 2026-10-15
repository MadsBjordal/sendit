'use client';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { homeFor, useAuth } from '@/components/auth';
import { Card, ErrorText, Field } from '@/components/ui';
import { useI18n } from '@/i18n';
import { api, ApiError, post } from '@/lib/api';

export default function Login() {
  const { t } = useI18n();
  const { refresh } = useAuth();
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [mfaCode, setMfaCode] = useState('');
  const [needMfa, setNeedMfa] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await post('/api/auth/login', { email, password, ...(needMfa ? { mfaCode } : {}) });
      await refresh();
      router.push(homeFor(await api('/api/auth/me')));
    } catch (err) {
      if (err instanceof ApiError && err.code === 'mfa_required') setNeedMfa(true);
      else setError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mx-auto max-w-md">
      <h1 className="mb-6 text-2xl font-bold">{t('auth.login')}</h1>
      <Card>
        <form onSubmit={submit} className="space-y-4">
          <Field label={t('auth.email')}>
            <input
              className="input"
              type="email"
              autoComplete="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </Field>
          <Field label={t('auth.password')}>
            <input
              className="input"
              type="password"
              autoComplete="current-password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </Field>
          {needMfa && (
            <Field label={t('auth.mfaCode')} hint={t('auth.mfaHint')}>
              <input
                className="input tracking-widest"
                inputMode="numeric"
                pattern="\d{6}"
                maxLength={6}
                autoFocus
                required
                value={mfaCode}
                onChange={(e) => setMfaCode(e.target.value)}
              />
            </Field>
          )}
          <ErrorText error={error} />
          <button className="btn-primary w-full" disabled={busy}>
            {t('auth.login')}
          </button>
        </form>
      </Card>
      <div className="mt-4 flex justify-between text-sm">
        <Link href="/forgot-password" className="text-brand">
          {t('auth.forgot')}
        </Link>
        <Link href="/register" className="text-brand">
          {t('auth.register')}
        </Link>
      </div>
    </div>
  );
}
