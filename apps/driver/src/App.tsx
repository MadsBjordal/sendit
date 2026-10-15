import { StatusBar } from 'expo-status-bar';
import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState, Pressable, SafeAreaView, Text, View } from 'react-native';
import { call, Offline, sender, type Job } from './api';
import { t } from './i18n';
import { flush, pendingCount, type OutboxItem, type OutboxState } from './outbox';
import { JobScreen, type Capture } from './screens/Job';
import { Jobs } from './screens/Jobs';
import { Login } from './screens/Login';
import {
  getToken,
  loadJobsCache,
  loadOutbox,
  saveJobsCache,
  saveOutbox,
  setToken,
} from './storage';
import { MOVING_KMH, startTracking, type Fix } from './tracking';
import { colors, Note, s } from './ui';

let counter = 0;
const newId = () =>
  `${Date.now().toString(36)}-${(counter++).toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

export default function App() {
  const [ready, setReady] = useState(false);
  const [loggedIn, setLoggedIn] = useState(false);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [openId, setOpenId] = useState<string | null>(null);
  const [outbox, setOutbox] = useState<OutboxState>({ items: [], uploaded: {} });
  const [refreshing, setRefreshing] = useState(false);
  const [speed, setSpeed] = useState(0);
  const [tracking, setTracking] = useState<'on' | 'denied' | 'off'>('off');
  const [savedOffline, setSavedOffline] = useState(false);
  const outboxRef = useRef(outbox);
  outboxRef.current = outbox;
  const flushing = useRef(false);

  const persist = useCallback(async (next: OutboxState) => {
    outboxRef.current = next;
    setOutbox(next);
    await saveOutbox(next);
  }, []);

  /** Sends what is waiting. Only one flush runs at a time. */
  const sync = useCallback(async () => {
    if (flushing.current || outboxRef.current.items.length === 0) return;
    flushing.current = true;
    try {
      const before = outboxRef.current;
      const after = await flush(before, sender);
      // Keep anything added while sending
      const added = outboxRef.current.items.filter((i) => !before.items.some((b) => b.id === i.id));
      await persist({ items: [...after.items, ...added], uploaded: after.uploaded });
    } finally {
      flushing.current = false;
    }
  }, [persist]);

  const loadJobs = useCallback(async () => {
    setRefreshing(true);
    try {
      const r = await call<Job[]>('/api/driver/jobs');
      if (r.status === 401) {
        await setToken(null);
        setLoggedIn(false);
      } else if (r.status === 200) {
        setJobs(r.data);
        await saveJobsCache(r.data);
      }
    } catch (e) {
      if (!(e instanceof Offline)) throw e;
    } finally {
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    (async () => {
      const token = await getToken();
      setLoggedIn(!!token);
      setOutbox(await loadOutbox());
      setJobs((await loadJobsCache<Job[]>()) ?? []);
      setReady(true);
    })();
  }, []);

  useEffect(() => {
    if (!loggedIn) return;
    loadJobs().then(sync);
    const timer = setInterval(() => sync().then(loadJobs), 60_000);
    const sub = AppState.addEventListener(
      'change',
      (st) => st === 'active' && sync().then(loadJobs),
    );
    return () => {
      clearInterval(timer);
      sub.remove();
    };
  }, [loggedIn, loadJobs, sync]);

  // Position sharing: only while there is an active job, and only while the app is open
  const activeJob =
    jobs.find((j) => j.status === 'in_transit') ?? jobs.find((j) => j.status === 'booked');
  useEffect(() => {
    if (!loggedIn || !activeJob) {
      setTracking('off');
      return;
    }
    let stop: (() => void) | null = null;
    let cancelled = false;
    startTracking((f: Fix) => {
      setSpeed(f.speedKmh ?? 0);
      const items = outboxRef.current.items;
      const last = items[items.length - 1];
      const pos = {
        at: f.at,
        lat: f.lat,
        lng: f.lng,
        accuracyM: f.accuracyM,
        speedKmh: f.speedKmh,
      };
      const next: OutboxItem[] =
        last &&
        last.kind === 'positions' &&
        last.shipmentId === activeJob.shipmentId &&
        last.positions.length < 100
          ? [...items.slice(0, -1), { ...last, positions: [...last.positions, pos] }]
          : [
              ...items,
              {
                id: newId(),
                kind: 'positions',
                shipmentId: activeJob.shipmentId,
                positions: [pos],
                createdAt: f.at,
              },
            ];
      persist({ ...outboxRef.current, items: next });
    }).then((s) => {
      if (cancelled) s?.();
      else {
        stop = s;
        setTracking(s ? 'on' : 'denied');
      }
    });
    return () => {
      cancelled = true;
      stop?.();
    };
  }, [loggedIn, activeJob?.shipmentId, persist]);

  /** A step from the road: saved on the phone at once, then sent. */
  const capture = async (job: Job, c: Capture) => {
    const now = new Date().toISOString();
    const items: OutboxItem[] = [];
    const photoRefs: string[] = [];
    for (const p of c.photos) {
      const ref = `local:${newId()}`;
      photoRefs.push(ref);
      items.push({
        id: newId(),
        kind: 'upload',
        shipmentId: job.shipmentId,
        localRef: ref,
        fileKind: 'photo',
        contentType: p.contentType,
        base64: p.base64,
        createdAt: now,
      });
    }
    let sigRef: string | null = null;
    if (c.signature) {
      sigRef = `local:${newId()}`;
      items.push({
        id: newId(),
        kind: 'upload',
        shipmentId: job.shipmentId,
        localRef: sigRef,
        fileKind: 'signature',
        contentType: 'image/png',
        base64: c.signature.base64,
        createdAt: now,
      });
    }
    const last = outboxRef.current.items.findLast?.((i) => i.kind === 'positions');
    const lastPos =
      last && last.kind === 'positions' ? last.positions[last.positions.length - 1] : undefined;
    items.push({
      id: newId(),
      kind: 'event',
      shipmentId: job.shipmentId,
      createdAt: now,
      body: {
        clientEventId: newId(),
        action: c.action,
        occurredAt: now,
        lat: lastPos?.lat ?? null,
        lng: lastPos?.lng ?? null,
        photoFileIds: photoRefs,
        ...(sigRef ? { signatureFileId: sigRef } : {}),
        ...c.fields,
      },
    });
    // The step shows as done straight away, even offline
    setJobs((js) =>
      js.map((j) =>
        j.shipmentId === job.shipmentId
          ? {
              ...j,
              done: [...j.done, c.action],
              status:
                c.action === 'pickup.loaded'
                  ? 'in_transit'
                  : c.action === 'delivery.delivered'
                    ? 'delivered'
                    : j.status,
            }
          : j,
      ),
    );
    await persist({ ...outboxRef.current, items: [...outboxRef.current.items, ...items] });
    await sync();
    setSavedOffline(pendingCount(outboxRef.current) > 0);
    loadJobs();
  };

  const dismiss = (id: string) =>
    persist({ ...outboxRef.current, items: outboxRef.current.items.filter((i) => i.id !== id) });

  if (!ready) return <SafeAreaView style={s.screen} />;
  const failed = outbox.items.filter((i) => i.error);
  const open = jobs.find((j) => j.shipmentId === openId);
  return (
    <SafeAreaView style={s.screen}>
      <StatusBar style="dark" />
      {failed.map((f) => (
        <View key={f.id} style={{ padding: 8 }}>
          <Note tone="error">
            {t('outbox.failed', { error: f.error ?? '' })}{' '}
            <Text onPress={() => dismiss(f.id)} style={{ color: colors.brand }}>
              {t('outbox.dismiss')}
            </Text>
          </Note>
        </View>
      ))}
      {savedOffline && pendingCount(outbox) > 0 && (
        <Pressable onPress={() => setSavedOffline(false)} style={{ padding: 8 }}>
          <Note tone="warn">{t('saved.offline')}</Note>
        </Pressable>
      )}
      {!loggedIn ? (
        <Login onDone={() => setLoggedIn(true)} />
      ) : open ? (
        <JobScreen
          job={open}
          onBack={() => setOpenId(null)}
          onCapture={(c) => capture(open, c)}
          moving={speed > MOVING_KMH}
          tracking={activeJob?.shipmentId === open.shipmentId ? tracking : 'off'}
        />
      ) : (
        <Jobs
          jobs={jobs}
          onOpen={(j) => setOpenId(j.shipmentId)}
          onRefresh={() => sync().then(loadJobs)}
          waiting={pendingCount(outbox)}
          refreshing={refreshing}
          onLogout={async () => {
            await setToken(null);
            setLoggedIn(false);
            setJobs([]);
          }}
        />
      )}
    </SafeAreaView>
  );
}
