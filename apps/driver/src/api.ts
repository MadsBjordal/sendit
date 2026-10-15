import Constants from 'expo-constants';
import type { OutboxItem, SendResult, Sender } from './outbox';
import { getToken } from './storage';

export const API_URL: string =
  process.env.EXPO_PUBLIC_API_URL ??
  (Constants.expoConfig?.extra as { apiUrl?: string } | undefined)?.apiUrl ??
  'http://localhost:4000';

export class Offline extends Error {}

export async function call<T>(
  path: string,
  init: { method?: string; body?: unknown } = {},
): Promise<{ status: number; data: T }> {
  const token = await getToken();
  let res: Response;
  try {
    res = await fetch(`${API_URL}${path}`, {
      method: init.method ?? (init.body ? 'POST' : 'GET'),
      headers: {
        'content-type': 'application/json',
        'x-requested-with': 'freight',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: init.body ? JSON.stringify(init.body) : undefined,
    });
  } catch {
    throw new Offline('offline');
  }
  const text = await res.text();
  return { status: res.status, data: (text ? JSON.parse(text) : null) as T };
}

/** Network errors and server trouble are retried later; refusals (4xx) are kept with their message. */
async function send(path: string, body: unknown): Promise<SendResult> {
  try {
    const r = await call<{ message?: string }>(path, { method: 'POST', body });
    if (r.status < 300) return { ok: true, data: r.data };
    if (r.status >= 500 || r.status === 429 || r.status === 401)
      return { ok: false, retry: true, error: r.data?.message ?? `HTTP ${r.status}` };
    return { ok: false, retry: false, error: r.data?.message ?? `HTTP ${r.status}` };
  } catch {
    return { ok: false, retry: true, error: 'offline' };
  }
}

export const sender: Sender = {
  upload: (item: Extract<OutboxItem, { kind: 'upload' }>) =>
    send(`/api/shipments/${item.shipmentId}/files/base64`, {
      kind: item.fileKind,
      contentType: item.contentType,
      data: item.base64,
    }),
  event: (shipmentId, body) => send(`/api/shipments/${shipmentId}/trip-events`, body),
  positions: (shipmentId, positions) =>
    send(`/api/shipments/${shipmentId}/positions`, { positions }),
};

export interface Place {
  addressLine: string;
  postcode: string;
  city: string;
  country: string;
  lat: number;
  lng: number;
  windowStart: string;
  windowEnd: string;
  contactName: string | null;
  contactPhone: string | null;
  hasForklift: boolean;
  hasLoadingDock: boolean;
  instructions: string | null;
}

export interface Job {
  shipmentId: string;
  number: string;
  status: string;
  pickup: Place;
  delivery: Place;
  cargo: {
    description: string;
    units: number;
    weightKg: number;
    temperature: { minC: number; maxC: number } | null;
  };
  customs: string;
  done: string[];
}
