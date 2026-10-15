'use client';
import { useCallback, useEffect, useState } from 'react';
import { Alert, Badge, Card, ErrorText, Field } from '@/components/ui';
import { useI18n, type MessageKey } from '@/i18n';
import { api, post } from '@/lib/api';
import { dateTime, money } from '@/lib/format';

interface Procedure {
  id: string;
  kind: string;
  country: string | null;
  certainty: string;
  reason: string;
  status: string;
  statusReason: string | null;
  statusText: string | null;
  arrangement: string | null;
  reference: string | null;
  referenceType: string | null;
  requiredRoles: string[];
  requiredDocuments: string[];
  canSkip: boolean;
}
interface Overview {
  role: string;
  procedures: Procedure[];
  parties: Array<{
    id: string;
    role: string;
    name: string;
    email: string | null;
    eori: string | null;
    pending: boolean;
  }>;
  documents: Array<{
    id: string;
    docType: string;
    version: number;
    status: string;
    fileId: string;
    createdAt: string;
  }>;
  jobs: Array<{
    id: string;
    service: string;
    country: string;
    status: string;
    budgetMinor?: number;
    priceMinor?: number | null;
    provider: string | null;
    procedureIds?: string[];
    quotes: Array<{
      id: string;
      provider: string;
      totalMinor: number;
      overBudgetMinor: number;
      note: string | null;
      status: string;
      expiresAt: string;
    }>;
  }>;
  readiness: { required: boolean; ready: boolean };
}

const DOC_TYPES = [
  'commercial_invoice',
  'proforma_invoice',
  'packing_list',
  'origin_proof',
  'export_licence',
  'certificate',
  'power_of_attorney',
  'transit_document',
  'other',
];
const ROLES = [
  'exporter',
  'importer_of_record',
  'export_declarant',
  'import_declarant',
  'customs_representative',
  'transit_principal',
  'safety_security_filer',
  'movement_reference_party',
  'duty_payer',
  'import_vat_payer',
  'permits_party',
];
const NEXT: Record<string, string[]> = {
  BROKER_ASSIGNED: ['DECLARATION_PREPARING', 'DECLARATION_SUBMITTED'],
  DOCUMENTS_PENDING: ['DECLARATION_PREPARING'],
  DECLARATION_PREPARING: ['DECLARATION_SUBMITTED'],
  DECLARATION_SUBMITTED: ['DECLARATION_ACCEPTED', 'BORDER_ACTION_REQUIRED'],
  DECLARATION_ACCEPTED: [
    'RELEASED',
    'BORDER_ACTION_REQUIRED',
    'BORDER_HOLD',
    'PROCEDURE_COMPLETED',
  ],
  BORDER_ACTION_REQUIRED: [
    'DECLARATION_SUBMITTED',
    'DECLARATION_ACCEPTED',
    'BORDER_HOLD',
    'RELEASED',
  ],
  BORDER_HOLD: ['RELEASED', 'BORDER_ACTION_REQUIRED'],
  RELEASED: ['PROCEDURE_COMPLETED'],
};
const TONE: Record<string, 'gray' | 'amber' | 'blue' | 'green' | 'red'> = {
  NOT_REQUIRED: 'gray',
  INFORMATION_MISSING: 'amber',
  DOCUMENTS_PENDING: 'amber',
  BROKER_ASSIGNED: 'blue',
  DECLARATION_PREPARING: 'blue',
  DECLARATION_SUBMITTED: 'blue',
  DECLARATION_ACCEPTED: 'green',
  BORDER_ACTION_REQUIRED: 'red',
  BORDER_HOLD: 'red',
  RELEASED: 'green',
  PROCEDURE_COMPLETED: 'green',
};

function toBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = reject;
    r.readAsDataURL(file);
  });
}

