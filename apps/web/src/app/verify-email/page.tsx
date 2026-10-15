'use client';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useRef, useState } from 'react';
import { useAuth } from '@/components/auth';
import { Alert, ErrorText, Spinner } from '@/components/ui';
import { useI18n } from '@/i18n';
import { post } from '@/lib/api';

function Verify() {
  const { t } = useI18n();
  const { refresh } = useAuth();
  const token = useSearchParams().get('token') ?? '';
  const [state, setState] = useState<'busy' | 'done' | unknown>('busy');
  const once = useRef(false);
  useEffect(() => {
    if (once.current) return;
    once.current = true;
    post('/api/auth/verify-email', { token })
      .then(() => refresh())
      .then(() => setState('done'))
      .catch(setState);
  }, [token, refresh]);
  if (state === 'busy') return <Spinner />;
  return (
    <div className="mx-auto max-w-md space-y-4">
      {state === 'done' ? (
        <Alert tone="green" title={t('auth.emailConfirmed')} />
      ) : (
        <ErrorText error={state} />
      )}
      <Link href="/" className="btn-primary">
        {t('common.continue')}
      </Link>
    </div>
  );
}

export default function Page() {
  return (
    <Suspense>
      <Verify />
    </Suspense>
  );
}
