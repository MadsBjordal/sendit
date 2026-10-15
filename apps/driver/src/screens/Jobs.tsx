import { Pressable, ScrollView, Text, View } from 'react-native';
import type { Job } from '../api';
import { t, type Key } from '../i18n';
import { Button, colors, Note, s } from '../ui';

function when(iso: string) {
  return new Date(iso).toLocaleString(undefined, {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function Jobs({
  jobs,
  onOpen,
  onRefresh,
  onLogout,
  waiting,
  refreshing,
}: {
  jobs: Job[];
  onOpen(j: Job): void;
  onRefresh(): void;
  onLogout(): void;
  waiting: number;
  refreshing: boolean;
}) {
  const active = jobs.filter((j) => ['booked', 'in_transit'].includes(j.status));
  const rest = jobs.filter((j) => !['booked', 'in_transit'].includes(j.status));
  const card = (j: Job) => (
    <Pressable
      key={j.shipmentId}
      onPress={() => onOpen(j)}
      accessibilityRole="button"
      style={({ pressed }) => [s.card, pressed && { opacity: 0.8 }]}
    >
      <View style={[s.row, { justifyContent: 'space-between' }]}>
        <Text style={s.muted}>{j.number}</Text>
        <Text
          style={{
            fontWeight: '700',
            color: j.status === 'in_transit' ? colors.brand : colors.soft,
          }}
        >
          {t(`status.${j.status}` as Key)}
        </Text>
      </View>
      <Text style={s.h2}>
        {j.pickup.city} → {j.delivery.city}
      </Text>
      <Text style={s.muted}>
        {t('job.pickup')}: {when(j.pickup.windowStart)}
      </Text>
    </Pressable>
  );
  return (
    <ScrollView contentContainerStyle={s.scroll}>
      <View style={[s.row, { justifyContent: 'space-between' }]}>
        <Text style={s.h1}>{t('jobs.title')}</Text>
        <Pressable onPress={onLogout} accessibilityRole="button">
          <Text style={{ color: colors.soft }}>{t('logout')}</Text>
        </Pressable>
      </View>
      {waiting > 0 && <Note tone="warn">{t('outbox.waiting', { n: waiting })}</Note>}
      {jobs.length === 0 && <Note>{t('jobs.empty')}</Note>}
      {active.length > 0 && <Text style={s.h2}>{t('jobs.active')}</Text>}
      {active.map(card)}
      {rest.length > 0 && <Text style={[s.h2, { marginTop: 12 }]}>{t('jobs.finished')}</Text>}
      {rest.slice(0, 10).map(card)}
      <Button title={t('jobs.refresh')} kind="secondary" onPress={onRefresh} busy={refreshing} />
    </ScrollView>
  );
}
