'use client';
import { useEffect, useState } from 'react';
import { useRequireAuth } from '@/components/auth';
import { Alert, Card, ErrorText, Field, PageTitle, Spinner } from '@/components/ui';
import { useI18n, type MessageKey } from '@/i18n';
import { api, post } from '@/lib/api';

const ROLES = ['admin', 'dispatcher', 'finance', 'member', 'driver'] as const;

export default function Team() {
  const { me } = useRequireAuth(['shipper', 'carrier', 'customs_provider']);
  const { t } = useI18n();
  const [members, setMembers] = useState<Array<{
    id: string;
    name: string;
    email: string;
    role: string;
    active: boolean;
  }> | null>(null);
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<string>('member');
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<unknown>(null);
  useEffect(() => {
    if (me) api('/api/org/members').then(setMembers).catch(setError);
  }, [me]);
  if (!me || !members) return <Spinner />;
  const canManage = me.role === 'owner' || me.role === 'admin';
  return (
    <div className="space-y-6">
      <PageTitle title={t('nav.team')} subtitle={me.org?.name} />
      <Card>
        <div className="divide-y divide-slate-100">
          {members.map((m) => (
            <div key={m.id} className="flex items-center justify-between py-2">
              <div>
                <div className="font-medium">{m.name}</div>
                <div className="text-sm text-ink-soft">{m.email}</div>
              </div>
              <span className="text-sm text-ink-soft">{t(`role.${m.role}` as MessageKey)}</span>
            </div>
          ))}
        </div>
      </Card>
      {canManage && (
        <Card>
          <div className="mb-3 font-semibold">{t('team.invite')}</div>
          <form
            className="grid gap-3 sm:grid-cols-[1fr_200px_auto]"
            onSubmit={async (e) => {
              e.preventDefault();
              try {
                await post('/api/org/invitations', { email, role });
                setSent(true);
                setEmail('');
              } catch (err) {
                setError(err);
              }
            }}
          >
            <Field label={t('auth.email')}>
              <input
                className="input"
                type="email"
                required
                value={email}
                onChange={(e) => (setEmail(e.target.value), setSent(false))}
              />
            </Field>
            <Field label={t('team.role')}>
              <select className="input" value={role} onChange={(e) => setRole(e.target.value)}>
                {ROLES.map((r) => (
                  <option key={r} value={r}>
                    {t(`role.${r}` as MessageKey)}
                  </option>
                ))}
              </select>
            </Field>
            <div className="flex items-end">
              <button className="btn-primary">{t('team.send')}</button>
            </div>
          </form>
          {sent && (
            <div className="mt-3">
              <Alert tone="green" title={t('team.sent')} />
            </div>
          )}
          <ErrorText error={error} />
        </Card>
      )}
    </div>
  );
}
