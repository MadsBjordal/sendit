'use client';
import { useEffect, useState, type FormEvent } from 'react';
import { useRequireAuth } from '@/components/auth';
import { Alert, Card, ErrorText, PageTitle, Spinner } from '@/components/ui';
import { LOCALE_NAMES, useI18n, type Locale, type MessageKey } from '@/i18n';
import { api } from '@/lib/api';

export default function Settings() {
  const { me } = useRequireAuth();
  const { t, setLocale } = useI18n();
  const [s, setS] = useState<{
    locale: Locale;
    notificationPrefs: Record<string, { email: boolean }>;
    emailKinds: string[];
  } | null>(null);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<unknown>(null);
  useEffect(() => {
    if (me) api('/api/me/settings').then(setS).catch(setError);
  }, [me]);
  if (!me || !s) return <Spinner />;
  const save = async () => {
    try {
      await api('/api/me/settings', {
        method: 'PUT',
        body: { locale: s.locale, notificationPrefs: s.notificationPrefs },
      });
      setLocale(s.locale);
      setSaved(true);
    } catch (e) {
      setError(e);
    }
  };
  return (
    <div className="max-w-2xl space-y-5">
      <PageTitle title={t('nav.settings')} subtitle={me.user.email} />
      <Card>
        <label className="label">{t('common.language')}</label>
        <select
          className="input"
          value={s.locale}
          onChange={(e) => (setS({ ...s, locale: e.target.value as Locale }), setSaved(false))}
        >
          {Object.entries(LOCALE_NAMES).map(([k, v]) => (
            <option key={k} value={k}>
              {v}
            </option>
          ))}
        </select>
      </Card>
      <Card>
        <div className="mb-1 font-semibold">{t('settings.emails')}</div>
        <p className="mb-3 text-sm text-ink-soft">{t('settings.emailsText')}</p>
        <div className="space-y-2">
          {s.emailKinds.map((k) => (
            <label key={k} className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={s.notificationPrefs[k]?.email !== false}
                onChange={(e) => (
                  setS({
                    ...s,
                    notificationPrefs: { ...s.notificationPrefs, [k]: { email: e.target.checked } },
                  }),
                  setSaved(false)
                )}
              />
              {t(`notif.${k}` as MessageKey)}
            </label>
          ))}
        </div>
      </Card>
      <PasswordCard />
      <Card>
        <div className="mb-1 font-semibold">{t('privacy.title')}</div>
        <p className="mb-3 text-sm text-ink-soft">{t('privacy.text')}</p>
        <div className="flex flex-wrap gap-2">
          <a className="btn-secondary" href="/api/me/data-export">
            {t('privacy.download')}
          </a>
          <button
            className="btn-danger"
            onClick={async () => {
              if (!confirm(t('privacy.eraseConfirm'))) return;
              try {
                await api('/api/me/erasure-request', { method: 'POST', body: { note: null } });
                alert(t('privacy.eraseRequested'));
              } catch (e) {
                setError(e);
              }
            }}
          >
            {t('privacy.erase')}
          </button>
        </div>
      </Card>
      <ErrorText error={error} />
      {saved && <Alert tone="green" title={t('settings.saved')} />}
      <button className="btn-primary" onClick={save}>
        {t('common.save')}
      </button>
    </div>
  );
}

/** Change my own password: the current one first. Other browsers are logged out, this one stays. */
function PasswordCard() {
  const { t } = useI18n();
  const empty = { currentPassword: '', newPassword: '', repeat: '' };
  const [f, setF] = useState(empty);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const mismatch = f.repeat !== '' && f.repeat !== f.newPassword;
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (mismatch) return;
    setBusy(true);
    setError(null);
    try {
      await api('/api/auth/change-password', {
        method: 'POST',
        body: { currentPassword: f.currentPassword, newPassword: f.newPassword },
      });
      setF(empty);
      setDone(true);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };
  const field = (k: keyof typeof empty, label: MessageKey, autoComplete: string) => (
    <div>
      <label className="label" htmlFor={`pw-${k}`}>
        {t(label)}
      </label>
      <input
        id={`pw-${k}`}
        className="input"
        type="password"
        autoComplete={autoComplete}
        value={f[k]}
        onChange={(e) => (setF({ ...f, [k]: e.target.value }), setDone(false))}
      />
    </div>
  );
  return (
    <Card>
      <form onSubmit={submit} className="space-y-3">
        <div>
          <div className="mb-1 font-semibold">{t('settings.password')}</div>
          <p className="text-sm text-ink-soft">{t('settings.passwordText')}</p>
        </div>
        {field('currentPassword', 'settings.currentPassword', 'current-password')}
        {field('newPassword', 'settings.newPassword', 'new-password')}
        {field('repeat', 'settings.repeatPassword', 'new-password')}
        {mismatch && <p className="text-sm text-red-700">{t('settings.passwordMismatch')}</p>}
        <ErrorText error={error} />
        {done && <Alert tone="green" title={t('settings.passwordChangedHere')} />}
        <button
          className="btn-primary"
          disabled={
            busy || !f.currentPassword || f.newPassword.length < 12 || f.repeat !== f.newPassword
          }
        >
          {t('settings.changePassword')}
        </button>
      </form>
    </Card>
  );
}
