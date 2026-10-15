'use client';
import { useCallback, useEffect, useState } from 'react';
import { useRequireAuth } from '@/components/auth';
import {
  Alert,
  Badge,
  Card,
  ErrorText,
  Field,
  PageTitle,
  Spinner,
  StatusBadge,
} from '@/components/ui';
import { useI18n, type MessageKey } from '@/i18n';
import { api, ApiError, post } from '@/lib/api';
import { date, dateTime, money } from '@/lib/format';

type Tab = 'organisations' | 'shipments' | 'countries' | 'finance' | 'audit';

export default function Admin() {
  const { me, refresh } = useRequireAuth();
  const { t } = useI18n();
  const [tab, setTab] = useState<Tab>('organisations');
  if (!me) return <Spinner />;
  if (!me.user.platformRole) return <Alert tone="red" title={t('error.forbidden')} />;
  if (!me.mfaPassed) return <MfaSetup onDone={refresh} />;
  return (
    <div>
      <PageTitle title={t('nav.admin')} />
      <div className="mb-5 flex flex-wrap gap-1 border-b border-slate-200">
        {(['organisations', 'shipments', 'countries', 'finance', 'audit'] as const).map((k) => (
          <button
            key={k}
            onClick={() => setTab(k)}
            className={`-mb-px border-b-2 px-3 py-2 text-sm font-medium ${tab === k ? 'border-brand text-brand' : 'border-transparent text-ink-soft'}`}
          >
            {t(`admin.tab.${k}` as MessageKey)}
          </button>
        ))}
      </div>
      {tab === 'organisations' && <Organisations />}
      {tab === 'shipments' && <Shipments />}
      {tab === 'countries' && <Countries />}
      {tab === 'finance' && <Finance />}
      {tab === 'audit' && <Audit />}
    </div>
  );
}

function MfaSetup({ onDone }: { onDone(): Promise<void> }) {
  const { t } = useI18n();
  const [setup, setSetup] = useState<{ secret: string; otpauthUrl: string } | null>(null);
  const [code, setCode] = useState('');
  const [error, setError] = useState<unknown>(null);
  return (
    <div className="mx-auto max-w-md space-y-4">
      <Alert tone="amber" title={t('admin.mfaNeeded')}>
        {t('admin.mfaText')}
      </Alert>
      {!setup ? (
        <button
          className="btn-primary"
          onClick={() => post('/api/auth/mfa/setup').then(setSetup).catch(setError)}
        >
          {t('admin.mfaStart')}
        </button>
      ) : (
        <Card className="space-y-3">
          <div className="text-sm">{t('admin.mfaSecret')}</div>
          <code className="block break-all rounded bg-slate-100 p-2 text-sm">{setup.secret}</code>
          <Field label={t('auth.mfaCode')}>
            <input
              className="input"
              inputMode="numeric"
              maxLength={6}
              value={code}
              onChange={(e) => setCode(e.target.value)}
            />
          </Field>
          <button
            className="btn-primary"
            onClick={() => post('/api/auth/mfa/enable', { code }).then(onDone).catch(setError)}
          >
            {t('admin.mfaEnable')}
          </button>
        </Card>
      )}
      <ErrorText error={error} />
    </div>
  );
}

function useLoad<T>(url: string) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<unknown>(null);
  const load = useCallback(() => api<T>(url).then(setData).catch(setError), [url]);
  useEffect(() => {
    load();
  }, [load]);
  return { data, error, load, setError };
}

interface Org {
  id: string;
  name: string;
  kind: string;
  country: string;
  status: string;
  vatNumber: string | null;
  createdAt: string;
  documents: Array<{
    id: string;
    kind: string;
    reference: string;
    validUntil: string | null;
    status: string;
  }>;
}

