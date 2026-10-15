import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { Ctx } from '../context';
import {
  bookings,
  drivers,
  shipmentLocations,
  shipments,
  trackingPositions,
  vehicles,
} from '../db/schema';
import { badRequest, conflict, notFound } from '../lib/errors';
import { audit, shipmentEvent, type Actor } from './audit';
import { inviteMember } from './auth';
import { notifyUser } from './notifications';

export const driverInputSchema = z.object({
  name: z.string().trim().min(1).max(200),
  email: z.string().trim().toLowerCase().email(),
  phone: z.string().trim().max(40).nullable().optional(),
  licenceCategories: z.array(z.enum(['B', 'C1', 'C', 'C1E', 'CE'])).min(1),
  licenceValidUntil: z.string().date().nullable().optional(),
  cpcValidUntil: z.string().date().nullable().optional(),
});

/** Licence category needed for each vehicle class (typical maximum masses). */
export const LICENCE_FOR_CLASS: Record<string, string[]> = {
  van_light: ['B', 'C1', 'C', 'C1E', 'CE'],
  van_large: ['B', 'C1', 'C', 'C1E', 'CE'],
  box_truck: ['C1', 'C', 'C1E', 'CE'],
  rigid_truck: ['C', 'CE'],
  refrigerated: ['CE'],
  curtainsider: ['CE'],
  articulated: ['CE'],
  flatbed: ['CE'],
  specialist: ['CE'],
};
const NEEDS_CPC = new Set([
  'box_truck',
  'rigid_truck',
  'refrigerated',
  'curtainsider',
  'articulated',
  'flatbed',
  'specialist',
]);

/** Adds a driver and invites them to the driver app (role "driver"). */
export async function addDriver(
  ctx: Ctx,
  actor: Actor & { userId: string; orgId: string },
  input: z.infer<typeof driverInputSchema>,
) {
  const [exists] = await ctx.db
    .select({ id: drivers.id })
    .from(drivers)
    .where(and(eq(drivers.orgId, actor.orgId), sql`lower(${drivers.email}) = ${input.email}`));
  if (exists) throw conflict('driver_exists', 'A driver with this email already exists');
  const [d] = await ctx.db
    .insert(drivers)
    .values({
      ...input,
      phone: input.phone ?? null,
      licenceValidUntil: input.licenceValidUntil ?? null,
      cpcValidUntil: input.cpcValidUntil ?? null,
      orgId: actor.orgId,
    })
    .returning();
  await inviteMember(ctx, actor, { email: input.email, role: 'driver' });
  await audit(ctx.db, actor, 'fleet.driver_added', { type: 'driver', id: d!.id });
  return d!;
}

export async function updateDriver(
  ctx: Ctx,
  actor: Actor & { orgId: string },
  driverId: string,
  input: z.infer<typeof driverInputSchema> & { active: boolean },
) {
  const { email: _email, ...rest } = input;
  const [d] = await ctx.db
    .update(drivers)
    .set({
      ...rest,
      phone: rest.phone ?? null,
      licenceValidUntil: rest.licenceValidUntil ?? null,
      cpcValidUntil: rest.cpcValidUntil ?? null,
    })
    .where(and(eq(drivers.id, driverId), eq(drivers.orgId, actor.orgId)))
    .returning();
  if (!d) throw notFound();
  return d;
}

/** Called when someone accepts a "driver" invitation: links the driver profile to their login. */
export async function linkDriverUser(ctx: Ctx, orgId: string, userId: string, email: string) {
  await ctx.db
    .update(drivers)
    .set({ userId })
    .where(and(eq(drivers.orgId, orgId), sql`lower(${drivers.email}) = ${email.toLowerCase()}`));
}

const ACTIVE = ['booked', 'in_transit'];

/** The carrier's drivers with their last known position and whether they are on a job now. */
export async function listDrivers(ctx: Ctx, orgId: string) {
  const rows = await ctx.db
    .select()
    .from(drivers)
    .where(eq(drivers.orgId, orgId))
    .orderBy(drivers.name);
  const ids = rows.map((r) => r.id);
  const last = ids.length
    ? await ctx.db.execute<{ driver_id: string; lat: number; lng: number; at: string }>(sql`
        SELECT DISTINCT ON (driver_id) driver_id, lat, lng, at FROM tracking_positions
        WHERE driver_id IN (${sql.join(
          ids.map((i) => sql`${i}`),
          sql`, `,
        )}) ORDER BY driver_id, at DESC`)
    : { rows: [] };
  const active = ids.length
    ? await ctx.db
        .select({ driverId: bookings.driverId, shipmentId: bookings.shipmentId })
        .from(bookings)
        .innerJoin(shipments, eq(shipments.id, bookings.shipmentId))
        .where(and(inArray(bookings.driverId, ids), inArray(shipments.status, ACTIVE)))
    : [];
  return rows.map((d) => {
    const pos = last.rows.find((p) => p.driver_id === d.id);
    return {
      ...d,
      linked: !!d.userId,
      lastPosition: pos ? { lat: pos.lat, lng: pos.lng, at: pos.at } : null,
      activeJobs: active.filter((a) => a.driverId === d.id).map((a) => a.shipmentId),
    };
  });
}

export type DriverProblem =
  | { code: 'driver_inactive' }
  | { code: 'driver_not_linked' }
  | { code: 'licence_category'; needed: string[] }
  | { code: 'licence_expired'; validUntil: string | null }
  | { code: 'cpc_expired'; validUntil: string | null }
  | { code: 'driver_busy'; shipmentIds: string[] };

