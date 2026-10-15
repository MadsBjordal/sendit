'use client';
import { useRequireAuth } from '@/components/auth';
import { SupportDesk } from '@/components/SupportDesk';
import { PageTitle, Spinner } from '@/components/ui';
import { useI18n } from '@/i18n';

export default function Support() {
  const { me } = useRequireAuth();
  const { t } = useI18n();
  if (!me) return <Spinner />;
  return (
    <div>
      <PageTitle title={t('nav.support')} subtitle={t('support.subtitle')} />
      <SupportDesk />
    </div>
  );
}