function Organisations() {
  const { t, locale } = useI18n();
  const [filter, setFilter] = useState('pending_verification');
  const { data, error, load, setError } = useLoad<Org[]>(
    `/api/admin/organisations${filter ? `?status=${filter}` : ''}`,
  );
  const act = (fn: () => Promise<unknown>) => fn().then(load).catch(setError);
  const ask = (what: string) => prompt(what) || null;
  return (
    <div className="space-y-3">
      <select className="input w-auto" value={filter} onChange={(e) => setFilter(e.target.value)}>
        <option value="pending_verification">{t('status.pending_verification')}</option>
        <option value="verified">{t('status.verified')}</option>
        <option value="">{t('admin.all')}</option>
      </select>
      <ErrorText error={error} />
      {!data && <Spinner />}
      {data?.map((o) => (
        <Card key={o.id}>
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <div className="font-semibold">{o.name}</div>
              <div className="text-sm text-ink-soft">
                {t(`register.kind.${o.kind}` as MessageKey)} · {o.country} · {o.vatNumber ?? '–'} ·{' '}
                {date(o.createdAt, locale)}
              </div>
            </div>
            <div className="flex items-center gap-2">
              <StatusBadge status={o.status} />
              {o.status !== 'verified' && (
                <button
                  className="btn-primary px-3 py-1.5 text-sm"
                  onClick={() =>
                    act(() =>
                      post(`/api/admin/organisations/${o.id}/decision`, { decision: 'verified' }),
                    )
                  }
                >
                  {t('admin.verify')}
                </button>
              )}
              {o.status === 'pending_verification' && (
                <button
                  className="btn-danger px-3 py-1.5 text-sm"
                  onClick={() => {
                    const note = ask(t('admin.why'));
                    if (note)
                      act(() =>
                        post(`/api/admin/organisations/${o.id}/decision`, {
                          decision: 'rejected',
                          note,
                        }),
                      );
                  }}
                >
                  {t('admin.reject')}
                </button>
              )}
              {o.status === 'verified' && (
                <button
                  className="btn-danger px-3 py-1.5 text-sm"
                  onClick={() => {
                    const note = ask(t('admin.why'));
                    if (note)
                      act(() =>
                        post(`/api/admin/organisations/${o.id}/decision`, {
                          decision: 'suspended',
                          note,
                        }),
                      );
                  }}
                >
                  {t('admin.suspend')}
                </button>
              )}
            </div>
          </div>
          {o.documents.length > 0 && (
            <div className="mt-3 divide-y divide-slate-100 rounded-xl bg-slate-50 px-3">
              {o.documents.map((d) => (
                <div
                  key={d.id}
                  className="flex flex-wrap items-center justify-between gap-2 py-2 text-sm"
                >
                  <span>
                    {t(`doc.${d.kind}` as MessageKey)} · {d.reference} · {t('verify.validUntil')}{' '}
                    {date(d.validUntil, locale)}
                  </span>
                  <span className="flex items-center gap-2">
                    <StatusBadge status={d.status} />
                    {d.status === 'pending' && (
                      <>
                        <button
                          className="btn-secondary px-2 py-1 text-xs"
                          onClick={() =>
                            act(() =>
                              post(`/api/admin/documents/${d.id}/review`, { decision: 'approved' }),
                            )
                          }
                        >
                          {t('admin.approve')}
                        </button>
                        <button
                          className="btn-danger px-2 py-1 text-xs"
                          onClick={() => {
                            const note = ask(t('admin.why'));
                            if (note)
                              act(() =>
                                post(`/api/admin/documents/${d.id}/review`, {
                                  decision: 'rejected',
                                  note,
                                }),
                              );
                          }}
                        >
                          {t('admin.reject')}
                        </button>
                      </>
                    )}
                  </span>
                </div>
              ))}
            </div>
          )}
        </Card>
      ))}
    </div>
  );
}

