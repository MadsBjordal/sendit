import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { desc, eq, sql } from 'drizzle-orm';
import { afterAll, beforeEach } from 'vitest';
import type { ShipmentInput, VehicleInput } from '@freight/shared';
import { buildApp } from '../src/app';
import { loadConfig } from '../src/config';
import type { Ctx } from '../src/context';
import { emailOutbox, organisations, verificationDocuments } from '../src/db/schema';
import { ensurePlatformAdmin, ensurePricing, openCountries } from '../src/db/seed-lib';
import { totp } from '../src/lib/crypto';
import { makeContext } from '../src/services/index';
import { runDueJobs } from '../src/services/jobs';

const TEST_DB =
  process.env.TEST_DATABASE_URL ?? 'postgres://freight:freight@localhost:55432/freight_test';

export interface TestEnv {
  ctx: Ctx & { close(): Promise<void> };
  app: FastifyInstance;
  clock: { now: Date };
  /** Moves the test clock forward */
  advance(minutes: number): void;
  jobs(): Promise<number>;
}

const silent = {
  info() {},
  warn() {},
  error(e: unknown) {
    console.error(e);
  },
};

/** One app + database context per test file; tables are emptied before each test. */
export function useTestEnv(): TestEnv {
  const config = loadConfig({
    DATABASE_URL: TEST_DB,
    NODE_ENV: 'test',
    PAYMENT_WEBHOOK_SECRET: 'test-secret',
  });
  const clock = { now: new Date('2026-11-02T08:00:00Z') };
  const ctx = makeContext(config, silent);
  ctx.now = () => new Date(clock.now);
  const env: TestEnv = {
    ctx,
    app: undefined as unknown as FastifyInstance,
    clock,
    advance(minutes) {
      clock.now = new Date(clock.now.getTime() + minutes * 60_000);
    },
    jobs: () => runDueJobs(ctx, 500),
  };
  beforeEach(async () => {
    clock.now = new Date('2026-11-02T08:00:00Z');
    const tables = await ctx.db.execute<{ tablename: string }>(
      sql`SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> 'spatial_ref_sys'`,
    );
    await ctx.db.execute(
      sql.raw(
        `TRUNCATE ${tables.rows.map((t) => `"${t.tablename}"`).join(', ')} RESTART IDENTITY CASCADE`,
      ),
    );
    await ensurePricing(ctx.db);
    await openCountries(ctx.db, ['DE', 'NL', 'BE', 'FR', 'PL', 'NO', 'IT', 'ES', 'AT', 'GB', 'CH']);
    if (!env.app) env.app = await buildApp(ctx);
  });
  afterAll(async () => {
    await env.app?.close();
    await ctx.close();
  });
  return env;
}

/** A browser-like client: keeps its session cookie and sends the CSRF header. */
export class Client {
  cookie = '';
  constructor(private env: TestEnv) {}

