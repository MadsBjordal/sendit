import assert from 'node:assert/strict';
import { test } from 'node:test';
import { flush, pendingCount, resolveRefs, type OutboxState, type Sender } from './outbox.ts';

const at = '2026-11-02T10:00:00Z';
const state = (): OutboxState => ({
  items: [
    {
      id: '1',
      kind: 'upload',
      shipmentId: 's',
      localRef: 'local:a',
      fileKind: 'photo',
      contentType: 'image/jpeg',
      base64: 'x',
      createdAt: at,
    },
    {
      id: '2',
      kind: 'event',
      shipmentId: 's',
      body: { action: 'pickup.loaded', photoFileIds: ['local:a'] },
      createdAt: at,
    },
    {
      id: '3',
      kind: 'positions',
      shipmentId: 's',
      positions: [{ at, lat: 1, lng: 2 }],
      createdAt: at,
    },
  ],
  uploaded: {},
});

test('sends in order and swaps local photo references for server ids', async () => {
  const sent: unknown[] = [];
  const sender: Sender = {
    upload: async () => ({ ok: true, data: { id: 'file-1' } }),
    event: async (_s, body) => (sent.push(body), { ok: true }),
    positions: async () => ({ ok: true }),
  };
  const out = await flush(state(), sender);
  assert.equal(out.items.length, 0);
  assert.deepEqual(sent, [{ action: 'pickup.loaded', photoFileIds: ['file-1'] }]);
});

test('stops without losing anything when offline, and resumes later', async () => {
  let online = false;
  const sender: Sender = {
    upload: async () =>
      online ? { ok: true, data: { id: 'f' } } : { ok: false, retry: true, error: 'offline' },
    event: async () => ({ ok: true }),
    positions: async () => ({ ok: true }),
  };
  const first = await flush(state(), sender);
  assert.equal(first.items.length, 3);
  assert.equal(pendingCount(first), 2);
  online = true;
  const second = await flush(first, sender);
  assert.equal(second.items.length, 0);
});

test('keeps a refused step with its error and carries on', async () => {
  const sender: Sender = {
    upload: async () => ({ ok: true, data: { id: 'f' } }),
    event: async () => ({ ok: false, retry: false, error: 'Confirm loading first' }),
    positions: async () => ({ ok: true }),
  };
  const out = await flush(state(), sender);
  assert.equal(out.items.length, 1);
  assert.equal(out.items[0]!.error, 'Confirm loading first');
  assert.equal(pendingCount(out), 0);
});

test('an action whose photo is missing is not sent', () => {
  assert.equal(resolveRefs({ signatureFileId: 'local:x' }, {}), null);
  assert.deepEqual(resolveRefs({ signatureFileId: 'local:x' }, { 'local:x': 'id' }), {
    signatureFileId: 'id',
  });
});
