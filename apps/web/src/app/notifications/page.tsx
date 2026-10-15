'use client';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { useRequireAuth } from '@/components/auth';
import { Empty, ErrorText, PageTitle, Spinner } from '@/components/ui';
import { useI18n, type MessageKey } from '@/i18n';
import { api, post } from '@/lib/api';
import { dateTime } from '@/lib/format';

interface Note {
  id: string;
  kind: string;
  shipmentId: string | null;
  readAt: string | null;
  createdAt: string;
}

export default function Notifications() {
  const { me } = useRequireAuth();
  const { t, locale } = useI18n();
  const [list, setList] = useState<Note[] | null>(null);
  const [error, setError] = useState<unknown>(null);
  useEffect(() => {
    if (me) api<Note[]>('/api/notifications').then(setList).catch(setError);
  }, [me]);
  if (!me) return <Spinner />;
  const unread = list?.some((n) => !n.readAt);
  return (
    <div>
      <PageTitle
        title={t('common.notifications')}
        actions={
          unread && (
            <button
              className="btn-secondary"
              onClick={() =>
                post('/api/notifications/read').then(() =>
                  setList(
                    list!.map((n) => ({ ...n, readAt: n.readAt ?? new Date().toISOString() })),
                  ),
                )
              }
            >
              {t('notif.markRead')}
            </button>
          )
        }
      />
      <ErrorText error={error} />
      {!list && !error && <Spinner />}
      {list?.length === 0 && <Empty title={t('notif.empty')} />}
      {list && list.length > 0 && (
        <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-card">
          {list.map((n) => {
            const key = `notif.${n.kind}` as MessageKey;
            const text = t(key) === key ? n.kind : t(key);
            const body = (
              <div
                className={`flex items-center gap-3 px-4 py-3 ${n.readAt ? '' : 'bg-brand-soft/40'}`}
              >
                {!n.readAt && <span className="h-2 w-2 shrink-0 rounded-full bg-brand" />}
                <span className="flex-1">{text}</span>
                <span className="text-sm text-ink-faint">{dateTime(n.createdAt, locale)}</span>
              </div>
            );
            return n.shipmentId ? (
              <Link
                key={n.id}
                href={`/go/${n.shipmentId}`}
                className="block border-b border-slate-100 last:border-0 hover:bg-slate-50"
              >
                {body}
              </Link>
            ) : (
              <div key={n.id} className="border-b border-slate-100 last:border-0">
                {body}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