  async req(
    method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
    url: string,
    body?: unknown,
    headers: Record<string, string> = {},
  ): Promise<LightMyRequestResponse & { body: string; data: any }> {
    const res = await this.env.app.inject({
      method,
      url,
      headers: {
        'x-requested-with': 'freight',
        ...(this.cookie ? { cookie: this.cookie } : {}),
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...headers,
      },
      payload: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const set = res.headers['set-cookie'];
    const first = Array.isArray(set) ? set[0] : set;
    if (first?.startsWith('pf_session=')) this.cookie = first.split(';')[0]!;
    let data: any = null;
    try {
      data = res.json();
    } catch {
      data = res.body;
    }
    return Object.assign(res, { data });
  }
  get(url: string) {
    return this.req('GET', url);
  }
  post(url: string, body: unknown = {}) {
    return this.req('POST', url, body);
  }
  put(url: string, body: unknown) {
    return this.req('PUT', url, body);
  }
}

let counter = 0;
const uniq = () => `${Date.now().toString(36)}${(counter++).toString(36)}`;

export async function lastEmailToken(env: TestEnv, to: string, template: string): Promise<string> {
  const [m] = await env.ctx.db
    .select()
    .from(emailOutbox)
    .where(eq(emailOutbox.to, to))
    .orderBy(desc(emailOutbox.createdAt));
  if (!m || m.template !== template) throw new Error(`no ${template} email to ${to}`);
  return /token=([A-Za-z0-9_-]+)/.exec(m.body)![1]!;
}

export async function registerCompany(
  env: TestEnv,
  kind: 'shipper' | 'carrier' | 'customs_provider',
  opts: { country?: string; verifyEmail?: boolean; name?: string } = {},
) {
  const c = new Client(env);
  const email = `${kind}-${uniq()}@example.com`;
  const res = await c.post('/api/auth/register', {
    organisation: { name: opts.name ?? `${kind} ${uniq()}`, kind, country: opts.country ?? 'DE' },
    user: { name: 'Test Person', email, password: 'correct horse battery staple' },
  });
  if (res.statusCode !== 200) throw new Error(`register failed: ${res.body}`);
  if (opts.verifyEmail !== false) {
    const token = await lastEmailToken(env, email, 'verify_email');
    const v = await c.post('/api/auth/verify-email', { token });
    if (v.statusCode !== 200) throw new Error(v.body);
  }
  return { client: c, email, orgId: res.data.orgId as string, userId: res.data.userId as string };
}

export const truck = (over: Partial<VehicleInput> = {}): VehicleInput => ({
  registration: `TR-${uniq()}`.slice(0, 20),
  registrationCountry: 'DE',
  vehicleClass: 'curtainsider',
  payloadKg: 24_000,
  lengthCm: 1360,
  widthCm: 245,
  heightCm: 270,
  palletPlaces: 33,
  equipment: [],
  baseLat: 52.37,
  baseLng: 9.73, // Hannover
  available: true,
  ...over,
});

/** A carrier that may take loads: verified, licence and insurance approved, one truck. */
export async function readyCarrier(
  env: TestEnv,
  opts: {
    countries?: string[];
    vehicle?: Partial<VehicleInput>;
    validUntil?: string;
    country?: string;
  } = {},
) {
  const c = await registerCompany(env, 'carrier', { country: opts.country });
  for (const kind of ['operator_licence', 'carrier_liability_insurance'])
    await c.client.post('/api/carrier/documents', {
      kind,
      reference: `${kind}-1`,
      issuerCountry: 'DE',
      validUntil: opts.validUntil ?? '2027-12-31',
    });
  await env.ctx.db
    .update(verificationDocuments)
    .set({ status: 'approved', reviewedAt: new Date() })
    .where(eq(verificationDocuments.orgId, c.orgId));
  await env.ctx.db
    .update(organisations)
    .set({ status: 'verified', verifiedAt: new Date() })
    .where(eq(organisations.id, c.orgId));
  await c.client.put('/api/carrier/operating-countries', {
    countries: opts.countries ?? ['DE', 'NL', 'BE', 'FR', 'PL', 'NO', 'IT'],
  });
  const v = await c.client.post('/api/carrier/vehicles', truck(opts.vehicle));
  if (v.statusCode !== 200) throw new Error(v.body);
  return { ...c, vehicleId: v.data.id as string };
}

export async function adminClient(env: TestEnv) {
  const email = `admin-${uniq()}@example.com`;
  const admin = await ensurePlatformAdmin(env.ctx.db, email, 'admin password long enough');
  const c = new Client(env);
  const res = await c.post('/api/auth/login', {
    email,
    password: 'admin password long enough',
    mfaCode: totp(admin.mfaSecret, env.clock.now.getTime()),
  });
  if (res.statusCode !== 200) throw new Error(res.body);
  return c;
}

const iso = (env: TestEnv, hours: number) =>
  new Date(env.clock.now.getTime() + hours * 3_600_000).toISOString();

/** Hamburg → Rotterdam, 10 pallets, standard, pickup in 2 days. */
export function shipmentInput(
  env: TestEnv,
  over: Partial<ShipmentInput> & { cargoOver?: Partial<ShipmentInput['cargo']> } = {},
): ShipmentInput {
  const { cargoOver, ...rest } = over;
  return {
    pickup: {
      addressLine: 'Am Sandtorkai 1',
      postcode: '20457',
      city: 'Hamburg',
      country: 'DE',
      lat: 53.5432,
      lng: 9.9894,
      contactName: 'Anna',
      contactPhone: '+49 40 123',
      windowStart: iso(env, 48),
      windowEnd: iso(env, 56),
      hasForklift: true,
      hasLoadingDock: true,
      instructions: null,
    },
    delivery: {
      addressLine: 'Maasvlakte Plaza 1',
      postcode: '3199 LZ',
      city: 'Rotterdam',
      country: 'NL',
      lat: 51.9563,
      lng: 4.0617,
      contactName: 'Bram',
      contactPhone: '+31 10 123',
      windowStart: iso(env, 60),
      windowEnd: iso(env, 80),
      hasForklift: true,
      hasLoadingDock: false,
      instructions: null,
    },
    cargo: {
      description: 'Packaged machine parts',
      category: 'machinery',
      lines: [
        {
          quantity: 10,
          kind: 'eur_pallet',
          lengthCm: 120,
          widthCm: 80,
          heightCm: 150,
          weightKg: 400,
          stackable: false,
        },
      ],
      declaredValueMinor: 5_000_000,
      fragile: false,
      temperature: null,
      dangerousGoods: false,
      needsTailLiftPickup: false,
      needsTailLiftDelivery: false,
      goodsStatus: 'union',
      hsCode: null,
      ...cargoOver,
    },
    serviceLevel: 'standard',
    maxPriceMinor: 200_000,
    reference: 'PO-1',
    ...rest,
  } as ShipmentInput;
}

/** Creates a shipment and pays the prepayment with the test provider. */
export async function publishedShipment(
  env: TestEnv,
  shipper: Client,
  over: Parameters<typeof shipmentInput>[1] = {},
) {
  const res = await shipper.post('/api/shipments', shipmentInput(env, over));
  if (res.statusCode !== 200) throw new Error(`create failed: ${res.body}`);
  const paid = await shipper.post(`/api/test-payments/${res.data.payment.paymentRef}/complete`, {
    outcome: 'succeed',
  });
  if (paid.data.result !== 'published') throw new Error(`payment: ${paid.body}`);
  return {
    id: res.data.id as string,
    estimate: res.data.estimate,
    paymentRef: res.data.payment.paymentRef as string,
  };
}

export const key = () => `k-${uniq()}-${Math.random().toString(36).slice(2)}`;

/** 1×1 transparent PNG */
export const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);

/** A ready carrier with one driver who has accepted the invitation (licence CE, valid). */
export async function carrierWithDriver(
  env: TestEnv,
  opts: Parameters<typeof readyCarrier>[1] = {},
) {
  const carrier = await readyCarrier(env, opts);
  const email = `driver-${uniq()}@example.com`;
  const add = await carrier.client.post('/api/carrier/drivers', {
    name: 'Dana Driver',
    email,
    phone: '+49 170 1',
    licenceCategories: ['CE'],
    licenceValidUntil: '2030-01-01',
    cpcValidUntil: '2030-01-01',
  });
  if (add.statusCode !== 200) throw new Error(add.body);
  const token = await lastEmailToken(env, email, 'invitation');
  const driver = new Client(env);
  const acc = await driver.post('/api/org/invitations/accept', {
    token,
    name: 'Dana Driver',
    password: 'driver password long',
  });
  if (acc.statusCode !== 200) throw new Error(acc.body);
  return { carrier, driver, driverId: add.data.id as string, driverEmail: email };
}

export async function upload(
  env: TestEnv,
  client: Client,
  shipmentId: string,
  kind = 'photo',
  data = PNG,
  type = 'image/png',
) {
  const res = await env.app.inject({
    method: 'POST',
    url: `/api/shipments/${shipmentId}/files?kind=${kind}`,
    headers: { 'x-requested-with': 'freight', cookie: client.cookie, 'content-type': type },
    payload: data,
  });
  return { statusCode: res.statusCode, data: res.json() };
}

/** Booked shipment with the driver assigned. */
export async function bookedWithDriver(env: TestEnv) {
  const shipper = await registerCompany(env, 'shipper');
  const c = await carrierWithDriver(env);
  const s = await publishedShipment(env, shipper.client);
  const acc = await c.carrier.client.post(`/api/carrier/loads/${s.id}/accept`, {
    vehicleId: c.carrier.vehicleId,
    idempotencyKey: key(),
  });
  const assign = await c.carrier.client.post(`/api/carrier/bookings/${acc.data.bookingId}/assign`, {
    driverId: c.driverId,
  });
  if (assign.statusCode !== 200) throw new Error(assign.body);
  await env.jobs();
  return { shipper, ...c, shipmentId: s.id, bookingId: acc.data.bookingId as string };
}

export const tripEvent = (env: TestEnv, action: string, extra: Record<string, unknown> = {}) => ({
  clientEventId: key(),
  action,
  occurredAt: env.clock.now.toISOString(),
  lat: 53.54,
  lng: 9.99,
  ...extra,
});

/** A verified customs provider with an approved customs authorisation and a profile. */
export async function readyCustomsProvider(
  env: TestEnv,
  countries: string[],
  services: string[],
  prices: Record<string, number> = {},
) {
  const c = await registerCompany(env, 'customs_provider');
  await c.client.post('/api/carrier/documents', {
    kind: 'customs_authorisation',
    reference: 'AEO-1',
    validUntil: '2030-01-01',
  });
  await env.ctx.db
    .update(verificationDocuments)
    .set({ status: 'approved' })
    .where(eq(verificationDocuments.orgId, c.orgId));
  await env.ctx.db
    .update(organisations)
    .set({ status: 'verified' })
    .where(eq(organisations.id, c.orgId));
  const p = await c.client.put('/api/customs-provider/profile', {
    countries,
    services,
    prices,
    contactPhone: '+49 40 999',
    contactEmail: 'desk@broker.example',
  });
  if (p.statusCode !== 200) throw new Error(p.body);
  return c;
}

export const pdfBase64 = () => Buffer.from('%PDF-1.4\n% test document\n').toString('base64');

/** Hamburg → Oslo (export from the EU, import into Norway). */
export function norwayInput(env: TestEnv) {
  const input = shipmentInput(env);
  Object.assign(input.delivery, {
    addressLine: 'Karl Johans gate 1',
    postcode: '0154',
    city: 'Oslo',
    country: 'NO',
    lat: 59.9111,
    lng: 10.7503,
  });
  return input;
}

/** Bank details entered "some days ago", so payouts are not held by the fraud rule for recent changes. */
export async function settledBankDetails(
  env: TestEnv,
  client: Client,
  orgId: string,
  iban = 'DE89370400440532013000',
) {
  const res = await client.put('/api/org/payout-account', { holderName: 'Test Holder GmbH', iban });
  if (res.statusCode !== 200) throw new Error(res.body);
  await env.ctx.db.execute(
    sql`UPDATE payout_accounts SET updated_at = now() - interval '3 days' WHERE org_id = ${orgId}`,
  );
}
