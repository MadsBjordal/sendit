'use client';
import { useState } from 'react';
import { Alert, Card, Field } from '@/components/ui';
import { useI18n } from '@/i18n';
import { post } from '@/lib/api';

export default function Forgot() {
  const { t } = useI18n();
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState(false);
  return (
    <div className="mx-auto max-w-md">
      <h1 className="mb-6 text-2xl font-bold">{t('auth.forgot')}</h1>
      <Card>
        {sent ? (
          <Alert tone="green" title={t('auth.resetSent')} />
        ) : (
          <form
            className="space-y-4"
            onSubmit={async (e) => {
              e.preventDefault();
              await post('/api/auth/forgot-password', { email }).catch(() => {});
              setSent(true);
            }}
          >
            <Field label={t('auth.email')}>
              <input
                className="input"
                type="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
              />
            </Field>
            <button className="btn-primary w-full">{t('auth.sendReset')}</button>
          </form>
        )}
      </Card>
    </div>
  );
}
