import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { invoices, payments } from '../src/db/schema';
import {
  adminClient,
  bookedWithDriver,
  key,
  publishedShipment,
  readyCarrier,
  registerCompany,
  tripEvent,
  upload,
  useTestEnv,
} from './helpers';

const env = useTestEnv();

async function fullJob() {
  const t = await bookedWithDriver(env);
  await t.carrier.client.put('/api/org/payout-account', {
    holderName: 'Nordtrans GmbH',
    iban: 'DE89370400440532013000',
  });
  await t.driver.post(
    `/api/shipments/${t.shipmentId}/trip-events`,
    tripEvent(env, 'pickup.loaded', { countedUnits: 10 }),
  );
  const sig = await upload(env, t.driver, t.shipmentId, 'signature');
  await t.driver.post(
    `/api/shipments/${t.shipmentId}/trip-events`,
    tripEvent(env, 'delivery.delivered', {
      countedUnits: 10,
      recipientName: 'Bram',
      signatureFileId: sig.data.id,
    }),
  );
  await t.shipper.client.post(`/api/shipments/${t.shipmentId}/confirm-delivery`);
  await env.jobs();
  return t;
}

describe('invoices', () => {
  it('the customer gets an invoice at booking and the carrier a statement at payout, numbered without gaps', async () => {
    const t = await fullJob();
    const mine = await t.shipper.client.get('/api/org/invoices');
    expect(mine.data).toHaveLength(1);
    expect(mine.data[0]).toMatchObject({ kind: 'customer_invoice', number: 'INV-2026-000001' });
    const carrierDocs = await t.carrier.client.get('/api/org/invoices');
    expect(carrierDocs.data[0]).toMatchObject({
      kind: 'carrier_statement',
      number: 'CST-2026-000001',
    });
    const pdf = await env.app.inject({
      method: 'GET',
      url: `/api/files/${mine.data[0].fileId}`,
      headers: { cookie: t.shipper.client.cookie },
    });
    expect(pdf.rawPayload.subarray(0, 4).toString()).toBe('%PDF');
    // The carrier works on the same shipment but may not open the customer's invoice
    const other = await env.app.inject({
      method: 'GET',
      url: `/api/files/${mine.data[0].fileId}`,
      headers: { cookie: t.carrier.client.cookie },
    });
    expect(other.statusCode).toBe(404);
    const t2 = await fullJob();
    expect((await t2.shipper.client.get('/api/org/invoices')).data[0].number).toBe(
      'INV-2026-000002',
    );
    const rows = await env.ctx.db.select().from(invoices);
    expect(rows.every((r) => r.totalMinor === r.netMinor + r.vatMinor)).toBe(true);
  });

  it('drivers cannot list invoices', async () => {
    const t = await bookedWithDriver(env);
    expect((await t.driver.get('/api/org/invoices')).statusCode).toBe(403);
  });
});

describe('reconciliation', () => {
  it('ledger and operational records agree after bookings, refunds, payouts, cancellations and a chargeback', async () => {
    await fullJob();
    const shipper = await registerCompany(env, 'shipper');
    const cancelled = await publishedShipment(env, shipper.client);
    await shipper.client.post(`/api/shipments/${cancelled.id}/cancel`, { reason: 'changed plans' });
    const carrier = await readyCarrier(env);
    const booked = await publishedShipment(env, shipper.client);
    await carrier.client.post(`/api/carrier/loads/${booked.id}/accept`, {
      vehicleId: carrier.vehicleId,
      idempotencyKey: key(),
    });
    await env.jobs();
    const [p] = await env.ctx.db.select().from(payments).where(eq(payments.shipmentId, booked.id));
    const cb = env.ctx.payments.makeWebhook!({
      id: 'evt-cb',
      type: 'dispute.created',
      data: {
        providerRef: p!.providerRef,
        amountMinor: 10_000,
        currency: 'EUR',
        reason: 'fraudulent',
      },
    });
    expect(
      (
        await env.app.inject({
          method: 'POST',
          url: '/api/webhooks/payments',
          headers: { 'content-type': 'application/json', 'x-signature': cb.signature },
          payload: cb.body,
        })
      ).json().result,
    ).toBe('chargeback_recorded');
    const admin = await adminClient(env);
    const rec = await admin.get('/api/admin/reconciliation');
    expect(rec.data.checks.filter((c: { ok: boolean }) => !c.ok)).toEqual([]);
    expect(rec.data.allOk).toBe(true);
  });
});
