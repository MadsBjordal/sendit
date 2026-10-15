import { and, eq, sql } from 'drizzle-orm';
import type { Ctx } from '../context';
import { bookings, organisations, shipmentLocations, shipments } from '../db/schema';
import { forbidden, notFound } from '../lib/errors';
import { getVehicle, vehicleProblems } from './carriers';
import { matchContext } from './booking';
import { shipmentNumber } from './shipments';

function km(a: { lat: number; lng: number }, b: { lat: number; lng: number }) {
  const R = 6371;
  const rad = (d: number) => (d * Math.PI) / 180;
  const h =
    Math.sin(rad(b.lat - a.lat) / 2) ** 2 +
    Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(rad(b.lng - a.lng) / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h)) * 1.25;
}

/**
 * Loads to take after a booked job, so the truck does not drive back empty: open loads that start
 * near this job's delivery, after it, fit the same vehicle, and bring the truck closer to its base.
 * Suggestions only: accepting goes through the normal booking (first acceptance wins).
 */
export async function returnLoads(
  ctx: Ctx,
  carrierOrgId: string,
  bookingId: string,
  radiusKm = 150,
) {
  const [b] = await ctx.db
    .select()
    .from(bookings)
    .where(and(eq(bookings.id, bookingId), eq(bookings.carrierOrgId, carrierOrgId)));
  if (!b) throw notFound();
  const [org] = await ctx.db.select().from(organisations).where(eq(organisations.id, carrierOrgId));
  if (org?.status !== 'verified') throw forbidden('Only verified carriers get suggestions');
  const vehicle = await getVehicle(ctx.db, carrierOrgId, b.vehicleId);
  if (!vehicle) throw notFound();
  const [delivery] = await ctx.db
    .select()
    .from(shipmentLocations)
    .where(
      and(eq(shipmentLocations.shipmentId, b.shipmentId), eq(shipmentLocations.kind, 'delivery')),
    );
  const base = { lat: vehicle.baseLat, lng: vehicle.baseLng };
  const homeKm = km(delivery!, base);
  const candidates = await ctx.db.execute<{ id: string }>(sql`
    SELECT s.id FROM shipments s JOIN shipment_locations p ON p.shipment_id = s.id AND p.kind = 'pickup'
    WHERE s.status = 'searching' AND s.search_expires_at > ${ctx.now().toISOString()} AND s.id <> ${b.shipmentId}
      AND p.window_end >= ${delivery!.windowStart.toISOString()}
      AND ST_DWithin(p.point, (SELECT point FROM shipment_locations WHERE shipment_id = ${b.shipmentId} AND kind = 'delivery'), ${radiusKm * 1000})
    LIMIT 200`);
  const out = [];
  for (const { id } of candidates.rows) {
    const [s] = await ctx.db.select().from(shipments).where(eq(shipments.id, id));
    const m = await matchContext(ctx.db, s!);
    const problems = vehicleProblems(
      m,
      { ...vehicle, available: true },
      org.operatingCountries,
    ).filter((p) => p.code !== 'cabotage_confirmation_needed');
    if (problems.length) continue;
    const locs = await ctx.db
      .select()
      .from(shipmentLocations)
      .where(eq(shipmentLocations.shipmentId, id));
    const p = locs.find((l) => l.kind === 'pickup')!;
    const d = locs.find((l) => l.kind === 'delivery')!;
    const emptyKm = Math.round(km(delivery!, p));
    const closerToBaseKm = Math.round(homeKm - km(d, base));
    const loadedKm = s!.distanceKm;
    out.push({
      shipmentId: id,
      number: shipmentNumber(s!.number),
      from: { city: p.city, country: p.country, windowStart: p.windowStart },
      to: { city: d.city, country: d.country },
      payoutMinor: s!.listedPayoutMinor,
      currency: s!.currency,
      emptyKm,
      loadedKm,
      closerToBaseKm,
      /** Payout per kilometre driven, counting the empty ones */
      perKmMinor: Math.round(s!.listedPayoutMinor / Math.max(1, emptyKm + loadedKm)),
    });
  }
  // Best first: brings the truck home, little empty driving, good pay per km
  return out
    .sort(
      (a, z) =>
        z.closerToBaseKm -
        a.closerToBaseKm +
        (a.emptyKm - z.emptyKm) * 0.5 +
        (z.perKmMinor - a.perKmMinor) * 0.1,
    )
    .slice(0, 20);
}

/** How a carrier is doing, like the scorecard in carrier apps. Based only on our own records. */
export async function carrierPerformance(ctx: Ctx, carrierOrgId: string) {
  const r = await ctx.db.execute<Record<string, number>>(sql`
    SELECT count(*)::int AS jobs,
      count(*) FILTER (WHERE s.status IN ('delivered','completed','disputed'))::int AS delivered,
      count(*) FILTER (WHERE s.delivered_at IS NOT NULL AND s.delivered_at <= d.window_end)::int AS on_time,
      count(*) FILTER (WHERE s.collected_at IS NOT NULL AND s.collected_at <= p.window_end)::int AS pickup_on_time,
      count(*) FILTER (WHERE s.collected_at IS NOT NULL)::int AS collected,
      (SELECT count(*) FROM disputes x JOIN bookings y ON y.shipment_id = x.shipment_id WHERE y.carrier_org_id = ${carrierOrgId} AND x.status = 'resolved' AND coalesce(x.carrier_deduction_minor, 0) > 0)::int AS claims,
      (SELECT count(DISTINCT shipment_id) FROM tracking_positions t WHERE t.shipment_id IN (SELECT shipment_id FROM bookings WHERE carrier_org_id = ${carrierOrgId}))::int AS tracked
    FROM bookings b JOIN shipments s ON s.id = b.shipment_id
    JOIN shipment_locations p ON p.shipment_id = s.id AND p.kind = 'pickup'
    JOIN shipment_locations d ON d.shipment_id = s.id AND d.kind = 'delivery'
    WHERE b.carrier_org_id = ${carrierOrgId}`);
  const x = r.rows[0]!;
  const rate = (a: number, b: number) => (b ? Math.round((a / b) * 100) / 100 : null);
  const onTime = rate(Number(x.on_time), Number(x.delivered));
  const pickup = rate(Number(x.pickup_on_time), Number(x.collected));
  const tracking = rate(Number(x.tracked), Number(x.jobs));
  const claims = rate(Number(x.claims), Number(x.delivered));
  const standing =
    Number(x.delivered) < 3
      ? 'new'
      : (onTime ?? 1) >= 0.9 && (claims ?? 0) <= 0.05
        ? 'good'
        : (onTime ?? 1) >= 0.75
          ? 'fair'
          : 'at_risk';
  return {
    jobs: Number(x.jobs),
    delivered: Number(x.delivered),
    onTimeDelivery: onTime,
    onTimePickup: pickup,
    trackingShare: tracking,
    claimRate: claims,
    standing,
  };
}
