import { eq, sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { customerPriceForPayout, DEFAULT_PRICING } from '@freight/shared';
import { bookings, carrierObligations, offers, shipments } from '../src/db/schema';
import { balance } from '../src/services/ledger';
import {
  Client,
  key,
  publishedShipment,
  readyCarrier,
  registerCompany,
  shipmentInput,
  useTestEnv,
} from './helpers';

const env = useTestEnv();
const tax = { fromCountry: 'DE', toCountry: 'NL', customerCountry: 'DE' };

describe('shipment creation and price', () => {
  it('creates a shipment waiting for payment, with a server-side estimate and customs result', async () => {
    const shipper = await registerCompany(env, 'shipper');
    const res = await shipper.client.post('/api/shipments', shipmentInput(env));
    expect(res.statusCode).toBe(200);
    const s = await shipper.client.get(`/api/shipments/${res.data.id}`);
    expect(s.data.status).toBe('awaiting_payment');
    expect(s.data.vehicleClass).toBe('rigid_truck');
    expect(s.data.route.source).toBe('straight_line_estimate');
    expect(s.data.estimatedTotalMinor).toBe(res.data.estimate.customer.totalMinor);
    expect(s.data.estimatedTotalMinor).toBe(
      customerPriceForPayout(res.data.estimate.carrier.totalMinor, tax, DEFAULT_PRICING).totalMinor,
    );
    expect(s.data.customs.result).toBe('not_required');
    expect(s.data.payments[0]).toMatchObject({
      purpose: 'prepayment',
      amountMinor: 200_000,
      status: 'pending',
      provider: 'test',
    });
  });

  it('needs a confirmed email', async () => {
    const shipper = await registerCompany(env, 'shipper', { verifyEmail: false });
    const res = await shipper.client.post('/api/shipments', shipmentInput(env));
    expect(res.statusCode).toBe(403);
    expect(res.data.error).toBe('email_not_verified');
  });

  it('refuses countries that are not open, dangerous goods, impossible cargo and a too-soon pickup', async () => {
    const { client } = await registerCompany(env, 'shipper');
    const bad = shipmentInput(env);
    bad.delivery.country = 'SE';
    expect((await client.post('/api/shipments', bad)).data.error).toBe('country_not_available');
    expect(
      (
        await client.post(
          '/api/shipments',
          shipmentInput(env, { cargoOver: { dangerousGoods: true } }),
        )
      ).data.error,
    ).toBe('dangerous_goods_not_supported');
    const huge = shipmentInput(env, {
      cargoOver: {
        lines: [
          {
            quantity: 1,
            kind: 'other',
            lengthCm: 1900,
            widthCm: 250,
            heightCm: 300,
            weightKg: 30_000,
            stackable: false,
          },
        ],
      },
    });
    expect((await client.post('/api/shipments', huge)).data.error).toBe('no_vehicle');
    const soon = shipmentInput(env);
    soon.pickup.windowStart = new Date(env.clock.now.getTime() + 3_600_000).toISOString();
    soon.pickup.windowEnd = new Date(env.clock.now.getTime() + 5 * 3_600_000).toISOString();
    expect((await client.post('/api/shipments', soon)).data.error).toBe('pickup_too_soon');
    soon.serviceLevel = 'express';
    expect((await client.post('/api/shipments', soon)).statusCode).toBe(200);
  });

  it('publishes to carriers only after the prepayment webhook', async () => {
    const shipper = await registerCompany(env, 'shipper');
    const carrier = await readyCarrier(env);
    const res = await shipper.client.post('/api/shipments', shipmentInput(env));
    expect((await carrier.client.get('/api/carrier/loads')).data.loads).toHaveLength(0);
    await shipper.client.post(`/api/test-payments/${res.data.payment.paymentRef}/complete`, {
      outcome: 'succeed',
    });
    const board = await carrier.client.get('/api/carrier/loads');
    expect(board.data.loads).toHaveLength(1);
    // Carriers never see the customer's maximum, name or street address
    const load = board.data.loads[0];
    expect(JSON.stringify(load)).not.toContain('200000');
    expect(load.maxPriceMinor).toBeUndefined();
    expect(load.from.addressLine).toBeUndefined();
    expect(load.payoutMinor).toBe(res.data.estimate.carrier.totalMinor);
  });
});

describe('first qualified acceptance wins', () => {
  it('books at once when the price fits the maximum, and refunds the unused prepayment', async () => {
    const shipper = await registerCompany(env, 'shipper');
    const carrier = await readyCarrier(env);
    const s = await publishedShipment(env, shipper.client);
    const res = await carrier.client.post(`/api/carrier/loads/${s.id}/accept`, {
      vehicleId: carrier.vehicleId,
      idempotencyKey: key(),
    });
    expect(res.statusCode).toBe(200);
    expect(res.data.result).toBe('booked');
    expect(res.data.guarantee.funded).toBe(true);
    await env.jobs();
    const view = await shipper.client.get(`/api/shipments/${s.id}`);
    expect(view.data.status).toBe('booked');
    expect(view.data.booking.totalMinor).toBe(s.estimate.customer.totalMinor);
    expect(view.data.fundedMinor).toBe(s.estimate.customer.totalMinor); // the rest went back
    expect((await carrier.client.get('/api/carrier/loads')).data.loads).toHaveLength(0);
  });

  it('a carrier asking more but still within the maximum is booked without asking the customer (€520 → €572 ≤ €600)', async () => {
    const shipper = await registerCompany(env, 'shipper');
    const carrier = await readyCarrier(env);
    const s = await publishedShipment(env, shipper.client, { maxPriceMinor: 60_000 });
    const res = await carrier.client.post(`/api/carrier/loads/${s.id}/accept`, {
      vehicleId: carrier.vehicleId,
      payoutMinor: 52_000,
      idempotencyKey: key(),
    });
    expect(res.data.result).toBe('booked');
    const [b] = await env.ctx.db.select().from(bookings).where(eq(bookings.shipmentId, s.id));
    expect(b).toMatchObject({ payoutMinor: 52_000, platformFeeMinor: 5_200, totalMinor: 57_200 });
  });

  it('two carriers at the same moment: exactly one wins, the other is told it is taken', async () => {
    const shipper = await registerCompany(env, 'shipper');
    const carriers = await Promise.all([1, 2, 3, 4, 5].map(() => readyCarrier(env)));
    const s = await publishedShipment(env, shipper.client);
    const results = await Promise.all(
      carriers.map((c) =>
        c.client.post(`/api/carrier/loads/${s.id}/accept`, {
          vehicleId: c.vehicleId,
          idempotencyKey: key(),
        }),
      ),
    );
    const won = results.filter((r) => r.data.result === 'booked');
    const lost = results.filter((r) => r.data.result === 'already_assigned');
    expect(won).toHaveLength(1);
    expect(lost).toHaveLength(4);
    expect(lost.every((r) => r.statusCode === 409)).toBe(true);
    const all = await env.ctx.db.select().from(bookings).where(eq(bookings.shipmentId, s.id));
    expect(all).toHaveLength(1);
    const obligations = await env.ctx.db.select().from(carrierObligations);
    expect(obligations).toHaveLength(1);
  });

  it('the same acceptance sent twice (network retry) gives the same answer and one booking', async () => {
    const shipper = await registerCompany(env, 'shipper');
    const carrier = await readyCarrier(env);
    const s = await publishedShipment(env, shipper.client);
    const k = key();
    const [a, b] = await Promise.all([
      carrier.client.post(`/api/carrier/loads/${s.id}/accept`, {
        vehicleId: carrier.vehicleId,
        idempotencyKey: k,
      }),
      carrier.client.post(`/api/carrier/loads/${s.id}/accept`, {
        vehicleId: carrier.vehicleId,
        idempotencyKey: k,
      }),
    ]);
    expect(a.data.result).toBe('booked');
    expect(b.data).toEqual(a.data);
    const c = await carrier.client.post(`/api/carrier/loads/${s.id}/accept`, {
      vehicleId: carrier.vehicleId,
      idempotencyKey: k,
    });
    expect(c.data).toEqual(a.data);
  });

  it('refuses a vehicle that is too small, and never shows it the load', async () => {
    const shipper = await registerCompany(env, 'shipper');
    const vanCarrier = await readyCarrier(env, {
      vehicle: {
        vehicleClass: 'van_large',
        payloadKg: 1200,
        lengthCm: 420,
        widthCm: 175,
        heightCm: 190,
        palletPlaces: 4,
      },
    });
    const s = await publishedShipment(env, shipper.client);
    expect((await vanCarrier.client.get('/api/carrier/loads')).data.loads).toHaveLength(0);
    const res = await vanCarrier.client.post(`/api/carrier/loads/${s.id}/accept`, {
      vehicleId: vanCarrier.vehicleId,
      idempotencyKey: key(),
    });
    expect(res.statusCode).toBe(422);
    expect(res.data.problems.map((p: { code: string }) => p.code)).toEqual(
      expect.arrayContaining(['too_heavy', 'too_many_pallets']),
    );
  });

  it('refuses a carrier whose licence expires before the job, or that is not verified', async () => {
    const shipper = await registerCompany(env, 'shipper');
    const expired = await readyCarrier(env, { validUntil: '2026-11-03' }); // pickup runs to 4 Nov
    const s = await publishedShipment(env, shipper.client);
    const res = await expired.client.post(`/api/carrier/loads/${s.id}/accept`, {
      vehicleId: expired.vehicleId,
      idempotencyKey: key(),
    });
    expect(res.data.result).toBe('not_eligible');
    expect(res.data.problems).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'document_expired', kind: 'operator_licence' }),
      ]),
    );

    const unverified = await registerCompany(env, 'carrier');
    await unverified.client.put('/api/carrier/operating-countries', { countries: ['DE', 'NL'] });
    const v = await unverified.client.post(
      '/api/carrier/vehicles',
      (await import('./helpers')).truck(),
    );
    const r2 = await unverified.client.post(`/api/carrier/loads/${s.id}/accept`, {
      vehicleId: v.data.id,
      idempotencyKey: key(),
    });
    expect(r2.data.problems.map((p: { code: string }) => p.code)).toEqual(
      expect.arrayContaining(['carrier_not_verified', 'document_missing']),
    );
  });

  it('a domestic job by a foreign vehicle needs an explicit cabotage confirmation', async () => {
    const shipper = await registerCompany(env, 'shipper');
    const carrier = await readyCarrier(env, { vehicle: { registrationCountry: 'PL' } });
    const input = shipmentInput(env);
    Object.assign(input.delivery, {
      addressLine: 'Messedamm 22',
      postcode: '14055',
      city: 'Berlin',
      country: 'DE',
      lat: 52.5065,
      lng: 13.2798,
    });
    const s = await publishedShipment(env, shipper.client, { delivery: input.delivery });
    const board = await carrier.client.get('/api/carrier/loads');
    expect(board.data.loads[0].vehicles[0].cabotageConfirmationNeeded).toBe(true);
    const no = await carrier.client.post(`/api/carrier/loads/${s.id}/accept`, {
      vehicleId: carrier.vehicleId,
      idempotencyKey: key(),
    });
    expect(no.data.problems[0].code).toBe('cabotage_confirmation_needed');
    const yes = await carrier.client.post(`/api/carrier/loads/${s.id}/accept`, {
      vehicleId: carrier.vehicleId,
      idempotencyKey: key(),
      cabotageConfirmed: true,
    });
    expect(yes.data.result).toBe('booked');
  });
});