/** Customs on a shipment: each step, who handles it, the responsible parties and the documents. */
export function CustomsPanel({ shipmentId }: { shipmentId: string }) {
  const { t, locale } = useI18n();
  const [o, setO] = useState<Overview | null>(null);
  const [error, setError] = useState<unknown>(null);
  const load = useCallback(
    () => api<Overview>(`/api/shipments/${shipmentId}/customs`).then(setO).catch(setError),
    [shipmentId],
  );
  useEffect(() => {
    load();
  }, [load]);
  const act = (fn: () => Promise<unknown>) => fn().then(load).catch(setError);
  if (!o || o.procedures.length === 0) return null;
  const isShipper = o.role === 'shipper';
  return (
    <Card className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="font-semibold">{t('customs.title')}</div>
        <Badge tone={o.readiness.ready ? 'green' : 'amber'}>
          {o.readiness.ready ? t('customs.readyForBorder') : t('customs.notReadyForBorder')}
        </Badge>
      </div>
      <p className="text-xs text-ink-faint">{t('customs.disclaimer')}</p>
      <ErrorText error={error} />
      {o.procedures.map((p) => (
        <ProcedureCard
          key={p.id}
          p={p}
          o={o}
          isShipper={isShipper}
          act={act}
          shipmentId={shipmentId}
        />
      ))}
      <div>
        <div className="mb-2 font-semibold">{t('customs.parties')}</div>
        {o.parties.length === 0 && (
          <p className="text-sm text-ink-faint">{t('customs.noParties')}</p>
        )}
        <ul className="space-y-1 text-sm">
          {o.parties.map((p) => (
            <li key={p.id} className="flex flex-wrap gap-2">
              <span className="font-medium">{t(`party.${p.role}` as MessageKey)}:</span> {p.name}{' '}
              {p.eori && <span className="font-mono text-xs">{p.eori}</span>}
              {p.pending && <Badge tone="amber">{t('customs.waitingConfirmation')}</Badge>}
            </li>
          ))}
        </ul>
        {isShipper && <PartyForm shipmentId={shipmentId} onDone={load} onError={setError} />}
      </div>
      <div>
        <div className="mb-2 font-semibold">{t('customs.documents')}</div>
        <ul className="space-y-1 text-sm">
          {o.documents
            .filter((d) => d.status === 'current')
            .map((d) => (
              <li key={d.id}>
                <a
                  className="text-brand"
                  href={`/api/files/${d.fileId}`}
                  target="_blank"
                  rel="noreferrer"
                >
                  {t(`doc.${d.docType}` as MessageKey)}
                </a>{' '}
                <span className="text-ink-faint">
                  v{d.version} · {dateTime(d.createdAt, locale)}
                </span>
              </li>
            ))}
        </ul>
        {(isShipper || o.role === 'customs') && (
          <DocumentForm shipmentId={shipmentId} onDone={load} onError={setError} />
        )}
      </div>
      {o.jobs.map((j) =>
        j.quotes
          .filter((q) => q.status === 'pending_customer')
          .map((q) => (
            <Alert
              key={q.id}
              tone="amber"
              title={t('customs.quoteTitle', {
                provider: q.provider,
                amount: money(q.totalMinor, 'EUR', locale),
              })}
            >
              {t('customs.quoteOver', { over: money(q.overBudgetMinor, 'EUR', locale) })} {q.note}
              <div className="mt-2">
                <button
                  className="btn-primary px-3 py-1.5 text-sm"
                  onClick={() =>
                    act(async () => {
                      const r = await post<{ payment?: { paymentRef: string } }>(
                        `/api/customs/quotes/${q.id}/approve`,
                      );
                      if (r.payment)
                        window.location.href = `/pay/${r.payment.paymentRef}?shipment=${shipmentId}`;
                    })
                  }
                >
                  {t('detail.approve')}
                </button>
              </div>
            </Alert>
          )),
      )}
    </Card>
  );
}

