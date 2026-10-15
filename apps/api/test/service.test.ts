import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import {
  bookings,
  carrierObligations,
  fraudAlerts,
  invoices,
  organisations,
  payments,
  refunds,
  shipments,
  users,
} from '../src/db/schema';
import { balance } from '../src/services/ledger';
import {
  adminClient,
  bookedWithDriver,
  Client,
  key,
  publishedShipment,
  readyCarrier,
  registerCompany,
  settledBankDetails,
  shipmentInput,
  tripEvent,
  upload,
  useTestEnv,
} from './helpers';

const env = useTestEnv();

async function delivered() {
  const t = await bookedWithDriver(env);
  await settledBankDetails(env, t.carrier.client, t.carrier.orgId);
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
      damage: true,
      damageNote: 'Corner of pallet 3 crushed',
    }),
  );
  await env.jobs();
  return t;
}

describe('disputes', () => {
  it('a dispute holds the payout; support splits the refund between carrier and platform; books still reconcile', async () => {
    const t = await delivered();
    const photo = await upload(env, t.shipper.client, t.shipmentId, 'evidence');
    const d = await t.shipper.client.post(`/api/shipments/${t.shipmentId}/disputes`, {
      kind: 'damage',
      description: 'Pallet 3 arrived crushed, goods unusable',
      evidenceFileIds: [photo.data.id],
    });
    expect(d.statusCode).toBe(200);
    // Automatic acceptance does not happen while disputed
    env.advance(49 * 60);
    await env.jobs();
    const [s] = await env.ctx.db.select().from(shipments).where(eq(shipments.id, t.shipmentId));
    expect(s!.status).toBe('disputed');
    const [o] = await env.ctx.db.select().from(carrierObligations);
    expect(o!.status).toBe('disputed');
    const admin = await adminClient(env);
    expect((await admin.get('/api/admin/disputes?status=open')).data).toHaveLength(1);
    const [b] = await env.ctx.db.select().from(bookings);
    expect(
      (
        await admin.post(`/api/admin/disputes/${d.data.id}/resolve`, {
          decision: 'resolved',
          customerRefundMinor: 10_000,
          carrierDeductionMinor: 12_000,
          note: 'x x x',
        })
      ).data.error,
    ).toBe('deduction_too_high');
    expect(
      (
        await admin.post(`/api/admin/disputes/${d.data.id}/resolve`, {
          decision: 'resolved',
          customerRefundMinor: 10_000,
          carrierDeductionMinor: 6_000,
          note: 'Photos confirm damage in transit',
        })
      ).statusCode,
    ).toBe(200);
    await env.jobs();
    const [after] = await env.ctx.db.select().from(carrierObligations);
    expect(after!.amountMinor).toBe(b!.payoutMinor - 6_000);
    expect(
      (await env.ctx.db.select().from(refunds).where(eq(refunds.reason, 'dispute'))).map(
        (r) => r.amountMinor,
      ),
    ).toEqual([10_000]);
    expect(await balance(env.ctx.db, 'platform_revenue', null, 'EUR')).toBe(
      b!.platformFeeMinor - 4_000,
    );
    expect(
      (await env.ctx.db.select().from(shipments).where(eq(shipments.id, t.shipmentId)))[0]!.status,
    ).toBe('completed');
    const rec = await admin.get('/api/admin/reconciliation');
    expect(rec.data.checks.filter((c: { ok: boolean }) => !c.ok)).toEqual([]);
  });

  it('cannot be opened before delivery or by someone else', async () => {
    const t = await bookedWithDriver(env);
    expect(
      (
        await t.shipper.client.post(`/api/shipments/${t.shipmentId}/disputes`, {
          kind: 'late',
          description: 'Not here yet, very late',
        })
      ).data.error,
    ).toBe('cannot_dispute');
    expect(
      (
        await t.carrier.client.post(`/api/shipments/${t.shipmentId}/disputes`, {
          kind: 'other',
          description: 'Waiting time at pickup',
        })
      ).statusCode,
    ).toBe(404);
  });

  it('a rejected dispute completes the job with the full payout', async () => {
    const t = await delivered();
    const d = await t.shipper.client.post(`/api/shipments/${t.shipmentId}/disputes`, {
      kind: 'shortage',
      description: 'One pallet missing in our count',
    });
    const admin = await adminClient(env);
    await admin.post(`/api/admin/disputes/${d.data.id}/resolve`, {
      decision: 'rejected',
      note: 'Signed proof of delivery shows 10 units',
    });
    await env.jobs();
    const [o] = await env.ctx.db.select().from(carrierObligations);
    const [b] = await env.ctx.db.select().from(bookings);
    expect(o).toMatchObject({ status: 'payable', amountMinor: b!.payoutMinor });
  });
});

