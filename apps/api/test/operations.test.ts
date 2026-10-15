import { eq, sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { carrierObligations, files, payouts, shipments } from '../src/db/schema';
import { balance } from '../src/services/ledger';
import {
  adminClient,
  settledBankDetails,
  bookedWithDriver,
  carrierWithDriver,
  Client,
  key,
  PNG,
  publishedShipment,
  registerCompany,
  tripEvent,
  upload,
  useTestEnv,
} from './helpers';

const env = useTestEnv();

async function deliver(t: Awaited<ReturnType<typeof bookedWithDriver>>) {
  const d = t.driver;
  expect(
    (await d.post(`/api/shipments/${t.shipmentId}/trip-events`, tripEvent(env, 'pickup.arrived')))
      .statusCode,
  ).toBe(201);
  expect(
    (
      await d.post(
        `/api/shipments/${t.shipmentId}/trip-events`,
        tripEvent(env, 'pickup.loaded', { countedUnits: 10 }),
      )
    ).statusCode,
  ).toBe(201);
  const sig = await upload(env, d, t.shipmentId, 'signature');
  const photo = await upload(env, d, t.shipmentId, 'photo');
  const res = await d.post(
    `/api/shipments/${t.shipmentId}/trip-events`,
    tripEvent(env, 'delivery.delivered', {
      countedUnits: 10,
      recipientName: 'Bram de Vries',
      signatureFileId: sig.data.id,
      photoFileIds: [photo.data.id],
    }),
  );
  expect(res.statusCode).toBe(201);
  await env.jobs();
}

describe('drivers', () => {
  it('a driver is invited, joins, and is offered for jobs with empty kilometres; licence rules apply', async () => {
    const shipper = await registerCompany(env, 'shipper');
    const c = await carrierWithDriver(env);
    // A second driver with only a car licence
    await c.carrier.client.post('/api/carrier/drivers', {
      name: 'Ben Van',
      email: 'ben@example.com',
      licenceCategories: ['B'],
      licenceValidUntil: '2030-01-01',
    });
    const list = await c.carrier.client.get('/api/carrier/drivers');
    expect(list.data.find((d: { name: string }) => d.name === 'Dana Driver').linked).toBe(true);
    const s = await publishedShipment(env, shipper.client);
    const acc = await c.carrier.client.post(`/api/carrier/loads/${s.id}/accept`, {
      vehicleId: c.carrier.vehicleId,
      idempotencyKey: key(),
    });
    const options = await c.carrier.client.get(
      `/api/carrier/bookings/${acc.data.bookingId}/assign-options`,
    );
    expect(options.data[0]).toMatchObject({
      name: 'Dana Driver',
      problems: [],
      locationSource: 'vehicle_base',
    });
    expect(options.data[0].deadheadKm).toBeGreaterThan(0);
    const ben = options.data.find((o: { name: string }) => o.name === 'Ben Van');
    expect(ben.problems.map((p: { code: string }) => p.code)).toEqual(
      expect.arrayContaining(['driver_not_linked', 'licence_category', 'cpc_expired']),
    );
    expect(
      (
        await c.carrier.client.post(`/api/carrier/bookings/${acc.data.bookingId}/assign`, {
          driverId: ben.id,
        })
      ).data.error,
    ).toBe('driver_not_eligible');
    expect(
      (
        await c.carrier.client.post(`/api/carrier/bookings/${acc.data.bookingId}/assign`, {
          driverId: c.driverId,
        })
      ).statusCode,
    ).toBe(200);
    const jobs = await c.driver.get('/api/driver/jobs');
    expect(jobs.data[0]).toMatchObject({
      shipmentId: s.id,
      status: 'booked',
      pickup: { addressLine: 'Am Sandtorkai 1', contactName: 'Anna' },
    });
    expect(JSON.stringify(jobs.data)).not.toMatch(/maxPriceMinor|payoutMinor|totalMinor/);
  });

  it('drivers cannot see loads, prices, earnings or company settings', async () => {
    const c = await carrierWithDriver(env);
    for (const url of [
      '/api/carrier/loads',
      '/api/carrier/bookings',
      '/api/carrier/earnings',
      '/api/org/members',
      '/api/carrier/drivers',
    ])
      expect((await c.driver.get(url)).statusCode, url).toBe(403);
  });
});

describe('on the road', () => {
  it('pickup confirmation needs a count; a difference needs a description; order is enforced; retries are safe', async () => {
    const t = await bookedWithDriver(env);
    const d = t.driver;
    const url = `/api/shipments/${t.shipmentId}/trip-events`;
    expect((await d.post(url, tripEvent(env, 'delivery.arrived'))).data.error).toBe('not_loaded');
    expect((await d.post(url, tripEvent(env, 'pickup.loaded'))).data.error).toBe('count_required');
    expect(
      (await d.post(url, tripEvent(env, 'pickup.loaded', { countedUnits: 9 }))).data.error,
    ).toBe('discrepancy_required');
    const ev = tripEvent(env, 'pickup.loaded', {
      countedUnits: 9,
      discrepancy: 'One pallet not ready',
    });
    const first = await d.post(url, ev);
    expect(first.statusCode).toBe(201);
    const again = await d.post(url, ev);
    expect(again.statusCode).toBe(200);
    expect(again.data).toMatchObject({ duplicate: true, event: { id: first.data.event.id } });
    const [s] = await env.ctx.db.select().from(shipments).where(eq(shipments.id, t.shipmentId));
    expect(s!.status).toBe('in_transit');
    const future = tripEvent(env, 'pickup.departed', {
      occurredAt: new Date(env.clock.now.getTime() + 3_600_000).toISOString(),
    });
    expect((await d.post(url, future)).data.error).toBe('time_in_future');
  });

  it('positions only from the assigned driver while the job is active; the shipper sees progress and ETA but not the driver', async () => {
    const t = await bookedWithDriver(env);
    const pos = { positions: [{ at: env.clock.now.toISOString(), lat: 53.0, lng: 8.8 }] };
    expect(
      (await t.carrier.client.post(`/api/shipments/${t.shipmentId}/positions`, pos)).statusCode,
    ).toBe(403);
    expect(
      (await t.driver.post(`/api/shipments/${t.shipmentId}/positions`, pos)).data.accepted,
    ).toBe(1);
    // Before collection the shipper sees no position
    expect(
      (await t.shipper.client.get(`/api/shipments/${t.shipmentId}/trip`)).data.position,
    ).toBeNull();
    await t.driver.post(
      `/api/shipments/${t.shipmentId}/trip-events`,
      tripEvent(env, 'pickup.loaded', { countedUnits: 10 }),
    );
    await t.driver.post(`/api/shipments/${t.shipmentId}/positions`, {
      positions: [{ at: env.clock.now.toISOString(), lat: 52.5, lng: 6.0 }],
    });
    const view = await t.shipper.client.get(`/api/shipments/${t.shipmentId}/trip`);
    expect(view.data.position).toMatchObject({ lat: 52.5, lng: 6.0 });
    expect(view.data.eta.remainingKm).toBeGreaterThan(100);
    expect(view.data.eta.source).toBe('straight_line_estimate');
    expect(JSON.stringify(view.data)).not.toMatch(/Dana|recordedBy|recordedAs/);
  });

  it('delivery needs a recipient and a signature or photo; produces a proof of delivery PDF', async () => {
    const t = await bookedWithDriver(env);
    const url = `/api/shipments/${t.shipmentId}/trip-events`;
    await t.driver.post(url, tripEvent(env, 'pickup.loaded', { countedUnits: 10 }));
    expect(
      (await t.driver.post(url, tripEvent(env, 'delivery.delivered', { countedUnits: 10 }))).data
        .error,
    ).toBe('recipient_required');
    expect(
      (
        await t.driver.post(
          url,
          tripEvent(env, 'delivery.delivered', { countedUnits: 10, recipientName: 'Bram' }),
        )
      ).data.error,
    ).toBe('evidence_required');
    const sig = await upload(env, t.driver, t.shipmentId, 'signature');
    expect(sig.statusCode).toBe(200);
    expect(
      (
        await t.driver.post(
          url,
          tripEvent(env, 'delivery.delivered', {
            countedUnits: 10,
            recipientName: 'Bram',
            signatureFileId: sig.data.id,
          }),
        )
      ).statusCode,
    ).toBe(201);
    await env.jobs();
    const trip = await t.shipper.client.get(`/api/shipments/${t.shipmentId}/trip`);
    expect(trip.data.status).toBe('delivered');
    expect(trip.data.podFileId).toBeTruthy();
    const pdf = await env.app.inject({
      method: 'GET',
      url: `/api/files/${trip.data.podFileId}`,
      headers: { cookie: t.shipper.client.cookie },
    });
    expect(pdf.statusCode).toBe(200);
    expect(pdf.headers['content-type']).toBe('application/pdf');
    expect(pdf.rawPayload.subarray(0, 4).toString()).toBe('%PDF');
    // Nothing more can be recorded after delivery
    expect((await t.driver.post(url, tripEvent(env, 'note', { note: 'x' }))).data.error).toBe(
      'trip_closed',
    );
  });

  it('refuses uploads that are not really images or PDFs', async () => {
    const t = await bookedWithDriver(env);
    const fake = await upload(
      env,
      t.driver,
      t.shipmentId,
      'photo',
      Buffer.from('<html>not an image</html>'),
      'image/png',
    );
    expect(fake.data.error).toBe('file_type');
  });
});

describe('files and messages are private', () => {
  it('an unrelated company cannot open a shipment’s files or messages (404)', async () => {
    const t = await bookedWithDriver(env);
    const photo = await upload(env, t.driver, t.shipmentId, 'photo');
    const stranger = await registerCompany(env, 'shipper');
    const get = await env.app.inject({
      method: 'GET',
      url: `/api/files/${photo.data.id}`,
      headers: { cookie: stranger.client.cookie },
    });
    expect(get.statusCode).toBe(404);
    const anon = await env.app.inject({ method: 'GET', url: `/api/files/${photo.data.id}` });
    expect(anon.statusCode).toBe(404);
    const own = await env.app.inject({
      method: 'GET',
      url: `/api/files/${photo.data.id}`,
      headers: { cookie: t.shipper.client.cookie },
    });
    expect(own.statusCode).toBe(200);
    expect(own.rawPayload.equals(PNG)).toBe(true);
    expect((await stranger.client.get(`/api/shipments/${t.shipmentId}/messages`)).statusCode).toBe(
      404,
    );
    expect((await upload(env, stranger.client, t.shipmentId)).statusCode).toBe(404);
  });

  it('shipper, carrier and driver talk on the shipment', async () => {
    const t = await bookedWithDriver(env);
    await t.shipper.client.post(`/api/shipments/${t.shipmentId}/messages`, {
      body: 'Please call 30 min before arrival',
    });
    await t.driver.post(`/api/shipments/${t.shipmentId}/messages`, { body: 'Will do' });
    const list = await t.carrier.client.get(`/api/shipments/${t.shipmentId}/messages`);
    expect(
      list.data.map(
        (m: { senderRole: string; senderName: string }) => `${m.senderRole}:${m.senderName}`,
      ),
    ).toEqual(['shipper:Test', 'driver:Dana']);
  });
});

describe('acceptance, completion and payout', () => {
  it('confirmed delivery completes the job, earns the fee and pays the carrier once bank details exist', async () => {
    const t = await bookedWithDriver(env);
    await deliver(t);
    expect(
      (await t.carrier.client.post(`/api/shipments/${t.shipmentId}/confirm-delivery`)).statusCode,
    ).toBe(404); // only the customer
    expect(
      (await t.shipper.client.post(`/api/shipments/${t.shipmentId}/confirm-delivery`)).statusCode,
    ).toBe(200);
    await env.jobs();
    const [s] = await env.ctx.db.select().from(shipments).where(eq(shipments.id, t.shipmentId));
    expect(s!.status).toBe('completed');
    const [o] = await env.ctx.db.select().from(carrierObligations);
    expect(o!.status).toBe('payable');
    expect(await balance(env.ctx.db, 'platform_revenue', null, 'EUR')).toBeGreaterThan(0);
    expect(await balance(env.ctx.db, 'platform_revenue_deferred', null, 'EUR')).toBe(0);
    // No bank details yet: nothing sent, the carrier is told
    expect(await env.ctx.db.select().from(payouts)).toHaveLength(0);
    expect(
      (
        await t.carrier.client.put('/api/org/payout-account', {
          holderName: 'Nordtrans',
          iban: 'DE00 1234 5678 9012 3456 78',
        })
      ).data.error,
    ).toBe('bad_iban');
    expect(
      (
        await t.carrier.client.put('/api/org/payout-account', {
          holderName: 'Nordtrans GmbH',
          iban: 'DE89 3704 0044 0532 0130 00',
        })
      ).statusCode,
    ).toBe(200);
    // New bank details hold the payout for review; treat them as entered days ago
    await env.ctx.db.execute(
      sql`UPDATE payout_accounts SET updated_at = now() - interval '3 days'`,
    );
    await env.jobs();
    const [p] = await env.ctx.db.select().from(payouts);
    expect(p).toMatchObject({
      status: 'pending',
      amountMinor: o!.amountMinor,
      ibanMasked: 'DE89 •••• 3000',
    });
    expect(await balance(env.ctx.db, 'carrier_payable', t.carrier.orgId, 'EUR')).toBe(0);
    const hook = env.ctx.payments.makeWebhook!({
      id: 'evt-payout',
      type: 'payout.paid',
      data: { providerRef: p!.providerRef!, amountMinor: p!.amountMinor, currency: 'EUR' },
    });
    const res = await env.app.inject({
      method: 'POST',
      url: '/api/webhooks/payments',
      headers: { 'content-type': 'application/json', 'x-signature': hook.signature },
      payload: hook.body,
    });
    expect(res.json().result).toBe('paid');
    const earnings = await t.carrier.client.get('/api/carrier/earnings');
    expect(earnings.data.totals.paidMinor).toBe(o!.amountMinor);
    expect(earnings.data.account.iban).toBe('DE89 •••• 3000');
  });

  it('is accepted automatically after the acceptance period; a failed payout puts the money back on hold', async () => {
    const t = await bookedWithDriver(env);
    await settledBankDetails(env, t.carrier.client, t.carrier.orgId);
    await deliver(t);
    env.advance(47 * 60);
    await env.jobs();
    expect(
      (await env.ctx.db.select().from(shipments).where(eq(shipments.id, t.shipmentId)))[0]!.status,
    ).toBe('delivered');
    env.advance(61);
    await env.jobs();
    expect(
      (await env.ctx.db.select().from(shipments).where(eq(shipments.id, t.shipmentId)))[0]!.status,
    ).toBe('completed');
    const [p] = await env.ctx.db.select().from(payouts);
    const hook = env.ctx.payments.makeWebhook!({
      id: 'evt-pf',
      type: 'payout.failed',
      data: {
        providerRef: p!.providerRef!,
        amountMinor: p!.amountMinor,
        currency: 'EUR',
        reason: 'account closed',
      },
    });
    await env.app.inject({
      method: 'POST',
      url: '/api/webhooks/payments',
      headers: { 'content-type': 'application/json', 'x-signature': hook.signature },
      payload: hook.body,
    });
    const [o] = await env.ctx.db.select().from(carrierObligations);
    expect(o!.status).toBe('on_hold');
    expect(await balance(env.ctx.db, 'carrier_payable', t.carrier.orgId, 'EUR')).toBe(
      o!.amountMinor,
    );
    // New bank details retry the payout
    await t.carrier.client.put('/api/org/payout-account', {
      holderName: 'Nordtrans GmbH',
      iban: 'NL91ABNA0417164300',
    });
    await env.jobs();
    // A change just before paying out is held for review until an admin releases it
    expect((await env.ctx.db.select().from(carrierObligations))[0]!.status).toBe('on_hold');
    const admin = await adminClient(env);
    const alerts = await admin.get('/api/admin/fraud-alerts');
    const hold = alerts.data.find(
      (a: { kind: string }) => a.kind === 'payout_account_recently_changed',
    );
    expect(hold).toBeTruthy();
    expect(
      (
        await admin.post(`/api/admin/fraud-alerts/${hold.id}/review`, {
          decision: 'dismissed',
          note: 'Called the carrier, change confirmed',
        })
      ).statusCode,
    ).toBe(200);
    await env.jobs();
    const all = await env.ctx.db.select().from(payouts);
    expect(all.map((x) => x.status).sort()).toEqual(['failed', 'pending']);
    expect(await balance(env.ctx.db, 'carrier_payable', t.carrier.orgId, 'EUR')).toBe(0);
  });

  it('records stored files with a hash', async () => {
    const t = await bookedWithDriver(env);
    await upload(env, t.driver, t.shipmentId, 'photo');
    const [f] = await env.ctx.db.select().from(files);
    expect(f!.sha256).toMatch(/^[0-9a-f]{64}$/);
  });
});

void Client;

describe('mobile app access', () => {
  it('logs in with a bearer token (no CSRF header needed) and uploads base64 photos', async () => {
    const t = await bookedWithDriver(env);
    const login = await env.app.inject({
      method: 'POST',
      url: '/api/auth/token',
      headers: { 'content-type': 'application/json', 'x-requested-with': 'freight' },
      payload: JSON.stringify({ email: t.driverEmail, password: 'driver password long' }),
    });
    const token = login.json().token as string;
    expect(token).toBeTruthy();
    const auth = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
    const jobs = await env.app.inject({ method: 'GET', url: '/api/driver/jobs', headers: auth });
    expect(jobs.json()[0].shipmentId).toBe(t.shipmentId);
    const up = await env.app.inject({
      method: 'POST',
      url: `/api/shipments/${t.shipmentId}/files/base64`,
      headers: auth,
      payload: JSON.stringify({
        kind: 'photo',
        contentType: 'image/png',
        data: `data:image/png;base64,${PNG.toString('base64')}`,
      }),
    });
    expect(up.statusCode).toBe(200);
    const ev = await env.app.inject({
      method: 'POST',
      url: `/api/shipments/${t.shipmentId}/trip-events`,
      headers: auth,
      payload: JSON.stringify(
        tripEvent(env, 'pickup.loaded', { countedUnits: 10, photoFileIds: [up.json().id] }),
      ),
    });
    expect(ev.statusCode).toBe(201);
  });
});
