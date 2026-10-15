import { and, asc, eq, sql } from 'drizzle-orm';
import {
  CARRIER_REQUIRED_DOCUMENTS,
  COUNTRY_BY_CODE,
  fitProblems,
  type CargoRequirements,
  type FitProblem,
  type VehicleInput,
} from '@freight/shared';
import type { Ctx } from '../context';
import type { DbOrTx } from '../db/client';
import { organisations, vehicles, verificationDocuments } from '../db/schema';
import { badRequest, conflict, notFound, pgError } from '../lib/errors';
import { audit, type Actor } from './audit';

export function pointWkt(lat: number, lng: number) {
  return `SRID=4326;POINT(${lng} ${lat})`;
}

const vehicleColumns = {
  id: vehicles.id,
  orgId: vehicles.orgId,
  registration: vehicles.registration,
  registrationCountry: vehicles.registrationCountry,
  vehicleClass: vehicles.vehicleClass,
  payloadKg: vehicles.payloadKg,
  lengthCm: vehicles.lengthCm,
  widthCm: vehicles.widthCm,
  heightCm: vehicles.heightCm,
  palletPlaces: vehicles.palletPlaces,
  equipment: vehicles.equipment,
  tempMinC: vehicles.tempMinC,
  tempMaxC: vehicles.tempMaxC,
  available: vehicles.available,
  active: vehicles.active,
  baseLat: sql<number>`ST_Y(${vehicles.baseLocation}::geometry)`,
  baseLng: sql<number>`ST_X(${vehicles.baseLocation}::geometry)`,
};

export async function listVehicles(db: DbOrTx, orgId: string) {
  return db
    .select(vehicleColumns)
    .from(vehicles)
    .where(and(eq(vehicles.orgId, orgId), eq(vehicles.active, true)))
    .orderBy(asc(vehicles.registration));
}

export type VehicleRow = Awaited<ReturnType<typeof listVehicles>>[number];

export async function getVehicle(
  db: DbOrTx,
  orgId: string,
  vehicleId: string,
): Promise<VehicleRow | null> {
  const [v] = await db
    .select(vehicleColumns)
    .from(vehicles)
    .where(and(eq(vehicles.id, vehicleId), eq(vehicles.orgId, orgId)));
  return v ?? null;
}

function checkVehicle(input: VehicleInput) {
  if (
    input.equipment.includes('refrigeration') &&
    (input.tempMinC == null || input.tempMaxC == null)
  )
    throw badRequest('temperature_range', 'Give the temperature range the refrigeration can hold');
  if (input.equipment.includes('adr'))
    throw badRequest('adr_not_supported', 'Dangerous goods (ADR) transport is not offered yet');
}

export async function addVehicle(ctx: Ctx, actor: Actor & { orgId: string }, input: VehicleInput) {
  checkVehicle(input);
  const { baseLat, baseLng, ...rest } = input;
  try {
    const [v] = await ctx.db
      .insert(vehicles)
      .values({
        ...rest,
        registration: rest.registration.toUpperCase(),
        orgId: actor.orgId,
        baseLocation: pointWkt(baseLat, baseLng),
      })
      .returning({ id: vehicles.id });
    await audit(ctx.db, actor, 'fleet.vehicle_added', { type: 'vehicle', id: v!.id });
    return (await getVehicle(ctx.db, actor.orgId, v!.id))!;
  } catch (err) {
    if (pgError(err).code === '23505')
      throw conflict('vehicle_exists', 'This registration is already in your fleet');
    throw err;
  }
}

export async function updateVehicle(
  ctx: Ctx,
  actor: Actor & { orgId: string },
  vehicleId: string,
  input: VehicleInput,
) {
  checkVehicle(input);
  const { baseLat, baseLng, ...rest } = input;
  const res = await ctx.db
    .update(vehicles)
    .set({
      ...rest,
      registration: rest.registration.toUpperCase(),
      baseLocation: pointWkt(baseLat, baseLng),
    })
    .where(and(eq(vehicles.id, vehicleId), eq(vehicles.orgId, actor.orgId)))
    .returning({ id: vehicles.id });
  if (!res[0]) throw notFound();
  await audit(ctx.db, actor, 'fleet.vehicle_changed', { type: 'vehicle', id: vehicleId });
  return (await getVehicle(ctx.db, actor.orgId, vehicleId))!;
}

export async function removeVehicle(ctx: Ctx, actor: Actor & { orgId: string }, vehicleId: string) {
  const res = await ctx.db
    .update(vehicles)
    .set({ active: false, available: false })
    .where(and(eq(vehicles.id, vehicleId), eq(vehicles.orgId, actor.orgId)))
    .returning({ id: vehicles.id });
  if (!res[0]) throw notFound();
  await audit(ctx.db, actor, 'fleet.vehicle_removed', { type: 'vehicle', id: vehicleId });
}

export async function setOperatingCountries(
  ctx: Ctx,
  actor: Actor & { orgId: string },
  countries: string[],
) {
  const clean = [...new Set(countries.map((c) => c.toUpperCase()))].filter(
    (c) => COUNTRY_BY_CODE.has(c) && !COUNTRY_BY_CODE.get(c)!.blocked,
  );
  await ctx.db
    .update(organisations)
    .set({ operatingCountries: clean })
    .where(eq(organisations.id, actor.orgId));
  await audit(
    ctx.db,
    actor,
    'carrier.operating_countries',
    { type: 'organisation', id: actor.orgId },
    { countries: clean },
  );
  return clean;
}