describe('offers above the maximum', () => {
  async function setup() {
    const shipper = await registerCompany(env, 'shipper');
    const greedy = await readyCarrier(env);
    const s = await publishedShipment(env, shipper.client, { maxPriceMinor: 60_000 });
    const res = await greedy.client.post(`/api/carrier/loads/${s.id}/accept`, {
      vehicleId: greedy.vehicleId,
      payoutMinor: 59_100,
      idempotencyKey: key(),
    });
    return { shipper, greedy, s, res };
  }

  it('creates an offer instead of booking, and the shipment stays open', async () => {
    const { shipper, s, res } = await setup();
    expect(res.data.result).toBe('offer_pending');
    const view = await shipper.client.get(`/api/shipments/${s.id}`);
    expect(view.data.status).toBe('searching');
    expect(view.data.offers[0]).toMatchObject({
      status: 'pending_customer',
      totalMinor: 65_010,
      overMaxMinor: 5_010,
    });
  });

  it('another carrier within the maximum wins while the offer waits', async () => {
    const { shipper, greedy, s } = await setup();
    const other = await readyCarrier(env);
    const res = await other.client.post(`/api/carrier/loads/${s.id}/accept`, {
      vehicleId: other.vehicleId,
      idempotencyKey: key(),
    });
    expect(res.data.result).toBe('booked');
    const view = await shipper.client.get(`/api/shipments/${s.id}`);
    expect(
      view.data.offers.find((o: { carrierName: string }) => o.carrierName !== undefined).status,
    ).toBe('superseded');
    const offerId = view.data.offers[0].id;
    const approve = await shipper.client.post(`/api/shipments/${s.id}/offers/${offerId}/approve`);
    expect(approve.statusCode).toBe(409);
    expect((await greedy.client.get('/api/carrier/offers')).data[0].status).toBe('superseded');
  });

  it('approving asks for the difference; once paid, the carrier is booked', async () => {
    const { shipper, greedy, s } = await setup();
    const offerId = (await shipper.client.get(`/api/shipments/${s.id}`)).data.offers[0].id;
    const approve = await shipper.client.post(`/api/shipments/${s.id}/offers/${offerId}/approve`);
    expect(approve.data).toMatchObject({ result: 'payment_required', topUpMinor: 5_010 });
    expect((await shipper.client.get(`/api/shipments/${s.id}`)).data.status).toBe('searching');
    const paid = await shipper.client.post(
      `/api/test-payments/${approve.data.payment.paymentRef}/complete`,
      { outcome: 'succeed' },
    );
    expect(paid.data.result).toBe('booked');
    const [b] = await env.ctx.db.select().from(bookings).where(eq(bookings.shipmentId, s.id));
    expect(b).toMatchObject({ totalMinor: 65_010, offerId });
    expect((await greedy.client.get('/api/carrier/bookings')).data[0].payoutMinor).toBe(59_100);
    // Approval did not change the customer's general maximum
    const [row] = await env.ctx.db.select().from(shipments).where(eq(shipments.id, s.id));
    expect(row!.maxPriceMinor).toBe(60_000);
  });

  it('if another carrier wins while the difference is being paid, the difference is refunded', async () => {
    const { shipper, s } = await setup();
    const offerId = (await shipper.client.get(`/api/shipments/${s.id}`)).data.offers[0].id;
    const approve = await shipper.client.post(`/api/shipments/${s.id}/offers/${offerId}/approve`);
    const other = await readyCarrier(env);
    expect(
      (
        await other.client.post(`/api/carrier/loads/${s.id}/accept`, {
          vehicleId: other.vehicleId,
          idempotencyKey: key(),
        })
      ).data.result,
    ).toBe('booked');
    // The pending top-up was cancelled by the booking, but a late success must still be refunded
    const late = env.ctx.payments.makeWebhook!({
      id: 'evt-late',
      type: 'payment.succeeded',
      data: { providerRef: approve.data.payment.paymentRef, amountMinor: 5_010, currency: 'EUR' },
    });
    const res = await env.app.inject({
      method: 'POST',
      url: '/api/webhooks/payments',
      headers: { 'content-type': 'application/json', 'x-signature': late.signature },
      payload: late.body,
    });
    expect(res.json().result).toBe('refund_queued_already_assigned');
    await env.jobs();
    const [row] = await env.ctx.db.select().from(shipments).where(eq(shipments.id, s.id));
    const [b] = await env.ctx.db.select().from(bookings).where(eq(bookings.shipmentId, s.id));
    expect(row!.fundedMinor).toBe(b!.totalMinor);
    expect(await balance(env.ctx.db, 'customer_funds', shipper.orgId, 'EUR')).toBe(0);
  });

  it('expires after its time; approving an expired offer is refused', async () => {
    const { shipper, greedy, s } = await setup();
    const offerId = (await shipper.client.get(`/api/shipments/${s.id}`)).data.offers[0].id;
    env.advance(241);
    await env.jobs();
    const [o] = await env.ctx.db.select().from(offers).where(eq(offers.id, offerId));
    expect(o!.status).toBe('expired');
    expect(
      (await shipper.client.post(`/api/shipments/${s.id}/offers/${offerId}/approve`)).data.error,
    ).toBe('offer_not_pending');
    expect((await greedy.client.get('/api/carrier/offers')).data[0].status).toBe('expired');
  });

  it('the customer can reject an offer', async () => {
    const { shipper, s } = await setup();
    const offerId = (await shipper.client.get(`/api/shipments/${s.id}`)).data.offers[0].id;
    expect(
      (await shipper.client.post(`/api/shipments/${s.id}/offers/${offerId}/reject`)).statusCode,
    ).toBe(200);
    expect((await shipper.client.get(`/api/shipments/${s.id}`)).data.offers[0].status).toBe(
      'rejected',
    );
  });
});