function haversineKm(a: { lat: number; lng: number }, b: { lat: number; lng: number }) {
  const R = 6371;
  const rad = (d: number) => (d * Math.PI) / 180;
  const h =
    Math.sin(rad(b.lat - a.lat) / 2) ** 2 +
    Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(rad(b.lng - a.lng) / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

/**
 * Drivers for a booked job, best first: those without problems, then by empty kilometres
 * (deadhead) from their last known position (or the vehicle's base) to the pickup.
 */
export async function assignOptions(ctx: Ctx, carrierOrgId: string, bookingId: string) {
  const [b] = await ctx.db
    .select()
    .from(bookings)
    .where(and(eq(bookings.id, bookingId), eq(bookings.carrierOrgId, carrierOrgId)));
  if (!b) throw notFound();
  const [pickup] = await ctx.db
    .select()
    .from(shipmentLocations)
    .where(
      and(eq(shipmentLocations.shipmentId, b.shipmentId), eq(shipmentLocations.kind, 'pickup')),
    );
  const [delivery] = await ctx.db
    .select()
    .from(shipmentLocations)
    .where(
      and(eq(shipmentLocations.shipmentId, b.shipmentId), eq(shipmentLocations.kind, 'delivery')),
    );
  const [v] = await ctx.db
    .select({
      vehicleClass: vehicles.vehicleClass,
      lat: sql<number>`ST_Y(${vehicles.baseLocation}::geometry)`,
      lng: sql<number>`ST_X(${vehicles.baseLocation}::geometry)`,
    })
    .from(vehicles)
    .where(eq(vehicles.id, b.vehicleId));
  const list = await listDrivers(ctx, carrierOrgId);
  const lastDay = delivery!.windowEnd.toISOString().slice(0, 10);
  return list
    .map((d) => {
      const problems: DriverProblem[] = [];
      if (!d.active) problems.push({ code: 'driver_inactive' });
      if (!d.linked) problems.push({ code: 'driver_not_linked' });
      const needed = LICENCE_FOR_CLASS[v!.vehicleClass] ?? ['CE'];
      if (!d.licenceCategories.some((c) => needed.includes(c)))
        problems.push({ code: 'licence_category', needed });
      if (!d.licenceValidUntil || d.licenceValidUntil < lastDay)
        problems.push({ code: 'licence_expired', validUntil: d.licenceValidUntil });
      if (NEEDS_CPC.has(v!.vehicleClass) && (!d.cpcValidUntil || d.cpcValidUntil < lastDay))
        problems.push({ code: 'cpc_expired', validUntil: d.cpcValidUntil });
      const busy = d.activeJobs.filter((s) => s !== b.shipmentId);
      if (busy.length) problems.push({ code: 'driver_busy', shipmentIds: busy });
      const from = d.lastPosition ?? { lat: v!.lat, lng: v!.lng };
      return {
        id: d.id,
        name: d.name,
        phone: d.phone,
        locationSource: d.lastPosition ? 'last_position' : 'vehicle_base',
        deadheadKm: Math.round(haversineKm(from, pickup!)),
        problems,
        assigned: b.driverId === d.id,
      };
    })
    .sort(
      (a, z) =>
        (a.problems.length === 0 ? 0 : 1) - (z.problems.length === 0 ? 0 : 1) ||
        a.deadheadKm - z.deadheadKm,
    );
}

export async function assignDriver(
  ctx: Ctx,
  actor: Actor & { userId: string; orgId: string },
  bookingId: string,
  driverId: string,
) {
  const options = await assignOptions(ctx, actor.orgId, bookingId);
  const opt = options.find((o) => o.id === driverId);
  if (!opt) throw notFound();
  // Busy is a warning (a driver may do two jobs in a row); the others block
  const blocking = opt.problems.filter((p) => p.code !== 'driver_busy');
  if (blocking.length)
    throw badRequest('driver_not_eligible', 'This driver cannot take this job', blocking);
  const [b] = await ctx.db.select().from(bookings).where(eq(bookings.id, bookingId));
  const [s] = await ctx.db.select().from(shipments).where(eq(shipments.id, b!.shipmentId));
  if (!['booked', 'in_transit'].includes(s!.status))
    throw conflict('not_assignable', 'This job is finished or cancelled');
  await ctx.db
    .update(bookings)
    .set({ driverId, assignedAt: ctx.now() })
    .where(eq(bookings.id, bookingId));
  const [d] = await ctx.db.select().from(drivers).where(eq(drivers.id, driverId));
  await shipmentEvent(ctx.db, b!.shipmentId, 'driver.assigned', actor, {});
  await audit(
    ctx.db,
    actor,
    'booking.driver_assigned',
    { type: 'booking', id: bookingId },
    { driverId },
  );
  if (d!.userId)
    await notifyUser(ctx.db, d!.userId, {
      kind: 'driver.assigned',
      orgId: actor.orgId,
      shipmentId: b!.shipmentId,
      dedupeKey: `assigned:${b!.shipmentId}:${driverId}`,
    });
  return { ok: true, warnings: opt.problems };
}

/** The driver profile of the logged-in driver */
export async function driverOf(ctx: Ctx, orgId: string, userId: string) {
  const [d] = await ctx.db
    .select()
    .from(drivers)
    .where(and(eq(drivers.orgId, orgId), eq(drivers.userId, userId)));
  return d ?? null;
}

export async function lastPositionOf(ctx: Ctx, shipmentId: string) {
  const [p] = await ctx.db
    .select()
    .from(trackingPositions)
    .where(eq(trackingPositions.shipmentId, shipmentId))
    .orderBy(desc(trackingPositions.at))
    .limit(1);
  return p ?? null;
}
