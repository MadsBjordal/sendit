'use client';
import { useEffect, useState } from 'react';
import { useRequireAuth } from '@/components/auth';
import { Alert, Card, ErrorText, Field, PageTitle, Spinner, StatusBadge } from '@/components/ui';
import { useI18n } from '@/i18n';
import { api } from '@/lib/api';
import { dateTime, money } from '@/lib/format';

interface Earnings {
  totals: { upcomingMinor: number; payableMinor: number; paidMinor: number; heldMinor: number };
  obligations: Array<{
    id: string;
    amountMinor: number;
    currency: string;
    status: string;
    createdAt: string;
    payableAt: string | null;
    paidAt: string | null;
  }>;
  payouts: Array<{
    id: string;
    amountMinor: number;
    currency: string;
    status: string;
    ibanMasked: string;
    initiatedAt: string;
    paidAt: string | null;
    failureReason: string | null;
  }>;
  account: { holderName: string; iban: string; bic: string | null } | null;
}

export default function EarningsPage() {
  const { me } = useRequireAuth(['carrier', 'customs_provider']);
  const { t, locale } = useI18n();
  const [e, setE] = useState<Earnings | null>(null);
  const [edit, setEdit] = useState(false);
  const [acc, setAcc] = useState({ holderName: '', iban: '', bic: '' });
  const [error, setError] = useState<unknown>(null);
  const load = () => api<Earnings>('/api/carrier/earnings').then(setE).catch(setError);
  useEffect(() => {
    if (me) load();
  }, [me]);
  if (!me) return <Spinner />;
  if (!e) return error ? <ErrorText error={error} /> : <Spinner />;
  const m = (n: number) => money(n, 'EUR', locale);
  return (
    <div className="space-y-5">
      <PageTitle title={t('nav.earnings')} subtitle={t('earnings.subtitle')} />
      <div className="grid gap-3 sm:grid-cols-4">
        {(
          [
            ['earnings.upcoming', e.totals.upcomingMinor],
            ['earnings.payable', e.totals.payableMinor],
            ['earnings.paid', e.totals.paidMinor],
            ['earnings.held', e.totals.heldMinor],
          ] as const
        ).map(([k, v]) => (
          <Card key={k} className="py-4">
            <div className="text-xs text-ink-soft">{t(k)}</div>
            <div className="text-2xl font-bold">{m(v)}</div>
          </Card>
        ))}
      </div>
      <Card>
        <div className="mb-2 flex items-center justify-between">
          <div className="font-semibold">{t('earnings.bank')}</div>
          {!edit && (
            <button className="btn-ghost text-sm" onClick={() => setEdit(true)}>
              {e.account ? t('earnings.change') : t('earnings.add')}
            </button>
          )}
        </div>
        {!e.account && !edit && <Alert tone="amber">{t('earnings.noAccount')}</Alert>}
        {e.account && !edit && (
          <div className="text-sm">
            {e.account.holderName} · <span className="font-mono">{e.account.iban}</span>{' '}
            {e.account.bic && `· ${e.account.bic}`}
          </div>
        )}
        {edit && (
          <form
            className="grid gap-3 sm:grid-cols-[1fr_1fr_140px_auto]"
            onSubmit={async (ev) => {
              ev.preventDefault();
              try {
                await api('/api/org/payout-account', {
                  method: 'PUT',
                  body: { holderName: acc.holderName, iban: acc.iban, bic: acc.bic || null },
                });
                setEdit(false);
                load();
              } catch (err) {
                setError(err);
              }
            }}
          >
            <Field label={t('earnings.holder')}>
              <input
                className="input"
                required
                value={acc.holderName}
                onChange={(x) => setAcc({ ...acc, holderName: x.target.value })}
              />
            </Field>
            <Field label="IBAN">
              <input
                className="input font-mono"
                required
                value={acc.iban}
                onChange={(x) => setAcc({ ...acc, iban: x.target.value })}
              />
            </Field>
            <Field label="BIC">
              <input
                className="input font-mono"
                value={acc.bic}
                onChange={(x) => setAcc({ ...acc, bic: x.target.value })}
              />
            </Field>
            <div className="flex items-end">
              <button className="btn-primary">{t('common.save')}</button>
            </div>
          </form>
        )}
        <ErrorText error={error} />
        <p className="mt-2 text-xs text-ink-faint">{t('earnings.bankNote')}</p>
      </Card>
      <Card className="overflow-x-auto p-0">
        <div className="px-5 pt-4 font-semibold">{t('earnings.payouts')}</div>
        <table className="mt-2 w-full text-sm">
          <tbody>
            {e.payouts.length === 0 && (
              <tr>
                <td className="px-5 py-3 text-ink-faint">{t('earnings.noPayouts')}</td>
              </tr>
            )}
            {e.payouts.map((p) => (
              <tr key={p.id} className="border-t border-slate-100">
                <td className="px-5 py-2">{dateTime(p.initiatedAt, locale)}</td>
                <td className="px-2 py-2 font-semibold">
                  {money(p.amountMinor, p.currency, locale)}
                </td>
                <td className="px-2 py-2 font-mono text-xs">{p.ibanMasked}</td>
                <td className="px-2 py-2">
                  <StatusBadge status={p.status} />
                  {p.failureReason && (
                    <span className="ml-2 text-xs text-red-700">{p.failureReason}</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
    </div>
  );
}
