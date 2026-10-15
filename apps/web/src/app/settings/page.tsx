'use client';
import { useEffect, useState } from 'react';
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
      <ErrorText error={error} />
      {saved && <Alert tone="green" title={t('settings.saved')} />}
      <button className="btn-primary" onClick={save}>
        {t('common.save')}
      </button>
    </div>
  );
}
