'use client';
import { useCallback, useEffect, useState } from 'react';
import { Card, Empty, ErrorText, Field, Spinner, StatusBadge } from '@/components/ui';
import { useI18n } from '@/i18n';
import { api, post } from '@/lib/api';
import { dateTime } from '@/lib/format';

interface Ticket {
  id: string;
  subject: string;
  status: string;
  updatedAt: string;
  org?: string | null;
}
interface Detail extends Ticket {
  messages: Array<{
    id: string;
    body: string;
    fromStaff: boolean;
    name: string;
    createdAt: string;
  }>;
}

/** Support for companies (their tickets) and for platform staff (all tickets, from the admin page). */
export function SupportDesk({ staff = false }: { staff?: boolean }) {
  const { t, locale } = useI18n();
  const [list, setList] = useState<Ticket[] | null>(null);
  const [open, setOpen] = useState<Detail | null>(null);
  const [creating, setCreating] = useState(false);
  const [f, setF] = useState({ subject: '', body: '' });
  const [reply, setReply] = useState('');
  const [error, setError] = useState<unknown>(null);
  const load = useCallback(
    () =>
      api<Ticket[]>(`/api/support/tickets${staff ? '?status=open' : ''}`)
        .then(setList)
        .catch(setError),
    [staff],
  );
  const show = (id: string) =>
    api<Detail>(`/api/support/tickets/${id}`).then(setOpen).catch(setError);
  useEffect(() => {
    load();
  }, [load]);
  return (
    <div className="grid gap-5 lg:grid-cols-[320px_1fr]">
      <div className="space-y-2">
        {!staff && (
          <button className="btn-primary w-full" onClick={() => (setCreating(true), setOpen(null))}>
            {t('support.new')}
          </button>
        )}
        <ErrorText error={error} />
        {!list && <Spinner />}
        {list?.length === 0 && <Empty title={t('support.none')} />}
        {list?.map((x) => (
          <button
            key={x.id}
            onClick={() => (setCreating(false), show(x.id))}
            className={`card w-full py-3 text-left ${open?.id === x.id ? 'border-brand' : ''}`}
          >
            <div className="font-medium">{x.subject}</div>
            <div className="mt-1 flex items-center justify-between text-xs text-ink-soft">
              <span>
                {x.org ?? ''} {dateTime(x.updatedAt, locale)}
              </span>
              <StatusBadge status={`ticket_${x.status}`} />
            </div>
          </button>
        ))}
      </div>
      <div>
        {creating && (
          <Card className="space-y-3">
            <Field label={t('support.subject')}>
              <input
                className="input"
                value={f.subject}
                onChange={(e) => setF({ ...f, subject: e.target.value })}
              />
            </Field>
            <Field label={t('support.message')}>
              <textarea
                className="input"
                rows={6}
                value={f.body}
                onChange={(e) => setF({ ...f, body: e.target.value })}
              />
            </Field>
            <button
              className="btn-primary"
              disabled={f.subject.length < 3 || f.body.length < 3}
              onClick={async () => {
                try {
                  const r = await post<Ticket>('/api/support/tickets', f);
                  setCreating(false);
                  setF({ subject: '', body: '' });
                  await load();
                  show(r.id);
                } catch (e) {
                  setError(e);
                }
              }}
            >
              {t('msg.send')}
            </button>
          </Card>
        )}
        {open && (
          <Card className="space-y-3">
            <div className="font-semibold">{open.subject}</div>
            {open.messages.map((m) => (
              <div
                key={m.id}
                className={`rounded-xl p-3 text-sm ${m.fromStaff ? 'bg-brand-soft' : 'bg-slate-50'}`}
              >
                <div className="mb-1 text-xs font-semibold text-ink-soft">
                  {m.name} · {dateTime(m.createdAt, locale)}
                </div>
                <div className="whitespace-pre-wrap">{m.body}</div>
              </div>
            ))}
            {open.status !== 'closed' && (
              <div className="space-y-2">
                <textarea
                  className="input"
                  rows={3}
                  value={reply}
                  onChange={(e) => setReply(e.target.value)}
                  placeholder={t('msg.placeholder')}
                />
                <div className="flex gap-2">
                  <button
                    className="btn-primary"
                    disabled={!reply.trim()}
                    onClick={() =>
                      post(`/api/support/tickets/${open.id}/reply`, { body: reply })
                        .then(() => (setReply(''), show(open.id), load()))
                        .catch(setError)
                    }
                  >
                    {t('msg.send')}
                  </button>
                  <button
                    className="btn-secondary"
                    onClick={() =>
                      post(`/api/support/tickets/${open.id}/reply`, {
                        body: reply || '—',
                        close: true,
                      })
                        .then(() => (setReply(''), show(open.id), load()))
                        .catch(setError)
                    }
                  >
                    {t('support.close')}
                  </button>
                </div>
              </div>
            )}
          </Card>
        )}
      </div>
    </div>
  );
}
