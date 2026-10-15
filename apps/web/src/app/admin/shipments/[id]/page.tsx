'use client';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useEffect, useState } from 'react';
import { useRequireAuth } from '@/components/auth';
import { CustomsPanel } from '@/components/CustomsPanel';
import { Messages } from '@/components/Messages';
import { TripPanel } from '@/components/TripPanel';
import { Badge, Card, ErrorText, PageTitle, Spinner, StatusBadge } from '@/components/ui';
import { useI18n } from '@/i18n';
import { api } from '@/lib/api';
import { dateTime, money } from '@/lib/format';

interface Detail {
  id: string;
  number: string;
  status: string;
  org: string;
  pickup: { city: string; country: string; lat: number; lng: number };
  delivery: { city: string; country: string; lat: number; lng: number };
  maxPriceMinor: number;
  booking: { carrierName: string; totalMinor: number } | null;
  events: Array<{ kind: string; at: string; data: Record<string, unknown> }>;
}

/** Everything about one shipment for platform staff (support, disputes). */
export default function AdminShipment() {
  const { me } = useRequireAuth();
  const { t, locale } = useI18n();
  const { id } = useParams<{ id: string }>();
  const [s, setS] = useState<Detail | null>(null);
  const [error, setError] = useState<unknown>(null);
  useEffect(() => {
    if (me) api<Detail>(`/api/admin/shipments/${id}`).then(setS).catch(setError);
  }, [me, id]);
  if (!me || (!s && !error)) return <Spinner />;
  if (!s) return <ErrorText error={error} />;
  return (
    <div className="space-y-5">
      <Link href="/admin" className="text-sm text-brand">
        ‹ {t('nav.admin')}
      </Link>
      <PageTitle
        title={`${s.pickup.city} → ${s.delivery.city}`}
        subtitle={`${s.number} · ${s.org}`}
        actions={<StatusBadge status={s.status} />}
      />
      <Card className="text-sm">
        {t('book.maximum')}: {money(s.maxPriceMinor, 'EUR', locale)}
        {s.booking && (
          <span className="ml-4">
            <Badge tone="green">{s.booking.carrierName}</Badge>{' '}
            {money(s.booking.totalMinor, 'EUR', locale)}
          </span>
        )}
      </Card>
      <TripPanel
        shipmentId={s.id}
        pickup={{ ...s.pickup, label: s.pickup.city, kind: 'pickup' }}
        delivery={{ ...s.delivery, label: s.delivery.city, kind: 'delivery' }}
      />
      <CustomsPanel shipmentId={s.id} />
      <Messages shipmentId={s.id} />
      <Card>
        <ol className="space-y-1 text-sm">
          {s.events.map((e, i) => (
            <li key={i} className="flex gap-3">
              <span className="w-44 shrink-0 text-ink-faint">{dateTime(e.at, locale)}</span>
              <span className="font-mono text-xs">{e.kind}</span>
              <span className="text-xs text-ink-soft">{JSON.stringify(e.data)}</span>
            </li>
          ))}
        </ol>
      </Card>
    </div>
  );
}
