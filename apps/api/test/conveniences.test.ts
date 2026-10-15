import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { emailOutbox } from '../src/db/schema';
import {
  key,
  publishedShipment,
  readyCarrier,
  registerCompany,
  shipmentInput,
  useTestEnv,
} from './helpers';

const env = useTestEnv();

const place = {
  label: 'Main warehouse',
  addressLine: 'Am Sandtorkai 1',
  postcode: '20457',
  city: 'Hamburg',
  country: 'DE',
  lat: 53.54,
  lng: 9.99,
  hasForklift: true,
  hasLoadingDock: true,
};

describe('saved places', () => {
  it('saves, updates instead of duplicating, lists and deletes; other companies cannot see them', async () => {
    const a = await registerCompany(env, 'shipper');
    const b = await registerCompany(env, 'shipper');
    const first = await a.client.post('/api/addresses', place);
    expect(first.statusCode).toBe(200);
    await a.client.post('/api/addresses', { ...place, label: 'Warehouse Hamburg' });
    const list = await a.client.get('/api/addresses');
    expect(list.data).toHaveLength(1);
    expect(list.data[0].label).toBe('Warehouse Hamburg');
    expect((await b.client.get('/api/addresses')).data).toHaveLength(0);
    expect((await b.client.req('DELETE', `/api/addresses/${first.data.id}`)).statusCode).toBe(404);
    expect((await a.client.req('DELETE', `/api/addresses/${first.data.id}`)).statusCode).toBe(200);
  });
});

describe('book again', () => {
  it('returns the places, cargo, service and maximum of an earlier shipment', async () => {
    const a = await registerCompany(env, 'shipper');
    const res = await a.client.post(
      '/api/shipments',
      shipmentInput(env, { serviceLevel: 'priority' }),
    );
    const tpl = await a.client.get(`/api/shipments/${res.data.id}/template`);
    expect(tpl.data).toMatchObject({
      serviceLevel: 'priority',
      maxPriceMinor: 200_000,
      pickup: { city: 'Hamburg' },
      delivery: { city: 'Rotterdam' },
    });
    expect(tpl.data.cargo.lines[0]).toMatchObject({ quantity: 10, kind: 'eur_pallet' });
    const other = await registerCompany(env, 'shipper');
    expect((await other.client.get(`/api/shipments/${res.data.id}/template`)).statusCode).toBe(404);
  });
});

describe('notifications by email', () => {
  it('emails the shipper when a carrier is booked, and respects the person turning it off', async () => {
    const shipper = await registerCompany(env, 'shipper');
    const carrier = await readyCarrier(env);
    const s = await publishedShipment(env, shipper.client);
    await carrier.client.post(`/api/carrier/loads/${s.id}/accept`, {
      vehicleId: carrier.vehicleId,
      idempotencyKey: key(),
    });
    await env.jobs();
    const mails = await env.ctx.db
      .select()
      .from(emailOutbox)
      .where(eq(emailOutbox.to, shipper.email));
    expect(mails.map((m) => m.template)).toContain('notification:shipment.booked');
    expect((await shipper.client.get('/api/notifications')).data[0].kind).toBe('shipment.booked');

    // Turn the carrier's "new job" email off, then book another
    expect(
      (
        await carrier.client.put('/api/me/settings', {
          locale: 'de',
          notificationPrefs: { 'booking.confirmed': { email: false } },
        })
      ).statusCode,
    ).toBe(200);
    const s2 = await publishedShipment(env, shipper.client);
    await carrier.client.post(`/api/carrier/loads/${s2.id}/accept`, {
      vehicleId: carrier.vehicleId,
      idempotencyKey: key(),
    });
    await env.jobs();
    const carrierMails = await env.ctx.db
      .select()
      .from(emailOutbox)
      .where(eq(emailOutbox.to, carrier.email));
    expect(
      carrierMails.filter((m) => m.template === 'notification:booking.confirmed'),
    ).toHaveLength(1);
    expect((await carrier.client.get('/api/me/settings')).data.locale).toBe('de');
  });
});
