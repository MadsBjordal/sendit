'use client';
import { useParams, useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useState } from 'react';
import { useRequireAuth } from '@/components/auth';
import { Alert, Card, ErrorText } from '@/components/ui';
import { useI18n } from '@/i18n';
import { post } from '@/lib/api';

/**
 * TEST checkout. With the simulated payment provider this page stands in for the provider's
 * hosted payment page: no card is asked for and no money moves.
 */
function Pay() {
  const { me } = useRequireAuth('shipper');
  const { t } = useI18n();
  const { ref } = useParams<{ ref: string }>();
  const shipment = useSearchParams().get('shipment');
  const router = useRouter();
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  if (!me) return null;
  const go = async (outcome: 'succeed' | 'fail') => {
    setBusy(true);
    try {
      await post(`/api/test-payments/${ref}/complete`, { outcome });
      router.push(`/shipments/${shipment}`);
    } catch (e) {
      setError(e);
      setBusy(false);
    }
  };
  return (
    <div className="mx-auto max-w-md space-y-4">
      <h1 className="text-2xl font-bold">{t('pay.title')}</h1>
      <Alert tone="amber" title={t('pay.testTitle')}>
        {t('pay.testText')}
      </Alert>
      <Card className="space-y-3">
        <button className="btn-primary w-full" disabled={busy} onClick={() => go('succeed')}>
          {t('pay.succeed')}
        </button>
        <button className="btn-secondary w-full" disabled={busy} onClick={() => go('fail')}>
          {t('pay.fail')}
        </button>
        <ErrorText error={error} />
      </Card>
    </div>
  );
}

export default function Page() {
  return (
    <Suspense>
      <Pay />
    </Suspense>
  );
}