function ProcedureCard({
  p,
  o,
  isShipper,
  act,
  shipmentId,
}: {
  p: Procedure;
  o: Overview;
  isShipper: boolean;
  act(fn: () => Promise<unknown>): void;
  shipmentId: string;
}) {
  const { t, locale } = useI18n();
  const [arr, setArr] = useState<string>('marketplace');
  const [budget, setBudget] = useState('150');
  const [confirmation, setConfirmation] = useState('');
  const [next, setNext] = useState('');
  const [ref, setRef] = useState(p.reference ?? '');
  const job = o.jobs.find((j) => j.status !== 'expired' && j.status !== 'cancelled');
  const canChoose =
    isShipper &&
    ['INFORMATION_MISSING', 'DOCUMENTS_PENDING'].includes(p.status) &&
    (!p.arrangement || p.kind === 'check_route');
  const handlesIt =
    (isShipper && ['own_broker', 'responsible_party'].includes(p.arrangement ?? '')) ||
    (o.role === 'customs' && !isShipper);
  const options = NEXT[p.status] ?? [];
  return (
    <div className="rounded-xl border border-slate-200 p-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium">{t(`proc.${p.kind}` as MessageKey)}</span>
        {p.country && <span className="text-sm text-ink-soft">{p.country}</span>}
        <Badge tone={TONE[p.status] ?? 'gray'}>{t(`proc.status.${p.status}` as MessageKey)}</Badge>
        {p.arrangement && <Badge>{t(`customs.arr.${p.arrangement}` as MessageKey)}</Badge>}
        {p.reference && (
          <span className="font-mono text-xs">
            {p.referenceType} {p.reference}
          </span>
        )}
      </div>
      <p className="mt-1 text-sm text-ink-soft">{p.reason}</p>
      {p.statusText && <p className="mt-1 text-sm text-amber-800">{p.statusText}</p>}
      {job?.status === 'open' && isShipper && p.arrangement === 'marketplace' && (
        <p className="mt-1 text-sm text-ink-soft">{t('customs.searchingProvider')}</p>
      )}
      {job?.provider && p.arrangement === 'marketplace' && (
        <p className="mt-1 text-sm">
          {t('customs.handledBy', { name: job.provider })}
          {job.priceMinor ? ` · ${money(job.priceMinor, 'EUR', locale)}` : ''}
        </p>
      )}
      {canChoose && (
        <div className="mt-3 grid gap-2 sm:grid-cols-[1fr_140px_auto]">
          <select className="input" value={arr} onChange={(e) => setArr(e.target.value)}>
            {p.kind !== 'check_route' && (
              <option value="marketplace">{t('customs.arr.marketplace')}</option>
            )}
            {p.kind !== 'check_route' && (
              <option value="own_broker">{t('customs.arr.own_broker')}</option>
            )}
            {p.kind !== 'check_route' && (
              <option value="responsible_party">{t('customs.arr.responsible_party')}</option>
            )}
            {p.canSkip && <option value="not_required">{t('customs.arr.not_required')}</option>}
          </select>
          {arr === 'marketplace' && (
            <input
              className="input"
              inputMode="decimal"
              value={budget}
              onChange={(e) => setBudget(e.target.value)}
              aria-label={t('customs.budget')}
              placeholder={t('customs.budget')}
            />
          )}
          {arr === 'not_required' && (
            <input
              className="input"
              value={confirmation}
              onChange={(e) => setConfirmation(e.target.value)}
              placeholder={t('customs.whyNotNeeded')}
            />
          )}
          <button
            className="btn-primary"
            onClick={() =>
              act(async () => {
                const r = await post<{ payment?: { paymentRef: string } }>(
                  `/api/customs/procedures/${p.id}/arrange`,
                  {
                    arrangement: arr,
                    ...(arr === 'marketplace'
                      ? { budgetMinor: Math.round(Number(budget.replace(',', '.')) * 100) }
                      : {}),
                    ...(arr === 'not_required' ? { confirmation } : {}),
                  },
                );
                if (r.payment)
                  window.location.href = `/pay/${r.payment.paymentRef}?shipment=${shipmentId}`;
              })
            }
          >
            {t('common.save')}
          </button>
        </div>
      )}
      {handlesIt && options.length > 0 && (
        <div className="mt-3 grid gap-2 sm:grid-cols-[1fr_1fr_auto]">
          <select className="input" value={next} onChange={(e) => setNext(e.target.value)}>
            <option value="">{t('customs.moveTo')}</option>
            {options.map((s) => (
              <option key={s} value={s}>
                {t(`proc.status.${s}` as MessageKey)}
              </option>
            ))}
          </select>
          <input
            className="input font-mono"
            value={ref}
            onChange={(e) => setRef(e.target.value)}
            placeholder={t('customs.reference')}
          />
          <button
            className="btn-secondary"
            disabled={!next}
            onClick={() =>
              act(() =>
                post(`/api/customs/procedures/${p.id}/status`, {
                  status: next,
                  ...(ref ? { reference: ref, referenceType: 'MRN' } : {}),
                }),
              )
            }
          >
            {t('customs.update')}
          </button>
        </div>
      )}
    </div>
  );
}

