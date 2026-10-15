'use client';
import { useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useState } from 'react';
import { Alert, Card, ErrorText, Field, Spinner } from '@/components/ui';
import { useI18n, type MessageKey } from '@/i18n';
import { api, post } from '@/lib/api';

/** A party named for a customs role confirms it here (from the link in the email, no account needed). */
function Confirm() {
  const { t } = useI18n();
  const token = useSearchParams().get('token') ?? '';
  const [info, setInfo] = useState<{
    role: string;
    name: string;
    requestedBy: string;
    from: string;
    to: string;
  } | null>(null);
  const [name, setName] = useState('');
  const [done, setDone] = useState(false);
  const [error, setError] = useState<unknown>(null);
  useEffect(() => {
    api(`/api/customs/confirm?token=${encodeURIComponent(token)}`)
      .then(setInfo)
      .catch(setError);
  }, [token]);
  if (error)
    return (
      <div className="mx-auto max-w-md">
        <ErrorText error={error} />
      </div>
    );
  if (!info) return <Spinner />;
  return (
    <div className="mx-auto max-w-md space-y-4">
      <h1 className="text-2xl font-bold">{t('customsConfirm.title')}</h1>
      {done ? (
        <Alert tone="green" title={t('customsConfirm.done')} />
      ) : (
        <Card className="space-y-3">
          <p>
            {t('customsConfirm.text', {
              company: info.requestedBy,
              role: t(`party.${info.role}` as MessageKey),
              name: info.name,
              from: info.from,
              to: info.to,
            })}
          </p>
          <Field label={t('customsConfirm.yourName')}>
            <input className="input" value={name} onChange={(e) => setName(e.target.value)} />
          </Field>
          <button
            className="btn-primary w-full"
            disabled={name.trim().length < 2}
            onClick={() =>
              post('/api/customs/confirm', { token, name })
                .then(() => setDone(true))
                .catch(setError)
            }
          >
            {t('customsConfirm.confirm')}
          </button>
          <p className="text-xs text-ink-faint">{t('customsConfirm.ignore')}</p>
        </Card>
      )}
    </div>
  );
}

export default function Page() {
  return (
    <Suspense>
      <Confirm />
    </Suspense>
  );
}