describe('ledger', () => {
  it('payment, booking and refund balance; the carrier is owed exactly the payout', async () => {
    const shipper = await registerCompany(env, 'shipper');
    const carrier = await readyCarrier(env);
    const s = await publishedShipment(env, shipper.client, { maxPriceMinor: 60_000 });
    await carrier.client.post(`/api/carrier/loads/${s.id}/accept`, {
      vehicleId: carrier.vehicleId,
      payoutMinor: 52_000,
      idempotencyKey: key(),
    });
    await env.jobs();
    const db = env.ctx.db;
    expect(await balance(db, 'carrier_payable', carrier.orgId, 'EUR')).toBe(52_000);
    expect(await balance(db, 'platform_revenue_deferred', null, 'EUR')).toBe(5_200);
    expect(await balance(db, 'customer_funds', shipper.orgId, 'EUR')).toBe(0);
    expect(await balance(db, 'psp_clearing', null, 'EUR')).toBe(57_200);
    const total = await db.execute<{ s: string }>(
      sql`SELECT coalesce(sum(amount_minor), 0) AS s FROM ledger_entries`,
    );
    expect(Number(total.rows[0]!.s)).toBe(0);
    // The database refuses to change history
    await expect(db.execute(sql`UPDATE ledger_entries SET amount_minor = 1`)).rejects.toThrow(
      /append-only/,
    );
  });
});

