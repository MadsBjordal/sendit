'use client';
import { useParams, useRouter } from 'next/navigation';
import { useEffect } from 'react';
import { useAuth } from '@/components/auth';
import { Spinner } from '@/components/ui';

/** Links in emails and notifications point here; each kind of company lands on its own view. */
export default function Go() {
  const { id } = useParams<{ id: string }>();
  const { me, loading } = useAuth();
  const router = useRouter();
  useEffect(() => {
    if (loading) return;
    if (!me) return router.replace(`/login?next=/go/${id}`);
    const kind = me.org?.kind;
    if (kind === 'shipper') router.replace(`/shipments/${id}`);
    else if (kind === 'carrier') router.replace(`/carrier/bookings#${id}`);
    else if (kind === 'customs_provider') router.replace(`/customs/jobs#${id}`);
    else if (me.user.platformRole) router.replace(`/admin/shipments/${id}`);
    else router.replace('/');
  }, [loading, me, id, router]);
  return <Spinner />;
}
