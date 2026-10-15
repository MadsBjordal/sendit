/**
 * The offline outbox: everything the driver does is saved on the phone first and sent in order when
 * there is a connection. Each action carries an id made when it happened, so sending it twice is
 * harmless (the server recognises it). Photos are sent before the action that uses them; their
 * local reference is swapped for the server's file id.
 *
 * Pure logic (no React Native imports) so it can be unit-tested.
 */
export type OutboxItem =
  | {
      id: string;
      kind: 'upload';
      shipmentId: string;
      localRef: string;
      fileKind: string;
      contentType: string;
      base64: string;
      createdAt: string;
      error?: string;
    }
  | {
      id: string;
      kind: 'event';
      shipmentId: string;
      body: Record<string, unknown>;
      createdAt: string;
      error?: string;
    }
  | {
      id: string;
      kind: 'positions';
      shipmentId: string;
      positions: Array<{
        at: string;
        lat: number;
        lng: number;
        accuracyM?: number | null;
        speedKmh?: number | null;
      }>;
      createdAt: string;
      error?: string;
    };

export interface OutboxState {
  items: OutboxItem[];
  /** localRef → server file id, for photos already uploaded */
  uploaded: Record<string, string>;
}

export type SendResult =
  { ok: true; data?: unknown } | { ok: false; retry: boolean; error: string };

export interface Sender {
  upload(item: Extract<OutboxItem, { kind: 'upload' }>): Promise<SendResult>;
  event(shipmentId: string, body: Record<string, unknown>): Promise<SendResult>;
  positions(
    shipmentId: string,
    positions: Extract<OutboxItem, { kind: 'positions' }>['positions'],
  ): Promise<SendResult>;
}

export function emptyOutbox(): OutboxState {
  return { items: [], uploaded: {} };
}

/** Replaces local photo references in an action with the server's file ids. Returns null if one is not uploaded yet. */
export function resolveRefs(
  body: Record<string, unknown>,
  uploaded: Record<string, string>,
): Record<string, unknown> | null {
  const swap = (v: unknown): unknown => {
    if (typeof v === 'string' && v.startsWith('local:')) return uploaded[v] ?? null;
    return v;
  };
  const out: Record<string, unknown> = { ...body };
  if (typeof out.signatureFileId === 'string') {
    out.signatureFileId = swap(out.signatureFileId);
    if (out.signatureFileId === null) return null;
  }
  if (Array.isArray(out.photoFileIds)) {
    const ids = out.photoFileIds.map(swap);
    if (ids.some((x) => x === null)) return null;
    out.photoFileIds = ids;
  }
  return out;
}

/**
 * Sends what it can, in order. Stops at the first item that should be retried later (no network);
 * an item the server refuses for good is kept with its error so the driver sees it, and the
 * rest continue. Returns the new state.
 */
export async function flush(state: OutboxState, sender: Sender): Promise<OutboxState> {
  const items = [...state.items];
  const uploaded = { ...state.uploaded };
  const kept: OutboxItem[] = [];
  for (let i = 0; i < items.length; i++) {
    const item = items[i]!;
    if (item.error) {
      kept.push(item);
      continue;
    }
    let res: SendResult;
    if (item.kind === 'upload') {
      res = await sender.upload(item);
      if (res.ok) uploaded[item.localRef] = (res.data as { id: string }).id;
    } else if (item.kind === 'event') {
      const body = resolveRefs(item.body, uploaded);
      res = body
        ? await sender.event(item.shipmentId, body)
        : { ok: false, retry: false, error: 'A photo for this step was not sent' };
    } else res = await sender.positions(item.shipmentId, item.positions);
    if (res.ok) continue;
    if (res.retry) return { items: [...kept, ...items.slice(i)], uploaded };
    // Positions that are refused (job finished) are simply dropped
    if (item.kind !== 'positions') kept.push({ ...item, error: res.error });
  }
  return { items: kept, uploaded };
}

export function pendingCount(state: OutboxState): number {
  return state.items.filter((i) => !i.error && i.kind !== 'positions').length;
}
