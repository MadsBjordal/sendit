'use client';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Suspense, useState } from 'react';
import { Alert, Card, ErrorText, Field } from '@/components/ui';
import { useI18n } from '@/i18n';
import { post } from '@/lib/api';

function Reset() {
  const { t } = useI18n();
  const token = useSearchParams().get('token') ?? '';
  const [password, setPassword] = useState('');
  const [done, setDone] = useState(false);
  const [error, setError] = useState<unknown>(null);
  return (
    <div className="mx-auto max-w-md">
      <h1 className="mb-6 text-2xl font-bold">{t('auth.newPassword')}</h1>
      <Card>
        {done ? (
          <div className="space-y-4">
            <Alert tone="green" title={t('auth.passwordChanged')} />
            <Link href="/login" className="btn-primary">
              {t('auth.login')}
            </Link>
          </div>
        ) : (
          <form
            className="space-y-4"
            onSubmit={async (e) => {
              e.preventDefault();
              try {
                await post('/api/auth/reset-password', { token, password });
                setDone(true);
              } catch (err) {
                setError(err);
              }
            }}
          >
            <Field label={t('auth.password')} hint={t('register.passwordHint')}>
              <input
                className="input"
                type="password"
                minLength={12}
                required
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete="new-password"
              />
            </Field>
            <ErrorText error={error} />
            <button className="btn-primary w-full">{t('common.save')}</button>
          </form>
        )}
      </Card>
    </div>
  );
}

export default function Page() {
  return (
    <Suspense>
      <Reset />
    </Suspense>
  );
}