export async function submitDocument(
  ctx: Ctx,
  actor: Actor & { orgId: string },
  input: {
    kind: string;
    reference: string;
    issuerCountry?: string | null;
    validFrom?: string | null;
    validUntil?: string | null;
  },
) {
  const [doc] = await ctx.db
    .insert(verificationDocuments)
    .values({
      orgId: actor.orgId,
      kind: input.kind,
      reference: input.reference,
      issuerCountry: input.issuerCountry ?? null,
      validFrom: input.validFrom ?? null,
      validUntil: input.validUntil ?? null,
    })
    .returning();
  await audit(
    ctx.db,
    actor,
    'verification.document_submitted',
    { type: 'verification_document', id: doc!.id },
    { kind: input.kind },
  );
  return doc!;
}

export async function listDocuments(db: DbOrTx, orgId: string) {
  return db
    .select()
    .from(verificationDocuments)
    .where(eq(verificationDocuments.orgId, orgId))
    .orderBy(verificationDocuments.createdAt);
}

export type CarrierProblem =
  | { code: 'not_a_carrier' }
  | { code: 'carrier_not_verified'; status: string }
  | { code: 'document_missing'; kind: string }
  | { code: 'document_expired'; kind: string; validUntil: string };

/**
 * Is the carrier company allowed to take loads on this date? Needs a verified organisation and
 * approved, unexpired operator licence and liability insurance. Nothing is assumed.
 */
export async function carrierProblems(
  db: DbOrTx,
  orgId: string,
  onDate: string,
): Promise<CarrierProblem[]> {
  const [org] = await db.select().from(organisations).where(eq(organisations.id, orgId));
  if (!org || org.kind !== 'carrier') return [{ code: 'not_a_carrier' }];
  const problems: CarrierProblem[] = [];
  if (org.status !== 'verified')
    problems.push({ code: 'carrier_not_verified', status: org.status });
  const docs = await db
    .select()
    .from(verificationDocuments)
    .where(
      and(eq(verificationDocuments.orgId, orgId), eq(verificationDocuments.status, 'approved')),
    );
  for (const kind of CARRIER_REQUIRED_DOCUMENTS) {
    const ofKind = docs.filter((d) => d.kind === kind);
    if (ofKind.length === 0) problems.push({ code: 'document_missing', kind });
    else if (!ofKind.some((d) => !d.validUntil || d.validUntil >= onDate)) {
      const latest = ofKind
        .map((d) => d.validUntil!)
        .sort()
        .at(-1)!;
      problems.push({ code: 'document_expired', kind, validUntil: latest });
    }
  }
  return problems;
}

export type VehicleProblem =
  | FitProblem
  | { code: 'vehicle_unavailable' }
  | { code: 'not_operating_in'; country: string }
  | { code: 'cabotage_confirmation_needed'; country: string }
  | { code: 'cabotage_not_allowed'; country: string };

const EU_EEA = new Set([
  'AT',
  'BE',
  'BG',
  'HR',
  'CY',
  'CZ',
  'DK',
  'EE',
  'FI',
  'FR',
  'DE',
  'GR',
  'HU',
  'IE',
  'IT',
  'LV',
  'LT',
  'LU',
  'MT',
  'NL',
  'PL',
  'PT',
  'RO',
  'SK',
  'SI',
  'ES',
  'SE',
  'NO',
  'IS',
  'LI',
]);

export interface ShipmentForMatching {
  cargo: CargoRequirements;
  pickupCountry: string;
  deliveryCountry: string;
}

/**
 * Can this vehicle do this shipment? Uses the vehicle's real numbers. Cabotage (a domestic trip by
 * a vehicle registered elsewhere) is never declared compliant automatically: EU/EEA vehicles need
 * the carrier's explicit confirmation that the trip is within the cabotage rules; others are refused.
 */
export function vehicleProblems(
  s: ShipmentForMatching,
  v: VehicleRow,
  operatingCountries: string[],
): VehicleProblem[] {
  const problems: VehicleProblem[] = [];
  if (!v.active || !v.available) problems.push({ code: 'vehicle_unavailable' });
  problems.push(
    ...fitProblems(s.cargo, {
      payloadKg: v.payloadKg,
      lengthCm: v.lengthCm,
      widthCm: v.widthCm,
      heightCm: v.heightCm,
      palletPlaces: v.palletPlaces,
      equipment: v.equipment as never,
      tempMinC: v.tempMinC,
      tempMaxC: v.tempMaxC,
    }),
  );
  for (const c of new Set([s.pickupCountry, s.deliveryCountry]))
    if (!operatingCountries.includes(c)) problems.push({ code: 'not_operating_in', country: c });
  if (s.pickupCountry === s.deliveryCountry && v.registrationCountry !== s.pickupCountry) {
    if (EU_EEA.has(v.registrationCountry) && EU_EEA.has(s.pickupCountry))
      problems.push({ code: 'cabotage_confirmation_needed', country: s.pickupCountry });
    else problems.push({ code: 'cabotage_not_allowed', country: s.pickupCountry });
  }
  return problems;
}
