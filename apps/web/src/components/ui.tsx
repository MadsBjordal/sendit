'use client';
import type { ReactNode } from 'react';
import { useI18n, type MessageKey } from '@/i18n';
import { ApiError } from '@/lib/api';

export function Card({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <div className={`card ${className}`}>{children}</div>;
}

export function Field({
  label,
  hint,
  children,
  error,
}: {
  label: ReactNode;
  hint?: ReactNode;
  children: ReactNode;
  error?: string | null;
}) {
  return (
    <label className="block">
      <span className="label">{label}</span>
      {children}
      {hint && !error && <span className="mt-1 block text-xs text-ink-faint">{hint}</span>}
      {error && <span className="mt-1 block text-xs text-red-600">{error}</span>}
    </label>
  );
}

const tones = {
  gray: 'bg-slate-100 text-slate-700',
  blue: 'bg-blue-50 text-blue-700',
  green: 'bg-emerald-50 text-emerald-700',
  amber: 'bg-amber-50 text-amber-800',
  red: 'bg-red-50 text-red-700',
} as const;

export function Badge({
  tone = 'gray',
  children,
}: {
  tone?: keyof typeof tones;
  children: ReactNode;
}) {
  return (
    <span
      className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-semibold ${tones[tone]}`}
    >
      {children}
    </span>
  );
}

export function Alert({
  tone = 'blue',
  title,
  children,
}: {
  tone?: keyof typeof tones;
  title?: ReactNode;
  children?: ReactNode;
}) {
  const border = {
    gray: 'border-slate-200',
    blue: 'border-blue-200',
    green: 'border-emerald-200',
    amber: 'border-amber-200',
    red: 'border-red-200',
  }[tone];
  return (
    <div
      role={tone === 'red' ? 'alert' : 'status'}
      className={`rounded-xl border ${border} ${tones[tone]} px-4 py-3 text-sm`}
    >
      {title && <div className="font-semibold">{title}</div>}
      {children && <div className={title ? 'mt-0.5' : ''}>{children}</div>}
    </div>
  );
}

export function Spinner({ label }: { label?: string }) {
  return (
    <div className="flex items-center gap-3 py-8 text-ink-soft" role="status">
      <span className="h-5 w-5 animate-spin rounded-full border-2 border-slate-300 border-t-brand" />
      {label}
    </div>
  );
}

export function Empty({ title, children }: { title: ReactNode; children?: ReactNode }) {
  return (
    <div className="rounded-2xl border border-dashed border-slate-300 bg-white px-6 py-12 text-center">
      <div className="text-base font-semibold">{title}</div>
      {children && <div className="mx-auto mt-2 max-w-md text-sm text-ink-soft">{children}</div>}
    </div>
  );
}

export function PageTitle({
  title,
  subtitle,
  actions,
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div className="mb-6 flex flex-wrap items-end justify-between gap-3">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">{title}</h1>
        {subtitle && <p className="mt-1 text-ink-soft">{subtitle}</p>}
      </div>
      {actions}
    </div>
  );
}

/** Shows an API error in the person's language when we know the code, else the server's message. */
export function ErrorText({ error }: { error: unknown }) {
  const { t } = useI18n();
  if (!error) return null;
  if (error instanceof ApiError) {
    const key = `error.${error.code}` as MessageKey;
    const known = t(key);
    const details = Array.isArray(error.details)
      ? (error.details as Array<{ path?: string; message?: string; code?: string }>)
      : [];
    return (
      <Alert tone="red" title={known !== key ? known : error.message}>
        {details.length > 0 && (
          <ul className="mt-1 list-disc pl-5">
            {details.slice(0, 6).map((d, i) => (
              <li key={i}>{d.path ? `${d.path}: ${d.message}` : problemText(t, d)}</li>
            ))}
          </ul>
        )}
      </Alert>
    );
  }
  return <Alert tone="red" title={t('error.generic')} />;
}

export function problemText(
  t: ReturnType<typeof useI18n>['t'],
  p: { code?: string; [k: string]: unknown },
) {
  const key = `problem.${p.code}` as MessageKey;
  const text = t(key, Object.fromEntries(Object.entries(p).map(([k, v]) => [k, String(v)])));
  return text === key ? String(p.code) : text;
}

const STATUS_TONE: Record<string, keyof typeof tones> = {
  draft: 'gray',
  awaiting_payment: 'amber',
  searching: 'blue',
  booked: 'green',
  in_transit: 'blue',
  delivered: 'green',
  completed: 'green',
  expired: 'gray',
  cancelled: 'gray',
  pending_customer: 'amber',
  approved: 'blue',
  rejected: 'red',
  superseded: 'gray',
  withdrawn: 'gray',
  pending: 'amber',
  succeeded: 'green',
  failed: 'red',
  verified: 'green',
  pending_verification: 'amber',
  suspended: 'red',
};

export function StatusBadge({ status }: { status: string }) {
  const { t } = useI18n();
  const key = `status.${status}` as MessageKey;
  const text = t(key);
  return <Badge tone={STATUS_TONE[status] ?? 'gray'}>{text === key ? status : text}</Badge>;
}

export function TestBanner() {
  const { t } = useI18n();
  return (
    <div className="bg-amber-400 px-4 py-1 text-center text-xs font-semibold text-amber-950">
      {t('test.banner')}
    </div>
  );
}
