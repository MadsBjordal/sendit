import * as ImagePicker from 'expo-image-picker';
import { useEffect, useState } from 'react';
import { Image, Linking, Platform, Pressable, ScrollView, Switch, Text, View } from 'react-native';
import { call, type Job, type Place } from '../api';
import { t } from '../i18n';
import { signaturePng, toBase64, type Stroke } from '../png';
import { Button, Card, colors, Input, Label, Note, s } from '../ui';
import { SignaturePad } from './SignaturePad';

export type Step =
  | 'pickup.arrived'
  | 'pickup.loaded'
  | 'pickup.departed'
  | 'border.crossed'
  | 'delay.reported'
  | 'delivery.arrived'
  | 'delivery.delivered';

export interface Capture {
  action: Step;
  fields: Record<string, unknown>;
  photos: Array<{ base64: string; contentType: string }>;
  signature: { base64: string } | null;
}

const STEP_LABEL: Record<Step, Parameters<typeof t>[0]> = {
  'pickup.arrived': 'step.arrivedPickup',
  'pickup.loaded': 'step.loaded',
  'pickup.departed': 'step.departed',
  'border.crossed': 'step.border',
  'delay.reported': 'step.delay',
  'delivery.arrived': 'step.arrivedDelivery',
  'delivery.delivered': 'step.delivered',
};

function nextSteps(job: Job): Step[] {
  const d = new Set(job.done);
  if (!['booked', 'in_transit'].includes(job.status)) return [];
  if (!d.has('pickup.loaded'))
    return d.has('pickup.arrived')
      ? ['pickup.loaded', 'delay.reported']
      : ['pickup.arrived', 'pickup.loaded', 'delay.reported'];
  if (!d.has('delivery.delivered')) {
    const out: Step[] = [];
    if (!d.has('pickup.departed') && !d.has('delivery.arrived')) out.push('pickup.departed');
    if (!d.has('delivery.arrived')) out.push('delivery.arrived');
    out.push('delivery.delivered', 'border.crossed', 'delay.reported');
    return out;
  }
  return [];
}

function PlaceCard({ title, p }: { title: string; p: Place }) {
  const fmt = (iso: string) =>
    new Date(iso).toLocaleString(undefined, {
      weekday: 'short',
      day: 'numeric',
      month: 'short',
      hour: '2-digit',
      minute: '2-digit',
    });
  return (
    <Card>
      <Label>{title}</Label>
      <Text style={s.h2}>{p.addressLine}</Text>
      <Text style={s.text}>
        {p.postcode} {p.city}, {p.country}
      </Text>
      <Text style={s.muted}>
        {t('job.window', { from: fmt(p.windowStart), to: fmt(p.windowEnd) })}
      </Text>
      {(p.hasForklift || p.hasLoadingDock) && (
        <Text style={s.muted}>
          {[p.hasForklift && t('job.forklift'), p.hasLoadingDock && t('job.dock')]
            .filter(Boolean)
            .join(' · ')}
        </Text>
      )}
      {p.instructions && <Note>{p.instructions}</Note>}
      <View style={[s.row, { marginTop: 6 }]}>
        <View style={{ flex: 1 }}>
          <Button
            kind="secondary"
            title={t('job.navigate')}
            onPress={() =>
              Linking.openURL(
                `https://www.google.com/maps/dir/?api=1&destination=${p.lat},${p.lng}`,
              )
            }
          />
        </View>
        {p.contactPhone && (
          <View style={{ flex: 1 }}>
            <Button
              kind="secondary"
              title={`${t('job.call')} ${p.contactName ?? ''}`}
              onPress={() => Linking.openURL(`tel:${p.contactPhone}`)}
            />
          </View>
        )}
      </View>
    </Card>
  );
}

interface Readiness {
  required: boolean;
  ready: boolean;
  missing: string[];
  references: Array<{ label: string; value: string }>;
  contacts: Array<{ name: string; phone: string | null }>;
}