describe('fraud alerts', () => {
  it('raises alerts for chargebacks, shared bank accounts, repeated failed payments and odd maximums; confirming can suspend', async () => {
    const shipper = await registerCompany(env, 'shipper');
    const s = await publishedShipment(env, shipper.client);
    const [p] = await env.ctx.db.select().from(payments).where(eq(payments.shipmentId, s.id));
    const cb = env.ctx.payments.makeWebhook!({
      id: 'evt-cb2',
      type: 'dispute.created',
      data: { providerRef: p!.providerRef, amountMinor: 5_000, currency: 'EUR' },
    });
    await env.app.inject({
      method: 'POST',
      url: '/api/webhooks/payments',
      headers: { 'content-type': 'application/json', 'x-signature': cb.signature },
      payload: cb.body,
    });
    const a = await readyCarrier(env);
    const b = await readyCarrier(env);
    await a.client.put('/api/org/payout-account', {
      holderName: 'Alpha GmbH',
      iban: 'DE89370400440532013000',
    });
    await b.client.put('/api/org/payout-account', {
      holderName: 'Beta GmbH',
      iban: 'DE89370400440532013000',
    });
    for (let i = 0; i < 3; i++) {
      const r = await shipper.client.post('/api/shipments', shipmentInput(env));
      await shipper.client.post(`/api/test-payments/${r.data.payment.paymentRef}/complete`, {
        outcome: 'fail',
      });
    }
    await shipper.client.post('/api/shipments', shipmentInput(env, { maxPriceMinor: 9_000_000 }));
    const admin = await adminClient(env);
    const alerts = await admin.get('/api/admin/fraud-alerts');
    expect(alerts.data.map((x: { kind: string }) => x.kind).sort()).toEqual([
      'chargeback',
      'maximum_far_above_estimate',
      'repeated_failed_payments',
      'shared_payout_account',
    ]);
    const shared = alerts.data.find((x: { kind: string }) => x.kind === 'shared_payout_account');
    await admin.post(`/api/admin/fraud-alerts/${shared.id}/review`, {
      decision: 'confirmed',
      note: 'Same owner, fake company',
      suspend: true,
    });
    const [org] = await env.ctx.db
      .select()
      .from(organisations)
      .where(eq(organisations.id, b.orgId));
    expect(org!.status).toBe('suspended');
    // A suspended carrier cannot take loads
    const s2 = await publishedShipment(env, shipper.client);
    expect(
      (
        await b.client.post(`/api/carrier/loads/${s2.id}/accept`, {
          vehicleId: b.vehicleId,
          idempotencyKey: key(),
        })
      ).data.result,
    ).toBe('not_eligible');
    expect(await env.ctx.db.select().from(fraudAlerts)).toHaveLength(4);
  });
});

