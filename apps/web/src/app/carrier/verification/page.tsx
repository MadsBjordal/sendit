'use client';
import { useEffect, useState } from 'react';
import { useRequireAuth } from '@/components/auth';
import {
  Alert,
  Card,
  ErrorText,
  Field,
  PageTitle,
  problemText,
  Spinner,
  StatusBadge,
} from '@/components/ui';
import { useI18n, type MessageKey } from '@/i18n';
import { api, post } from '@/lib/api';
import { date } from '@/lib/format';

interface Profile {
  status: string;
  statusNote: string | null;
  documents: Array<{
    id: string;
    kind: string;
    reference: string;
    validUntil: string | null;
    status: string;
    reviewNote: string | null;
  }>;
  problems: Array<{ code: string }>;
}
const KINDS = [
  'operator_licence',
  'carrier_liability_insurance',
  'company_registration',
  'vat_registration',
] as const;

export default function Verification() {
  const { me } = useRequireAuth(['carrier', 'customs_provider']);
  const { t, locale } = useI18n();
  const [p, setP] = useState<Profile | null>(null);
  const [f, setF] = useState({
    kind: 'operator_licence',
    reference: '',
    issuerCountry: 'DE',
    validUntil: '',
  });
  const [error, setError] = useState<unknown>(null);
  const load = () => api<Profile>('/api/carrier/profile').then(setP).catch(setError);
  useEffect(() => {
    if (me) load();
  }, [me]);
  if (!me || !p) return <Spinner />;
  return (
    <div className="space-y-6">
      <PageTitle title={t('nav.verification')} subtitle={t('verify.subtitle')} />
      <Card className="flex items-center justify-between">
        <div>
          <div className="font-semibold">{t('verify.company')}</div>
          {p.statusNote && <div className="text-sm text-ink-soft">{p.statusNote}</div>}
        </div>
        <StatusBadge status={p.status} />
      </Card>
      {p.problems.length === 0 && p.status === 'verified' ? (
        <Alert tone="green" title={t('verify.ready')} />
      ) : (
        <Alert tone="amber" title={t('verify.missing')}>
          <ul className="list-disc pl-5">
            {p.problems.map((x, i) => (
              <li key={i}>{problemText(t, x)}</li>
            ))}
          </ul>
        </Alert>
      )}
      <Card>
        <div className="mb-3 font-semibold">{t('verify.documents')}</div>
        <div className="divide-y divide-slate-100">
          {p.documents.map((d) => (
            <div
              key={d.id}
              className="flex flex-wrap items-center justify-between gap-2 py-2 text-sm"
            >
              <div>
                <div className="font-medium">{t(`doc.${d.kind}` as MessageKey)}</div>
                <div className="text-ink-soft">
                  {d.reference} · {t('verify.validUntil')} {date(d.validUntil, locale)}
                </div>
                {d.reviewNote && <div className="text-red-700">{d.reviewNote}</div>}
              </div>
              <StatusBadge status={d.status} />
            </div>
          ))}
        </div>
        <form
          className="mt-4 grid gap-3 border-t border-slate-100 pt-4 sm:grid-cols-4"
          onSubmit={async (e) => {
            e.preventDefault();
            try {
              await post('/api/carrier/documents', { ...f, validUntil: f.validUntil || null });
              setF({ ...f, reference: '', validUntil: '' });
              load();
            } catch (err) {
              setError(err);
            }
          }}
        >
          <Field label={t('verify.kind')}>
            <select
              className="input"
              value={f.kind}
              onChange={(e) => setF({ ...f, kind: e.target.value })}
            >
              {KINDS.map((k) => (
                <option key={k} value={k}>
                  {t(`doc.${k}` as MessageKey)}
                </option>
              ))}
            </select>
          </Field>
          <Field label={t('verify.reference')}>
            <input
              className="input"
              required
              value={f.reference}
              onChange={(e) => setF({ ...f, reference: e.target.value })}
            />
          </Field>
          <Field label={t('verify.validUntil')}>
            <input
              className="input"
              type="date"
              value={f.validUntil}
              onChange={(e) => setF({ ...f, validUntil: e.target.value })}
            />
          </Field>
          <div className="flex items-end">
            <button className="btn-primary w-full">{t('verify.submit')}</button>
          </div>
        </form>
        <p className="mt-2 text-xs text-ink-faint">{t('verify.uploadLater')}</p>
        <ErrorText error={error} />
      </Card>
    </div>
  );
}