function BorderCard({ job }: { job: Job }) {
  const [r, setR] = useState<Readiness | null>(null);
  useEffect(() => {
    call<Readiness>(`/api/shipments/${job.shipmentId}/border-readiness`)
      .then((x) => x.status === 200 && setR(x.data))
      .catch(() => {});
  }, [job.shipmentId]);
  if (job.customs === 'not_required' && !r?.required) return null;
  return (
    <Card>
      <Label>{t('border.title')}</Label>
      {!r ? (
        <Note tone="warn">{t('job.customs')}</Note>
      ) : !r.required ? (
        <Note tone="ok">{t('border.none')}</Note>
      ) : (
        <>
          <Note tone={r.ready ? 'ok' : 'error'}>
            {r.ready ? t('border.ready') : t('border.missing')}
          </Note>
          {r.missing.map((m) => (
            <Text key={m} style={{ color: colors.red }}>
              • {m}
            </Text>
          ))}
          {r.references.length > 0 && <Text style={s.muted}>{t('border.references')}</Text>}
          {r.references.map((x) => (
            <Text key={x.label + x.value} style={s.text}>
              {x.label}: <Text style={{ fontWeight: '800' }}>{x.value}</Text>
            </Text>
          ))}
          {r.contacts.map((c) => (
            <Pressable key={c.name} onPress={() => c.phone && Linking.openURL(`tel:${c.phone}`)}>
              <Text style={{ color: colors.brand }}>
                {t('border.contact')}: {c.name} {c.phone}
              </Text>
            </Pressable>
          ))}
        </>
      )}
    </Card>
  );
}

export function JobScreen({
  job,
  onBack,
  onCapture,
  moving,
  tracking,
}: {
  job: Job;
  onBack(): void;
  onCapture(c: Capture): Promise<void>;
  moving: boolean;
  tracking: 'on' | 'denied' | 'off';
}) {
  const [step, setStep] = useState<Step | null>(null);
  const steps = nextSteps(job);
  if (step)
    return (
      <StepForm
        job={job}
        step={step}
        onCancel={() => setStep(null)}
        onSave={async (c) => (await onCapture(c), setStep(null))}
      />
    );
  return (
    <ScrollView contentContainerStyle={s.scroll}>
      <Pressable onPress={onBack} accessibilityRole="button">
        <Text style={{ color: colors.brand, fontSize: 16 }}>‹ {t('job.back')}</Text>
      </Pressable>
      <Text style={s.muted}>{job.number}</Text>
      <Text style={s.h1}>
        {job.pickup.city} → {job.delivery.city}
      </Text>
      {tracking === 'on' && <Note>{t('tracking.on')}</Note>}
      {tracking === 'denied' && <Note tone="warn">{t('tracking.denied')}</Note>}
      {moving && (
        <Note tone="error">
          {t('safety.title')}. {t('safety.text')}
        </Note>
      )}
      {steps.map((st, i) => (
        <Button
          key={st}
          title={t(STEP_LABEL[st])}
          kind={i === 0 ? 'primary' : 'secondary'}
          disabled={moving}
          onPress={() => setStep(st)}
        />
      ))}
      <PlaceCard title={t('job.pickup')} p={job.pickup} />
      <PlaceCard title={t('job.delivery')} p={job.delivery} />
      <Card>
        <Label>{t('job.cargo')}</Label>
        <Text style={s.text}>{job.cargo.description}</Text>
        <Text style={s.muted}>
          {t('job.units', { n: job.cargo.units, kg: job.cargo.weightKg })}
        </Text>
        {job.cargo.temperature && (
          <Text style={s.muted}>
            {job.cargo.temperature.minC}–{job.cargo.temperature.maxC} °C
          </Text>
        )}
      </Card>
      <BorderCard job={job} />
    </ScrollView>
  );
}

