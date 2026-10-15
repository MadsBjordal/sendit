import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { bookings } from '../src/db/schema';
import {
  key,
  publishedShipment,
  readyCarrier,
  registerCompany,
  shipmentInput,
  useTestEnv,
} from './helpers';

const env = useTestEnv();
const iso = (hours: number) => new Date(env.clock.now.getTime() + hours * 3_600_000).toISOString();

describe('return loads and performance', () => {
  it('suggests loads starting near the delivery that bring the truck home, and leaves far ones out', async () => {
    const shipper = await registerCompany(env, 'shipper');
    const carrier = await readyCarrier(env); // based in Hannover
    const out = await publishedShipment(env, shipper.client); // Hamburg → Rotterdam
    const acc = await carrier.client.post(`/api/carrier/loads/${out.id}/accept`, {
      vehicleId: carrier.vehicleId,
      idempotencyKey: key(),
    });
    expect(acc.data.result).toBe('booked');
    const [b] = await env.ctx.db.select().from(bookings).where(eq(bookings.shipmentId, out.id));

    const base = shipmentInput(env);
    // Rotterdam → Hannover: the way home
    const home = await publishedShipment(env, shipper.client, {
      pickup: { ...base.delivery, city: 'Rotterdam', windowStart: iso(70), windowEnd: iso(78) },
      delivery: {
        ...base.pickup,
        city: 'Hannover',
        lat: 52.37,
        lng: 9.73,
        postcode: '30159',
        windowStart: iso(84),
        windowEnd: iso(100),
      },
    });
    // Munich → Hamburg: starts far from Rotterdam
    const far = await publishedShipment(env, shipper.client, {
      pickup: {
        ...base.pickup,
        city: 'München',
        lat: 48.137,
        lng: 11.575,
        postcode: '80331',
        windowStart: iso(70),
        windowEnd: iso(78),
      },
      delivery: { ...base.pickup, windowStart: iso(90), windowEnd: iso(110) },
    });

    const res = await carrier.client.get(`/api/carrier/bookings/${b!.id}/return-loads`);
    expect(res.statusCode).toBe(200);
    const ids = res.data.map((x: { shipmentId: string }) => x.shipmentId);
    expect(ids).toContain(home.id);
    expect(ids).not.toContain(far.id);
    const h = res.data.find((x: { shipmentId: string }) => x.shipmentId === home.id);
    expect(h.emptyKm).toBeLessThan(10);
    expect(h.closerToBaseKm).toBeGreaterThan(200);

    // Another carrier cannot ask about this booking
    const other = await readyCarrier(env);
    expect((await other.client.get(`/api/carrier/bookings/${b!.id}/return-loads`)).statusCode).toBe(
      404,
    );

    const perf = await carrier.client.get('/api/carrier/performance');
    expect(perf.data).toMatchObject({ jobs: 1, delivered: 0, standing: 'new' });
  });
});