describe('isolation between organisations', () => {
  it('another shipper cannot see or act on a shipment (404, not 403)', async () => {
    const a = await registerCompany(env, 'shipper');
    const b = await registerCompany(env, 'shipper');
    const s = await publishedShipment(env, a.client);
    expect((await b.client.get(`/api/shipments/${s.id}`)).statusCode).toBe(404);
    expect((await b.client.post(`/api/shipments/${s.id}/cancel`, { reason: 'x' })).statusCode).toBe(
      404,
    );
    expect((await b.client.get('/api/shipments')).data).toHaveLength(0);
  });

  it('a carrier cannot use the shipper endpoints, and a shipper cannot accept loads', async () => {
    const shipper = await registerCompany(env, 'shipper');
    const carrier = await readyCarrier(env);
    const s = await publishedShipment(env, shipper.client);
    expect((await carrier.client.get(`/api/shipments/${s.id}`)).statusCode).toBe(403);
    expect(
      (
        await shipper.client.post(`/api/carrier/loads/${s.id}/accept`, {
          vehicleId: carrier.vehicleId,
          idempotencyKey: key(),
        })
      ).statusCode,
    ).toBe(403);
  });

  it('a carrier cannot book with another carrier’s vehicle', async () => {
    const shipper = await registerCompany(env, 'shipper');
    const a = await readyCarrier(env);
    const b = await readyCarrier(env);
    const s = await publishedShipment(env, shipper.client);
    const res = await b.client.post(`/api/carrier/loads/${s.id}/accept`, {
      vehicleId: a.vehicleId,
      idempotencyKey: key(),
    });
    expect(res.data.result).toBe('not_eligible');
  });

  it('logged-out requests are refused', async () => {
    const anon = new Client(env);
    expect((await anon.get('/api/shipments')).statusCode).toBe(401);
  });
});

describe('customs', () => {
  it('detects customs on Germany → Norway and stores the assessment', async () => {
    const shipper = await registerCompany(env, 'shipper');
    const input = shipmentInput(env);
    Object.assign(input.delivery, {
      addressLine: 'Karl Johans gate 1',
      postcode: '0154',
      city: 'Oslo',
      country: 'NO',
      lat: 59.9111,
      lng: 10.7503,
    });
    const res = await shipper.client.post('/api/shipments', input);
    expect(res.data.customs.result).toBe('required');
    expect(res.data.customs.procedures.map((p: { kind: string }) => p.kind)).toEqual([
      'export',
      'import',
    ]);
  });
});