describe('support', () => {
  it('a company opens a ticket, support answers; other companies cannot see it', async () => {
    const shipper = await registerCompany(env, 'shipper');
    const other = await registerCompany(env, 'shipper');
    const t = await shipper.client.post('/api/support/tickets', {
      subject: 'Invoice address',
      body: 'Please change our invoice address',
    });
    expect((await other.client.get(`/api/support/tickets/${t.data.id}`)).statusCode).toBe(404);
    expect((await other.client.get('/api/support/tickets')).data).toHaveLength(0);
    const admin = await adminClient(env);
    expect((await admin.get('/api/support/tickets?status=open')).data).toHaveLength(1);
    await admin.post(`/api/support/tickets/${t.data.id}/reply`, {
      body: 'Done, it applies from the next invoice',
    });
    const detail = await shipper.client.get(`/api/support/tickets/${t.data.id}`);
    expect(detail.data).toMatchObject({ status: 'answered' });
    expect(detail.data.messages.map((m: { name: string }) => m.name)).toEqual([
      'Test Person',
      'Support',
    ]);
    expect((await shipper.client.get('/api/notifications')).data[0].kind).toBe('support.answered');
  });
});

describe('privacy', () => {
  it('exports my own data only; erasure removes name, email and login but keeps financial records', async () => {
    const t = await delivered();
    const exp = await t.shipper.client.get('/api/me/data-export');
    expect(exp.data.user.email).toBe(t.shipper.email);
    expect(JSON.stringify(exp.data)).not.toContain(t.carrier.email);
    expect(
      (await t.shipper.client.post('/api/me/erasure-request', { note: 'Closing our account' }))
        .statusCode,
    ).toBe(200);
    const admin = await adminClient(env);
    const reqs = await admin.get('/api/admin/privacy-requests');
    const erase = reqs.data.find((r: { kind: string }) => r.kind === 'erase');
    await admin.post(`/api/admin/privacy-requests/${erase.id}`, {
      decision: 'completed',
      note: 'Invoices kept for 10 years (legal duty)',
    });
    const [u] = await env.ctx.db.select().from(users).where(eq(users.id, t.shipper.userId));
    expect(u).toMatchObject({ name: 'Deleted user', active: false });
    expect(
      (
        await new Client(env).post('/api/auth/login', {
          email: t.shipper.email,
          password: 'correct horse battery staple',
        })
      ).statusCode,
    ).toBe(401);
    expect((await t.shipper.client.get('/api/auth/me')).statusCode).toBe(401);
    expect(await env.ctx.db.select().from(invoices)).not.toHaveLength(0);
  });
});

describe('analytics', () => {
  it('reports gross freight value apart from revenue, and exports CSV and Excel', async () => {
    const t = await delivered();
    await t.shipper.client.post(`/api/shipments/${t.shipmentId}/confirm-delivery`);
    const shipper = await registerCompany(env, 'shipper');
    await shipper.client.post('/api/shipments', shipmentInput(env));
    await env.jobs();
    const admin = await adminClient(env);
    const r = await admin.get('/api/admin/analytics?from=2026-01-01&to=2027-12-31');
    const [b] = await env.ctx.db.select().from(bookings);
    expect(r.data.shipments).toMatchObject({ requests: 2, booked: 1, completed: 1 });
    expect(r.data.money.grossFreightValueMinor).toBe(b!.totalMinor);
    expect(r.data.money.marketplaceRevenueMinor).toBe(b!.platformFeeMinor);
    expect(r.data.money.grossFreightValueMinor).not.toBe(r.data.money.marketplaceRevenueMinor);
    expect(r.data.byCorridor[0].corridor).toBe('DE-NL');
    const csv = await env.app.inject({
      method: 'GET',
      url: '/api/admin/analytics?from=2026-01-01&to=2027-12-31&format=csv',
      headers: { cookie: admin.cookie },
    });
    expect(csv.headers['content-type']).toContain('text/csv');
    expect(csv.body.split('\n')[0]).toBe('metric,value');
    const xlsx = await env.app.inject({
      method: 'GET',
      url: '/api/admin/analytics?from=2026-01-01&to=2027-12-31&format=xlsx',
      headers: { cookie: admin.cookie },
    });
    expect(xlsx.rawPayload.subarray(0, 2).toString()).toBe('PK');
    // Not for companies
    expect(
      (await shipper.client.get('/api/admin/analytics?from=2026-01-01&to=2027-12-31')).statusCode,
    ).toBe(403);
  });
});
