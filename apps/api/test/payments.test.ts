import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { payments, refunds, shipments } from '../src/db/schema';
import { balance } from '../src/services/ledger';
import {
  key,
  publishedShipment,
  readyCarrier,
  registerCompany,
  shipmentInput,
  useTestEnv,
} from './helpers';

const env = useTestEnv();

async function webhook(body: string, signature: string) {
  return env.app.inject({
    method: 'POST',
    url: '/api/webhooks/payments',
    headers: { 'content-type': 'application/json', 'x-signature': signature },
    payload: body,
  });
}

describe('payments', () => {
  it('a failed payment keeps the shipment away from carriers; a new payment can be made', async () => {
    const shipper = await registerCompany(env, 'shipper');
    const res = await shipper.client.post('/api/shipments', shipmentInput(env));
    const failed = await shipper.client.post(
      `/api/test-payments/${res.data.payment.paymentRef}/complete`,
      { outcome: 'fail' },
    );
    expect(failed.data.result).toBe('failed');
    let view = await shipper.client.get(`/api/shipments/${res.data.id}`);
    expect(view.data.status).toBe('awaiting_payment');
    expect(view.data.payments[0]).toMatchObject({
      status: 'failed',
      failureReason: 'card_declined (test)',
    });
    const again = await shipper.client.post(`/api/shipments/${res.data.id}/pay`);
    expect(again.data.paymentRef).not.toBe(res.data.payment.paymentRef);
    await shipper.client.post(`/api/test-payments/${again.data.paymentRef}/complete`, {
      outcome: 'succeed',
    });
    view = await shipper.client.get(`/api/shipments/${res.data.id}`);
    expect(view.data.status).toBe('searching');
    expect(view.data.fundedMinor).toBe(200_000);
  });

  it('a duplicate webhook is processed once', async () => {
    const shipper = await registerCompany(env, 'shipper');
    const res = await shipper.client.post('/api/shipments', shipmentInput(env));
    const hook = env.ctx.payments.makeWebhook!({
      id: 'evt-1',
      type: 'payment.succeeded',
      data: { providerRef: res.data.payment.paymentRef, amountMinor: 200_000, currency: 'EUR' },
    });
    expect((await webhook(hook.body, hook.signature)).json().result).toBe('published');
    expect((await webhook(hook.body, hook.signature)).json().result).toBe('duplicate');
    // A different event id for the same payment does not fund twice either
    const again = env.ctx.payments.makeWebhook!({
      id: 'evt-2',
      type: 'payment.succeeded',
      data: { providerRef: res.data.payment.paymentRef, amountMinor: 200_000, currency: 'EUR' },
    });
    expect((await webhook(again.body, again.signature)).json().result).toBe('already_succeeded');
    const [s] = await env.ctx.db.select().from(shipments).where(eq(shipments.id, res.data.id));
    expect(s!.fundedMinor).toBe(200_000);
    expect(await balance(env.ctx.db, 'customer_funds', shipper.orgId, 'EUR')).toBe(200_000);
  });

  it('refuses a webhook with a wrong signature or a wrong amount', async () => {
    const shipper = await registerCompany(env, 'shipper');
    const res = await shipper.client.post('/api/shipments', shipmentInput(env));
    const hook = env.ctx.payments.makeWebhook!({
      id: 'evt-x',
      type: 'payment.succeeded',
      data: { providerRef: res.data.payment.paymentRef, amountMinor: 200_000, currency: 'EUR' },
    });
    expect((await webhook(hook.body, 'forged')).statusCode).toBe(400);
    const wrong = env.ctx.payments.makeWebhook!({
      id: 'evt-y',
      type: 'payment.succeeded',
      data: { providerRef: res.data.payment.paymentRef, amountMinor: 100, currency: 'EUR' },
    });
    expect((await webhook(wrong.body, wrong.signature)).json().result).toBe('amount_mismatch');
    const [s] = await env.ctx.db.select().from(shipments).where(eq(shipments.id, res.data.id));
    expect(s!.status).toBe('awaiting_payment');
  });

  it('cancelling before booking refunds everything', async () => {
    const shipper = await registerCompany(env, 'shipper');
    const s = await publishedShipment(env, shipper.client);
    const res = await shipper.client.post(`/api/shipments/${s.id}/cancel`, {
      reason: 'Plans changed',
    });
    expect(res.statusCode).toBe(200);
    await env.jobs();
    const [row] = await env.ctx.db.select().from(shipments).where(eq(shipments.id, s.id));
    expect(row).toMatchObject({ status: 'cancelled', fundedMinor: 0 });
    const r = await env.ctx.db.select().from(refunds).where(eq(refunds.shipmentId, s.id));
    expect(r.map((x) => x.amountMinor)).toEqual([200_000]);
    expect(await balance(env.ctx.db, 'customer_funds', shipper.orgId, 'EUR')).toBe(0);
    // Running the jobs again refunds nothing more
    await env.jobs();
    expect(
      await env.ctx.db.select().from(refunds).where(eq(refunds.shipmentId, s.id)),
    ).toHaveLength(1);
  });

  it('a booked shipment cannot be cancelled online', async () => {
    const shipper = await registerCompany(env, 'shipper');
    const carrier = await readyCarrier(env);
    const s = await publishedShipment(env, shipper.client);
    await carrier.client.post(`/api/carrier/loads/${s.id}/accept`, {
      vehicleId: carrier.vehicleId,
      idempotencyKey: key(),
    });
    expect(
      (await shipper.client.post(`/api/shipments/${s.id}/cancel`, { reason: 'x' })).data.error,
    ).toBe('cannot_cancel');
  });

  it('a shipment no carrier takes expires and is refunded', async () => {
    const shipper = await registerCompany(env, 'shipper');
    const s = await publishedShipment(env, shipper.client, { serviceLevel: 'express' });
    env.advance(121);
    await env.jobs();
    const [row] = await env.ctx.db.select().from(shipments).where(eq(shipments.id, s.id));
    expect(row).toMatchObject({ status: 'expired', fundedMinor: 0 });
  });

  it('a prepayment that arrives after cancelling is given back', async () => {
    const shipper = await registerCompany(env, 'shipper');
    const res = await shipper.client.post('/api/shipments', shipmentInput(env));
    await shipper.client.post(`/api/shipments/${res.data.id}/cancel`, { reason: 'x' });
    const late = env.ctx.payments.makeWebhook!({
      id: 'evt-late',
      type: 'payment.succeeded',
      data: { providerRef: res.data.payment.paymentRef, amountMinor: 200_000, currency: 'EUR' },
    });
    // The pending payment was cancelled with the shipment: money that still arrives is recorded and refunded
    expect((await webhook(late.body, late.signature)).json().result).toBe('refund_queued');
    await env.jobs();
    const p = await env.ctx.db.select().from(payments).where(eq(payments.shipmentId, res.data.id));
    expect(p[0]!.status).toBe('succeeded');
    const r = await env.ctx.db.select().from(refunds).where(eq(refunds.shipmentId, res.data.id));
    expect(r.map((x) => x.amountMinor)).toEqual([200_000]);
    expect(await balance(env.ctx.db, 'customer_funds', shipper.orgId, 'EUR')).toBe(0);
  });
});
