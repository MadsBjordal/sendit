'use client';
import { useParams, useRouter } from 'next/navigation';
import { useState } from 'react';
import { useRequireAuth } from '@/components/auth';
import { Alert, Card, ErrorText, Field, PageTitle, Spinner } from '@/components/ui';
import { useI18n, type MessageKey } from '@/i18n';
import { post } from '@/lib/api';

function toBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = reject;
    r.readAsDataURL(file);
  });
}

export default function Dispute() {
  const { me } = useRequireAuth('shipper');
  const { t } = useI18n();
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const [kind, setKind] = useState('damage');
  const [description, setDescription] = useState('');
  const [photos, setPhotos] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  if (!me) return <Spinner />;
  return (
    <div className="max-w-2xl space-y-4">
      <PageTitle title={t('dispute.title')} subtitle={t('dispute.subtitle')} />
      <Alert tone="blue">{t('dispute.holdNote')}</Alert>
      <Card className="space-y-4">
        <Field label={t('dispute.kind')}>
          <select className="input" value={kind} onChange={(e) => setKind(e.target.value)}>
            {['damage', 'shortage', 'not_delivered', 'late', 'other'].map((k) => (
              <option key={k} value={k}>
                {t(`dispute.kind.${k}` as MessageKey)}
              </option>
            ))}
          </select>
        </Field>
        <Field label={t('dispute.description')} hint={t('dispute.descriptionHint')}>
          <textarea
            className="input"
            rows={5}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
          />
        </Field>
        <div>
          <span className="label">{t('dispute.photos')}</span>
          <input
            type="file"
            accept="image/jpeg,image/png,application/pdf"
            onChange={async (e) => {
              const f = e.target.files?.[0];
              if (!f) return;
              try {
                const r = await post<{ id: string }>(`/api/shipments/${id}/files/base64`, {
                  kind: 'evidence',
                  contentType: f.type,
                  data: await toBase64(f),
                });
                setPhotos([...photos, r.id]);
              } catch (err) {
                setError(err);
              }
              e.target.value = '';
            }}
          />
          {photos.length > 0 && (
            <p className="mt-1 text-sm text-ink-soft">
              {t('dispute.attached', { n: photos.length })}
            </p>
          )}
        </div>
        <ErrorText error={error} />
        <button
          className="btn-primary"
          disabled={busy || description.trim().length < 10}
          onClick={async () => {
            setBusy(true);
            try {
              await post(`/api/shipments/${id}/disputes`, {
                kind,
                description,
                evidenceFileIds: photos,
              });
              router.push(`/shipments/${id}`);
            } catch (err) {
              setError(err);
              setBusy(false);
            }
          }}
        >
          {t('dispute.submit')}
        </button>
      </Card>
    </div>
  );
}
