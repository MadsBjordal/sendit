'use client';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useState } from 'react';
import { homeFor, useAuth } from '@/components/auth';
import { Card, ErrorText, Field } from '@/components/ui';
import { useI18n } from '@/i18n';
import { api, post } from '@/lib/api';

function Accept() {
  const { t } = useI18n();
  const { me, refresh } = useAuth();
  const router = useRouter();
  const token = useSearchParams().get('token') ?? '';
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<unknown>(null);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      await post('/api/org/invitations/accept', me ? { token } : { token, name, password });
      await refresh();
      router.push(homeFor(await api('/api/auth/me')));
    } catch (err) {
      setError(err);
    }
  };
  return (
    <div className="mx-auto max-w-md">
      <h1 className="mb-6 text-2xl font-bold">{t('invite.title')}</h1>
      <Card>
        <form className="space-y-4" onSubmit={submit}>
          {!me && (
            <>
              <Field label={t('register.name')}>
                <input
                  className="input"
                  required
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                />
              </Field>
              <Field label={t('auth.password')} hint={t('register.passwordHint')}>
                <input
                  className="input"
                  type="password"
                  minLength={12}
                  required
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                />
              </Field>
            </>
          )}
          <ErrorText error={error} />
          <button className="btn-primary w-full">{t('invite.accept')}</button>
        </form>
      </Card>
    </div>
  );
}

export default function Page() {
  return (
    <Suspense>
      <Accept />
    </Suspense>
  );
}