function Shipments() {
  const { t, locale } = useI18n();
  const { data, error } = useLoad<{
    byStatus: Array<{ status: string; n: number }>;
    recent: Array<{
      id: string;
      number: number;
      status: string;
      org: string;
      serviceLevel: string;
      maxPriceMinor: number;
      createdAt: string;
    }>;
  }>('/api/admin/shipments');
  if (error) return <ErrorText error={error} />;
  if (!data) return <Spinner />;
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-2">
        {data.byStatus.map((s) => (
          <Card key={s.status} className="min-w-32 py-3">
            <div className="text-2xl font-bold">{s.n}</div>
            <StatusBadge status={s.status} />
          </Card>
        ))}
      </div>
      <Card className="overflow-x-auto p-0">
        <table className="w-full text-sm">
          <tbody>
            {data.recent.map((s) => (
              <tr key={s.id} className="border-b border-slate-100">
                <td className="px-3 py-2 font-mono">PF-{String(s.number).padStart(6, '0')}</td>
                <td className="px-3 py-2">{s.org}</td>
                <td className="px-3 py-2">{t(`level.${s.serviceLevel}` as MessageKey)}</td>
                <td className="px-3 py-2">{money(s.maxPriceMinor, 'EUR', locale)}</td>
                <td className="px-3 py-2">{dateTime(s.createdAt, locale)}</td>
                <td className="px-3 py-2">
                  <StatusBadge status={s.status} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
    </div>
  );
}

function Countries() {
  const { t } = useI18n();
  const { data, error, load, setError } = useLoad<
    Array<{
      code: string;
      name: string;
      eu: boolean;
      blocked?: string;
      enabled: boolean;
      domesticEnabled: boolean;
    }>
  >('/api/admin/countries');
  const save = (code: string, enabled: boolean, domesticEnabled: boolean) =>
    api(`/api/admin/countries/${code}`, {
      method: 'PUT',
      body: { enabled, domesticEnabled: enabled && domesticEnabled, note: null },
    })
      .then(load)
      .catch(setError);
  return (
    <div className="space-y-3">
      <Alert tone="amber">{t('admin.countriesWarning')}</Alert>
      <ErrorText error={error} />
      {!data && <Spinner />}
      <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
        {data?.map((c) => (
          <Card key={c.code} className="flex items-center justify-between py-3">
            <div>
              <div className="font-medium">
                {c.name} <span className="text-ink-faint">{c.code}</span>
              </div>
              {c.blocked && <div className="text-xs text-red-700">{c.blocked}</div>}
            </div>
            <div className="flex flex-col items-end gap-1 text-sm">
              <label className="flex gap-1.5">
                <input
                  type="checkbox"
                  disabled={!!c.blocked}
                  checked={c.enabled}
                  onChange={(e) => save(c.code, e.target.checked, c.domesticEnabled)}
                />
                {t('admin.open')}
              </label>
              <label className="flex gap-1.5">
                <input
                  type="checkbox"
                  disabled={!!c.blocked || !c.enabled}
                  checked={c.domesticEnabled}
                  onChange={(e) => save(c.code, c.enabled, e.target.checked)}
                />
                {t('admin.domestic')}
              </label>
            </div>
          </Card>
        ))}
      </div>
    </div>
  );
}

function Finance() {
  const { t, locale } = useI18n();
  const { data, error } =
    useLoad<Array<{ code: string; currency: string; total: number }>>('/api/admin/ledger');
  if (error)
    return error instanceof ApiError && error.status === 403 ? (
      <Alert tone="gray" title={t('error.forbidden')} />
    ) : (
      <ErrorText error={error} />
    );
  if (!data) return <Spinner />;
  return (
    <Card>
      <div className="mb-1 font-semibold">{t('admin.ledger')}</div>
      <p className="mb-3 text-sm text-ink-soft">{t('admin.ledgerText')}</p>
      <table className="w-full text-sm">
        <tbody>
          {data.map((r) => (
            <tr key={`${r.code}${r.currency}`} className="border-b border-slate-100">
              <td className="py-2">{t(`ledger.${r.code}` as MessageKey)}</td>
              <td className="py-2 text-right font-mono">{money(r.total, r.currency, locale)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="mt-3">
        <Badge tone="amber">{t('admin.testMoney')}</Badge>
      </div>
    </Card>
  );
}

function Audit() {
  const { locale } = useI18n();
  const { data, error } = useLoad<
    Array<{
      id: number;
      action: string;
      targetType: string | null;
      targetId: string | null;
      actorUserId: string | null;
      ip: string | null;
      createdAt: string;
    }>
  >('/api/admin/audit');
  if (error) return <ErrorText error={error} />;
  if (!data) return <Spinner />;
  return (
    <Card className="overflow-x-auto p-0">
      <table className="w-full text-sm">
        <tbody>
          {data.map((a) => (
            <tr key={a.id} className="border-b border-slate-100">
              <td className="whitespace-nowrap px-3 py-2 text-ink-soft">
                {dateTime(a.createdAt, locale)}
              </td>
              <td className="px-3 py-2 font-medium">{a.action}</td>
              <td className="px-3 py-2 text-ink-soft">
                {a.targetType} {a.targetId?.slice(0, 8)}
              </td>
              <td className="px-3 py-2 font-mono text-xs text-ink-faint">
                {a.actorUserId?.slice(0, 8)} {a.ip}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </Card>
  );
}