function StepForm({
  job,
  step,
  onCancel,
  onSave,
}: {
  job: Job;
  step: Step;
  onCancel(): void;
  onSave(c: Capture): Promise<void>;
}) {
  const [count, setCount] = useState(String(job.cargo.units));
  const [difference, setDifference] = useState('');
  const [recipient, setRecipient] = useState('');
  const [strokes, setStrokes] = useState<Stroke[]>([]);
  const [box, setBox] = useState({ w: 300, h: 180 });
  const [photos, setPhotos] = useState<Array<{ base64: string; contentType: string; uri: string }>>(
    [],
  );
  const [damage, setDamage] = useState(false);
  const [damageNote, setDamageNote] = useState('');
  const [minutes, setMinutes] = useState('30');
  const [reason, setReason] = useState('');
  const [country, setCountry] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const counting = step === 'pickup.loaded' || step === 'delivery.delivered';
  const n = Number(count);

  const takePhoto = async () => {
    const opts: ImagePicker.ImagePickerOptions = {
      quality: 0.5,
      base64: true,
      mediaTypes: ['images'],
    };
    let res: ImagePicker.ImagePickerResult;
    if (Platform.OS === 'web') res = await ImagePicker.launchImageLibraryAsync(opts);
    else {
      const perm = await ImagePicker.requestCameraPermissionsAsync();
      if (!perm.granted) return;
      res = await ImagePicker.launchCameraAsync(opts);
    }
    const a = res.assets?.[0];
    if (!a) return;
    const base64 = a.base64 ?? a.uri.split(',')[1] ?? '';
    setPhotos([...photos, { base64, contentType: a.mimeType ?? 'image/jpeg', uri: a.uri }]);
  };

  const save = async () => {
    setError(null);
    const fields: Record<string, unknown> = {};
    if (counting) {
      if (!count || Number.isNaN(n)) return setError(t('form.needCount'));
      fields.countedUnits = n;
      if (n !== job.cargo.units) {
        if (!difference.trim()) return setError(t('form.needDifference'));
        fields.discrepancy = difference.trim();
      }
    }
    let signature: Capture['signature'] = null;
    if (step === 'delivery.delivered') {
      if (!recipient.trim()) return setError(t('form.needRecipient'));
      if (strokes.length === 0 && photos.length === 0) return setError(t('form.needEvidence'));
      if (damage && !damageNote.trim()) return setError(t('form.needDamageNote'));
      fields.recipientName = recipient.trim();
      fields.damage = damage;
      if (damage) fields.damageNote = damageNote.trim();
      if (strokes.length) signature = { base64: toBase64(signaturePng(strokes, box.w, box.h)) };
    }
    if (step === 'delay.reported') {
      fields.delayMinutes = Number(minutes) || 30;
      if (reason.trim()) fields.note = reason.trim();
    }
    if (step === 'border.crossed') fields.country = country.trim().toUpperCase().slice(0, 2);
    setBusy(true);
    await onSave({
      action: step,
      fields,
      photos: photos.map(({ base64, contentType }) => ({ base64, contentType })),
      signature,
    });
    setBusy(false);
  };

  return (
    <ScrollView contentContainerStyle={s.scroll} keyboardShouldPersistTaps="handled">
      <Text style={s.h1}>{t(STEP_LABEL[step])}</Text>
      {counting && (
        <View style={{ gap: 6 }}>
          <Label>{t('form.count')}</Label>
          <Input
            value={count}
            onChangeText={setCount}
            keyboardType="number-pad"
            accessibilityLabel={t('form.count')}
          />
          <Text style={s.muted}>{t('form.expected', { n: job.cargo.units })}</Text>
          {count !== '' && n !== job.cargo.units && (
            <>
              <Label>{t('form.difference')}</Label>
              <Input
                value={difference}
                onChangeText={setDifference}
                multiline
                accessibilityLabel={t('form.difference')}
              />
            </>
          )}
        </View>
      )}
      {step === 'delivery.delivered' && (
        <>
          <Label>{t('form.recipient')}</Label>
          <Input
            value={recipient}
            onChangeText={setRecipient}
            accessibilityLabel={t('form.recipient')}
          />
          <View style={[s.row, { justifyContent: 'space-between' }]}>
            <Label>{t('form.signature')}</Label>
            <Pressable onPress={() => setStrokes([])}>
              <Text style={{ color: colors.brand }}>{t('form.clear')}</Text>
            </Pressable>
          </View>
          <SignaturePad strokes={strokes} onChange={(st, b) => (setStrokes(st), setBox(b))} />
          <View style={s.row}>
            <Switch
              value={damage}
              onValueChange={setDamage}
              accessibilityLabel={t('form.damage')}
            />
            <Text style={s.text}>{t('form.damage')}</Text>
          </View>
          {damage && (
            <Input
              value={damageNote}
              onChangeText={setDamageNote}
              placeholder={t('form.damageNote')}
              multiline
            />
          )}
        </>
      )}
      {step === 'delay.reported' && (
        <>
          <Label>{t('form.delayMinutes')}</Label>
          <Input value={minutes} onChangeText={setMinutes} keyboardType="number-pad" />
          <Label>{t('form.reason')}</Label>
          <Input value={reason} onChangeText={setReason} />
        </>
      )}
      {step === 'border.crossed' && (
        <>
          <Label>{t('form.country')}</Label>
          <Input
            value={country}
            onChangeText={setCountry}
            autoCapitalize="characters"
            maxLength={2}
          />
        </>
      )}
      {(counting || step === 'pickup.arrived' || step === 'delivery.arrived') && (
        <>
          <Label>{t('form.photos')}</Label>
          <View style={[s.row, { flexWrap: 'wrap' }]}>
            {photos.map((p, i) => (
              <Image
                key={i}
                source={{ uri: p.uri }}
                style={{ width: 72, height: 72, borderRadius: 8 }}
              />
            ))}
          </View>
          <Button kind="secondary" title={t('form.addPhoto')} onPress={takePhoto} />
        </>
      )}
      {error && <Note tone="error">{error}</Note>}
      <Button title={t('form.save')} onPress={save} busy={busy} />
      <Button title={t('form.cancel')} kind="secondary" onPress={onCancel} />
    </ScrollView>
  );
}
