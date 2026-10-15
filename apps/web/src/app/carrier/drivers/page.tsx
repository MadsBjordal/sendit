'use client';
import { useEffect, useState } from 'react';
import { useRequireAuth } from '@/components/auth';
import { Alert, Badge, Card, Empty, ErrorText, Field, PageTitle, Spinner } from '@/components/ui';
import { useI18n } from '@/i18n';
import { api, post } from '@/lib/api';
import { date, dateTime } from '@/lib/format';

interface Driver {
  id: string;
  name: string;
  email: string;
  phone: string | null;
  licenceCategories: string[];
  licenceValidUntil: string | null;
  cpcValidUntil: string | null;
  active: boolean;
  linked: boolean;
  lastPosition: { at: string } | null;
  activeJobs: string[];
}
const CATS = ['B', 'C1', 'C', 'C1E', 'CE'] as const;

export default function Drivers() {
  const { me } = useRequireAuth('carrier');
  const { t, locale } = useI18n();
  const [list, setList] = useState<Driver[] | null>(null);
  const [adding, setAdding] = useState(false);
  const [f, setF] = useState({
    name: '',
    email: '',
    phone: '',
    cats: ['CE'] as string[],
    licence: '',
    cpc: '',
  });
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const load = () => api<Driver[]>('/api/carrier/drivers').then(setList).catch(setError);
  useEffect(() => {
    if (me) load();
  }, [me]);
  if (!me) return <Spinner />;
  return (
    <div className="space-y-5">
      <PageTitle
        title={t('nav.drivers')}
        subtitle={t('drivers.subtitle')}
        actions={
          <button className="btn-primary" onClick={() => setAdding(true)}>
            + {t('drivers.add')}
          </button>
        }
      />
      <ErrorText error={error} />
      {sent && <Alert tone="green" title={t('drivers.invited')} />}
      {adding && (
        <Card>
          <form
            className="space-y-3"
            onSubmit={async (e) => {
              e.preventDefault();
              try {
                await post('/api/carrier/drivers', {
                  name: f.name,
                  email: f.email,
                  phone: f.phone || null,
                  licenceCategories: f.cats,
                  licenceValidUntil: f.licence || null,
                  cpcValidUntil: f.cpc || null,
                });
                setAdding(false);
                setSent(true);
                load();
              } catch (err) {
                setError(err);
              }
            }}
          >
            <div className="grid gap-3 sm:grid-cols-3">
              <Field label={t('register.name')}>
                <input
                  className="input"
                  required
                  value={f.name}
                  onChange={(e) => setF({ ...f, name: e.target.value })}
                />
              </Field>
              <Field label={t('auth.email')}>
                <input
                  className="input"
                  type="email"
                  required
                  value={f.email}
                  onChange={(e) => setF({ ...f, email: e.target.value })}
                />
              </Field>
              <Field label={t('book.phone')}>
                <input
                  className="input"
                  type="tel"
                  value={f.phone}
                  onChange={(e) => setF({ ...f, phone: e.target.value })}
                />
              </Field>
            </div>
            <div>
              <span className="label">{t('drivers.categories')}</span>
              <div className="flex flex-wrap gap-2">
                {CATS.map((c) => (
                  <label
                    key={c}
                    className="flex items-center gap-1 rounded-lg border border-slate-200 px-2 py-1 text-sm"
                  >
                    <input
                      type="checkbox"
                      checked={f.cats.includes(c)}
                      onChange={(e) =>
                        setF({
                          ...f,
                          cats: e.target.checked ? [...f.cats, c] : f.cats.filter((x) => x !== c),
                        })
                      }
                    />
                    {c}
                  </label>
                ))}
              </div>
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label={t('drivers.licenceUntil')}>
                <input
                  className="input"
                  type="date"
                  value={f.licence}
                  onChange={(e) => setF({ ...f, licence: e.target.value })}
                />
              </Field>
              <Field label={t('drivers.cpcUntil')} hint={t('drivers.cpcHint')}>
                <input
                  className="input"
                  type="date"
                  value={f.cpc}
                  onChange={(e) => setF({ ...f, cpc: e.target.value })}
                />
              </Field>
            </div>
            <div className="flex gap-2">
              <button type="button" className="btn-secondary" onClick={() => setAdding(false)}>
                {t('common.cancel')}
              </button>
              <button className="btn-primary" disabled={f.cats.length === 0}>
                {t('drivers.addAndInvite')}
              </button>
            </div>
          </form>
        </Card>
      )}
      {!list && <Spinner />}
      {list?.length === 0 && !adding && (
        <Empty title={t('drivers.empty')}>{t('drivers.emptyText')}</Empty>
      )}
      <div className="grid gap-3 md:grid-cols-2">
        {list?.map((d) => (
          <Card key={d.id}>
            <div className="flex items-start justify-between gap-2">
              <div>
                <div className="font-semibold">{d.name}</div>
                <div className="text-sm text-ink-soft">
                  {d.email} {d.phone && `· ${d.phone}`}
                </div>
              </div>
              <div className="flex flex-col items-end gap-1">
                {!d.linked ? (
                  <Badge tone="amber">{t('drivers.notJoined')}</Badge>
                ) : d.activeJobs.length ? (
                  <Badge tone="blue">{t('drivers.onJob')}</Badge>
                ) : (
                  <Badge tone="green">{t('jobs.available')}</Badge>
                )}
              </div>
            </div>
            <div className="mt-2 flex flex-wrap gap-1.5 text-xs">
              {d.licenceCategories.map((c) => (
                <Badge key={c}>{c}</Badge>
              ))}
              <Badge
                tone={
                  d.licenceValidUntil && d.licenceValidUntil > new Date().toISOString()
                    ? 'gray'
                    : 'red'
                }
              >
                {t('drivers.licence')} {date(d.licenceValidUntil, locale)}
              </Badge>
              <Badge
                tone={
                  d.cpcValidUntil && d.cpcValidUntil > new Date().toISOString() ? 'gray' : 'amber'
                }
              >
                CPC {date(d.cpcValidUntil, locale)}
              </Badge>
            </div>
            {d.lastPosition && (
              <div className="mt-2 text-xs text-ink-faint">
                {t('drivers.lastSeen', { at: dateTime(d.lastPosition.at, locale) })}
              </div>
            )}
          </Card>
        ))}
      </div>
    </div>
  );
}
