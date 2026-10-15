'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Card } from '@/components/ui';
import { useI18n, type MessageKey } from '@/i18n';
import { api, post } from '@/lib/api';
import { dateTime } from '@/lib/format';

interface Msg {
  id: string;
  body: string;
  senderRole: string;
  senderName: string;
  mine: boolean;
  createdAt: string;
}

/** Shipment conversation between the customer, the carrier, the driver, customs brokers and support. */
export function Messages({ shipmentId }: { shipmentId: string }) {
  const { t, locale } = useI18n();
  const [list, setList] = useState<Msg[]>([]);
  const [text, setText] = useState('');
  const end = useRef<HTMLDivElement>(null);
  const load = useCallback(
    () =>
      api<Msg[]>(`/api/shipments/${shipmentId}/messages`)
        .then(setList)
        .catch(() => {}),
    [shipmentId],
  );
  useEffect(() => {
    load();
    const timer = setInterval(load, 10_000);
    return () => clearInterval(timer);
  }, [load]);
  useEffect(() => end.current?.scrollIntoView({ block: 'nearest' }), [list.length]);
  return (
    <Card>
      <div className="mb-3 font-semibold">{t('msg.title')}</div>
      <div className="max-h-80 space-y-2 overflow-auto">
        {list.length === 0 && <p className="text-sm text-ink-faint">{t('msg.empty')}</p>}
        {list.map((m) => (
          <div key={m.id} className={`flex ${m.mine ? 'justify-end' : ''}`}>
            <div
              className={`max-w-[80%] rounded-2xl px-3 py-2 text-sm ${m.mine ? 'bg-brand text-white' : 'bg-slate-100'}`}
            >
              {!m.mine && (
                <div className="text-xs font-semibold opacity-70">
                  {m.senderName} · {t(`msg.role.${m.senderRole}` as MessageKey)}
                </div>
              )}
              <div className="whitespace-pre-wrap">{m.body}</div>
              <div className="mt-0.5 text-[10px] opacity-60">{dateTime(m.createdAt, locale)}</div>
            </div>
          </div>
        ))}
        <div ref={end} />
      </div>
      <form
        className="mt-3 flex gap-2"
        onSubmit={async (e) => {
          e.preventDefault();
          if (!text.trim()) return;
          await post(`/api/shipments/${shipmentId}/messages`, { body: text }).catch(() => {});
          setText('');
          load();
        }}
      >
        <input
          className="input"
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder={t('msg.placeholder')}
          maxLength={4000}
        />
        <button className="btn-primary">{t('msg.send')}</button>
      </form>
    </Card>
  );
}
