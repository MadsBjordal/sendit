'use client';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useRequireAuth } from '@/components/auth';
import { CustomsPanel } from '@/components/CustomsPanel';
import { Messages } from '@/components/Messages';
import { Spinner } from '@/components/ui';
import { useI18n } from '@/i18n';

export default function CustomsShipment() {
  const { me } = useRequireAuth('customs_provider');
  const { t } = useI18n();
  const { id } = useParams<{ id: string }>();
  if (!me) return <Spinner />;
  return (
    <div className="space-y-5">
      <Link href="/customs/jobs" className="text-sm text-brand">
        ‹ {t('nav.customsJobs')}
      </Link>
      <CustomsPanel shipmentId={id} />
      <Messages shipmentId={id} />
    </div>
  );
}
