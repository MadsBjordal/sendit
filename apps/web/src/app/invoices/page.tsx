'use client';
import { useEffect, useState } from 'react';
import { useRequireAuth } from '@/components/auth';
import { Empty, ErrorText, PageTitle, Spinner } from '@/components/ui';
import { useI18n, type MessageKey } from '@/i18n';
import { api } from '@/lib/api';
import { date, money } from '@/lib/format';

interface Inv {
  id: string;
  number: string;
  kind: string;
  totalMinor: number;
  vatMinor: number;
  currency: string;
  issuedAt: string;
  fileId: string | null;
}

export default function Invoices() {
  const { me } = useRequireAuth(['shipper', 'carrier', 'customs_provider']);
  const { t, locale } = useI18n();
  const [list, setList] = useState<Inv[] | null>(null);
  const [error, setError] = useState<unknown>(null);
  useEffect(() => {
    if (me) api<Inv[]>('/api/org/invoices').then(setList).catch(setError);
  }, [me]);
  if (!me) return <Spinner />;
  return (
    <div>
      <PageTitle title={t('nav.invoices')} subtitle={t('invoices.subtitle')} />
      <ErrorText error={error} />
      {!list && !error && <Spinner />}
      {list?.length === 0 && <Empty title={t('invoices.empty')} />}
      {list && list.length > 0 && (
        <div className="overflow-x-auto rounded-2xl border border-slate-200 bg-white shadow-card">
          <table className="w-full text-sm">
            <tbody>
              {list.map((i) => (
                <tr key={i.id} className="border-b border-slate-100 last:border-0">
                  <td className="px-4 py-3 font-mono">{i.number}</td>
                  <td className="px-2 py-3">{t(`invoices.kind.${i.kind}` as MessageKey)}</td>
                  <td className="px-2 py-3 text-ink-soft">{date(i.issuedAt, locale)}</td>
                  <td className="px-2 py-3 text-right font-semibold">
                    {money(i.totalMinor, i.currency, locale)}
                  </td>
                  <td className="px-4 py-3 text-right">
                    {i.fileId && (
                      <a
                        className="text-brand"
                        href={`/api/files/${i.fileId}`}
                        target="_blank"
                        rel="noreferrer"
                      >
                        PDF
                      </a>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