function PartyForm({
  shipmentId,
  onDone,
  onError,
}: {
  shipmentId: string;
  onDone(): void;
  onError(e: unknown): void;
}) {
  const { t } = useI18n();
  const [role, setRole] = useState('exporter');
  const [self, setSelf] = useState(true);
  const [f, setF] = useState({ name: '', email: '', eori: '' });
  return (
    <form
      className="mt-3 grid gap-2 sm:grid-cols-2"
      onSubmit={async (e) => {
        e.preventDefault();
        try {
          await post(
            `/api/shipments/${shipmentId}/customs/parties`,
            self
              ? { role, self: true }
              : { role, self: false, name: f.name, email: f.email, eori: f.eori || null },
          );
          onDone();
        } catch (err) {
          onError(err);
        }
      }}
    >
      <Field label={t('customs.role')}>
        <select className="input" value={role} onChange={(e) => setRole(e.target.value)}>
          {ROLES.map((r) => (
            <option key={r} value={r}>
              {t(`party.${r}` as MessageKey)}
            </option>
          ))}
        </select>
      </Field>
      <label className="flex items-end gap-2 pb-3 text-sm">
        <input type="checkbox" checked={self} onChange={(e) => setSelf(e.target.checked)} />
        {t('customs.ourCompany')}
      </label>
      {!self && (
        <>
          <Field label={t('register.company')}>
            <input
              className="input"
              required
              value={f.name}
              onChange={(e) => setF({ ...f, name: e.target.value })}
            />
          </Field>
          <Field label={t('auth.email')} hint={t('customs.confirmByEmail')}>
            <input
              className="input"
              type="email"
              required
              value={f.email}
              onChange={(e) => setF({ ...f, email: e.target.value })}
            />
          </Field>
          <Field label="EORI">
            <input
              className="input font-mono"
              value={f.eori}
              onChange={(e) => setF({ ...f, eori: e.target.value })}
            />
          </Field>
        </>
      )}
      <div className="flex items-end">
        <button className="btn-secondary">{t('customs.nameParty')}</button>
      </div>
    </form>
  );
}

function DocumentForm({
  shipmentId,
  onDone,
  onError,
}: {
  shipmentId: string;
  onDone(): void;
  onError(e: unknown): void;
}) {
  const { t } = useI18n();
  const [type, setType] = useState('commercial_invoice');
  const [busy, setBusy] = useState(false);
  return (
    <div className="mt-3 flex flex-wrap items-center gap-2">
      <select className="input w-auto" value={type} onChange={(e) => setType(e.target.value)}>
        {DOC_TYPES.map((d) => (
          <option key={d} value={d}>
            {t(`doc.${d}` as MessageKey)}
          </option>
        ))}
      </select>
      <label className="btn-secondary cursor-pointer">
        {busy ? '…' : t('customs.upload')}
        <input
          type="file"
          accept="application/pdf,image/jpeg,image/png"
          className="hidden"
          onChange={async (e) => {
            const file = e.target.files?.[0];
            if (!file) return;
            setBusy(true);
            try {
              await post(`/api/shipments/${shipmentId}/customs/documents`, {
                docType: type,
                contentType: file.type,
                data: await toBase64(file),
              });
              onDone();
            } catch (err) {
              onError(err);
            } finally {
              setBusy(false);
              e.target.value = '';
            }
          }}
        />
      </label>
    </div>
  );
}
