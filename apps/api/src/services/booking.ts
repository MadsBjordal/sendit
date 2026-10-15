import { and, eq, inArray, sql } from 'drizzle-orm';
import {
  customerPriceForPayout,
  type CargoRequirements,
  type CustomerPrice,
  type PricingConfig,
  type ServiceLevel,
  type TaxContext,
} from '@freight/shared';
import type { Ctx } from '../context';
import type { Tx } from '../db/client';
import {
  acceptAttempts,
  bookings,
  cargoLines,
  carrierObligations,
  offers,
  organisations,
  payments,
  priceSnapshots,
  shipments,
} from '../db/schema';
import { conflict, forbidden, notFound, pgError } from '../lib/errors';
import { audit, shipmentEvent, type Actor } from './audit';
import {
  carrierProblems,
  getVehicle,
  vehicleProblems,
  type CarrierProblem,
  type VehicleProblem,
  type VehicleRow,
} from './carriers';
import { enqueue } from './jobs';
import { post } from './ledger';
import { notifyOrg } from './notifications';
import { createPayment } from './payments';
import {
  locationsOf,
  lockShipment,
  refundAll,
  shipmentNumber,
  type ShipmentRow,
} from './shipments';

const SYSTEM: Actor = { userId: null, orgId: null };

/** How long a carrier's above-maximum offer waits for the customer, by service level */
export const OFFER_MINUTES: Record<ServiceLevel, number> = {
  standard: 240,
  priority: 60,
  express: 20,
};
/** After approving an offer, the customer has this long to pay the difference */
export const TOP_UP_MINUTES = 30;

/** The guarantee as shown to carriers. Payout timing is a target, not yet a contractual promise (COMPLIANCE.md). */
export const GUARANTEE_TERMS =
  'Paid by the platform, not by the shipper. Becomes payable when delivery is verified (signed proof of delivery accepted) and no dispute is open. Target: payout started within 2 business days after that.';

/** Prepayment arrived: the shipment goes to carriers. Called inside the webhook transaction. */
export async function publish(ctx: Ctx, tx: Tx, shipmentId: string) {
  const s = (await lockShipment(tx, shipmentId))!;
  const pricing = s.pricingSnapshot as PricingConfig;
  const level = pricing.serviceLevels[s.serviceLevel as ServiceLevel];
  const now = ctx.now();
  const locs = (await locationsOf(tx, [s.id])).get(s.id)!;
  // Search no longer than the level allows, and never past the end of the pickup window
  const expires = new Date(
    Math.min(now.getTime() + level.searchMinutes * 60_000, locs.pickup.windowEnd.getTime()),
  );
  await tx
    .update(shipments)
    .set({ status: 'searching', publishedAt: now, searchExpiresAt: expires, updatedAt: now })
    .where(eq(shipments.id, s.id));
  await shipmentEvent(tx, s.id, 'shipment.searching', SYSTEM, { expiresAt: expires });
  await enqueue(
    tx,
    'match_shipment',
    { shipmentId: s.id, radiusKm: level.initialRadiusKm },
    { dedupeKey: `match:${s.id}:${level.initialRadiusKm}` },
  );
  await enqueue(
    tx,
    'expire_shipment',
    { shipmentId: s.id },
    { runAt: expires, dedupeKey: `expire:${s.id}` },
  );
}

export interface MatchContext {
  cargo: CargoRequirements;
  pickupCountry: string;
  deliveryCountry: string;
  pickupWindowEnd: Date;
}

export async function matchContext(tx: Tx | Ctx['db'], s: ShipmentRow): Promise<MatchContext> {
  const lines = await tx.select().from(cargoLines).where(eq(cargoLines.shipmentId, s.id));
  const cargo = s.cargo as {
    temperature: { minC: number; maxC: number } | null;
    needsTailLiftPickup: boolean;
    needsTailLiftDelivery: boolean;
  };
  const locs = (await locationsOf(tx, [s.id])).get(s.id)!;
  return {
    cargo: {
      lines,
      temperature: cargo.temperature,
      needsTailLiftPickup: cargo.needsTailLiftPickup,
      needsTailLiftDelivery: cargo.needsTailLiftDelivery,
      dangerousGoods: false,
    },
    pickupCountry: locs.pickup.country,
    deliveryCountry: locs.delivery.country,
    pickupWindowEnd: locs.pickup.windowEnd,
  };
}

export interface Eligibility {
  carrier: CarrierProblem[];
  vehicle: VehicleProblem[];
  /** Blocking problems (cabotage is blocking until confirmed) */
  blocking: Array<CarrierProblem | VehicleProblem>;
  vehicleRow: VehicleRow | null;
}

/** Re-checked at every acceptance and approval: things change between listing and clicking. */
export async function eligibility(
  tx: Tx,
  s: ShipmentRow,
  carrierOrgId: string,
  vehicleId: string,
  cabotageConfirmed: boolean,
  now: Date,
): Promise<Eligibility> {
  const m = await matchContext(tx, s);
  // Documents must be valid on the last day of the job, not just today
  const onDate = new Date(Math.max(now.getTime(), m.pickupWindowEnd.getTime()))
    .toISOString()
    .slice(0, 10);
  const carrier = await carrierProblems(tx, carrierOrgId, onDate);
  const v = await getVehicle(tx, carrierOrgId, vehicleId);
  const [org] = await tx
    .select({ countries: organisations.operatingCountries })
    .from(organisations)
    .where(eq(organisations.id, carrierOrgId));
  const vehicle: VehicleProblem[] = v
    ? vehicleProblems(m, v, org?.countries ?? [])
    : [{ code: 'vehicle_unavailable' }];
  const blocking = [
    ...carrier,
    ...vehicle.filter((p) => !(p.code === 'cabotage_confirmation_needed' && cabotageConfirmed)),
  ];
  return { carrier, vehicle, blocking, vehicleRow: v };
}

export type AcceptResult =
  | {
      result: 'booked';
      bookingId: string;
      shipmentNumber: string;
      payoutMinor: number;
      currency: string;
      guarantee: { funded: boolean; terms: string };
    }
  | {
      result: 'offer_pending';
      offerId: string;
      payoutMinor: number;
      currency: string;
      expiresAt: Date;
    }
  | { result: 'already_assigned' }
  | { result: 'not_available'; status: string }
  | { result: 'not_eligible'; problems: Array<CarrierProblem | VehicleProblem> };

/**
 * A carrier accepts a load: THE booking transaction. The shipment row is locked (FOR UPDATE), so
 * of two carriers clicking at the same moment the second waits, then sees "booked" and gets
 * "already assigned". bookings.shipment_id is UNIQUE as a second line of defence. A repeated
 * request with the same idempotency key returns the first answer.
 */
export async function acceptLoad(
  ctx: Ctx,
  actor: Actor & { userId: string; orgId: string },
  shipmentId: string,
  input: {
    vehicleId: string;
    payoutMinor?: number;
    idempotencyKey: string;
    cabotageConfirmed?: boolean;
  },
): Promise<AcceptResult> {
  try {
    return await ctx.db.transaction(async (tx) => {
      const [previous] = await tx
        .select()
        .from(acceptAttempts)
        .where(
          and(
            eq(acceptAttempts.carrierOrgId, actor.orgId),
            eq(acceptAttempts.idempotencyKey, input.idempotencyKey),
          ),
        );
      if (previous) {
        if (previous.shipmentId !== shipmentId)
          throw conflict(
            'idempotency_key_reused',
            'This request key was used for another shipment',
          );
        return previous.response as AcceptResult;
      }
      const s = await lockShipment(tx, shipmentId);
      if (!s) throw notFound();
      const result = await decide(ctx, tx, actor, s, input);
      await tx.insert(acceptAttempts).values({
        shipmentId,
        carrierOrgId: actor.orgId,
        userId: actor.userId,
        idempotencyKey: input.idempotencyKey,
        result: result.result,
        response: result,
      });
      return result;
    });
  } catch (err) {
    const pg = pgError(err);
    // Only reachable if the lock was somehow bypassed: the unique index decides
    if (pg.code === '23505' && String(pg.constraint).startsWith('bookings_shipment_id'))
      return { result: 'already_assigned' };
    // The same idempotency key sent twice at once: return the stored answer
    if (pg.code === '23505' && pg.constraint === 'accept_attempts_idem_key') {
      const [prev] = await ctx.db
        .select()
        .from(acceptAttempts)
        .where(
          and(
            eq(acceptAttempts.carrierOrgId, actor.orgId),
            eq(acceptAttempts.idempotencyKey, input.idempotencyKey),
          ),
        );
      if (prev) return prev.response as AcceptResult;
    }
    throw err;
  }
}

async function decide(
  ctx: Ctx,
  tx: Tx,
  actor: Actor & { userId: string; orgId: string },
  s: ShipmentRow,
  input: { vehicleId: string; payoutMinor?: number; cabotageConfirmed?: boolean },
): Promise<AcceptResult> {
  const now = ctx.now();
  if (s.status !== 'searching') {
    if (['booked', 'in_transit', 'delivered', 'completed'].includes(s.status))
      return { result: 'already_assigned' };
    return { result: 'not_available', status: s.status };
  }
  if (s.searchExpiresAt && s.searchExpiresAt <= now)
    return { result: 'not_available', status: 'expired' };
  const e = await eligibility(tx, s, actor.orgId, input.vehicleId, !!input.cabotageConfirmed, now);
  if (e.blocking.length > 0) return { result: 'not_eligible', problems: e.blocking };

  const payout = input.payoutMinor ?? s.listedPayoutMinor;
  const price = customerPriceForPayout(
    payout,
    s.taxContext as TaxContext,
    s.pricingSnapshot as PricingConfig,
  );
  await tx.insert(priceSnapshots).values({
    shipmentId: s.id,
    kind: 'acceptance',
    pricingVersion: s.pricingVersion,
    breakdown: { ...price, carrierOrgId: actor.orgId },
  });

  if (price.totalMinor <= s.maxPriceMinor) {
    if (s.fundedMinor < price.totalMinor)
      throw new Error(`shipment ${s.id} is searching but not funded`);
    const booking = await finaliseBooking(ctx, tx, s, {
      carrierOrgId: actor.orgId,
      vehicleId: input.vehicleId,
      price,
      offerId: null,
      acceptedBy: actor.userId,
      cabotageConfirmed: !!input.cabotageConfirmed,
    });
    return {
      result: 'booked',
      bookingId: booking.id,
      shipmentNumber: shipmentNumber(s.number),
      payoutMinor: payout,
      currency: s.currency,
      guarantee: { funded: true, terms: GUARANTEE_TERMS },
    };
  }

  // Above the customer's maximum: an offer the customer must approve. The shipment stays open.
  await tx
    .update(offers)
    .set({ status: 'withdrawn' })
    .where(
      and(
        eq(offers.shipmentId, s.id),
        eq(offers.carrierOrgId, actor.orgId),
        eq(offers.status, 'pending_customer'),
      ),
    );
  const level = s.serviceLevel as ServiceLevel;
  const expiresAt = new Date(
    Math.min(now.getTime() + OFFER_MINUTES[level] * 60_000, s.searchExpiresAt!.getTime()),
  );
  const [offer] = await tx
    .insert(offers)
    .values({
      shipmentId: s.id,
      carrierOrgId: actor.orgId,
      vehicleId: input.vehicleId,
      payoutMinor: payout,
      platformFeeMinor: price.platformFeeMinor,
      vatMinor: price.vatMinor,
      totalMinor: price.totalMinor,
      currency: price.currency,
      status: 'pending_customer',
      expiresAt,
      createdBy: actor.userId,
    })
    .returning();
  await enqueue(
    tx,
    'expire_offer',
    { offerId: offer!.id },
    { runAt: expiresAt, dedupeKey: `expire-offer:${offer!.id}` },
  );
  await shipmentEvent(tx, s.id, 'offer.received', actor, {
    offerId: offer!.id,
    totalMinor: price.totalMinor,
    overMinor: price.totalMinor - s.maxPriceMinor,
  });
  await notifyOrg(tx, s.orgId, 'offers.decide', {
    kind: 'offer.above_max',
    shipmentId: s.id,
    data: { offerId: offer!.id, totalMinor: price.totalMinor, maxPriceMinor: s.maxPriceMinor },
    dedupeKey: `offer:${offer!.id}`,
  });
  return {
    result: 'offer_pending',
    offerId: offer!.id,
    payoutMinor: payout,
    currency: price.currency,
    expiresAt,
  };
}

async function finaliseBooking(
  ctx: Ctx,
  tx: Tx,
  s: ShipmentRow,
  a: {
    carrierOrgId: string;
    vehicleId: string;
    price: CustomerPrice;
    offerId: string | null;
    acceptedBy: string;
    cabotageConfirmed: boolean;
  },
) {
  const now = ctx.now();
  const [booking] = await tx
    .insert(bookings)
    .values({
      shipmentId: s.id,
      carrierOrgId: a.carrierOrgId,
      vehicleId: a.vehicleId,
      offerId: a.offerId,
      payoutMinor: a.price.payoutMinor,
      platformFeeMinor: a.price.platformFeeMinor,
      netMinor: a.price.netMinor,
      vatMinor: a.price.vatMinor,
      totalMinor: a.price.totalMinor,
      currency: a.price.currency,
      pricingVersion: s.pricingVersion,
      acceptedBy: a.acceptedBy,
      cabotageConfirmed: a.cabotageConfirmed,
    })
    .returning();
  await tx
    .update(shipments)
    .set({ status: 'booked', bookedAt: now, updatedAt: now })
    .where(eq(shipments.id, s.id));
  if (a.offerId) await tx.update(offers).set({ status: 'booked' }).where(eq(offers.id, a.offerId));
  const losing = await tx
    .update(offers)
    .set({ status: 'superseded' })
    .where(
      and(eq(offers.shipmentId, s.id), inArray(offers.status, ['pending_customer', 'approved'])),
    )
    .returning({ id: offers.id, carrierOrgId: offers.carrierOrgId });
  await tx
    .update(payments)
    .set({ status: 'cancelled', updatedAt: now })
    .where(and(eq(payments.shipmentId, s.id), eq(payments.status, 'pending')));
  await tx.insert(priceSnapshots).values({
    shipmentId: s.id,
    kind: 'booking',
    pricingVersion: s.pricingVersion,
    breakdown: a.price,
  });

  // Money: the customer's prepaid funds become what we owe the carrier, our (deferred) fee and VAT
  await post(
    tx,
    {
      kind: 'booking',
      refType: 'booking',
      refId: booking!.id,
      idempotencyKey: `booking:${booking!.id}`,
      currency: a.price.currency,
    },
    [
      { account: 'customer_funds', orgId: s.orgId, amountMinor: a.price.totalMinor },
      { account: 'carrier_payable', orgId: a.carrierOrgId, amountMinor: -a.price.payoutMinor },
      { account: 'platform_revenue_deferred', amountMinor: -a.price.platformFeeMinor },
      { account: 'vat_payable', amountMinor: -a.price.vatMinor },
    ],
  );
  await tx.insert(carrierObligations).values({
    bookingId: booking!.id,
    carrierOrgId: a.carrierOrgId,
    amountMinor: a.price.payoutMinor,
    currency: a.price.currency,
    status: 'committed',
    funded: true,
    conditions: GUARANTEE_TERMS,
  });
  await enqueue(
    tx,
    'issue_customer_invoice',
    { bookingId: booking!.id },
    { dedupeKey: `invoice:${booking!.id}` },
  );
  if (s.fundedMinor > a.price.totalMinor)
    await enqueue(
      tx,
      'refund_excess',
      { shipmentId: s.id, keepMinor: a.price.totalMinor, reason: 'booking' },
      { dedupeKey: `refund:${s.id}:booking` },
    );

  await shipmentEvent(
    tx,
    s.id,
    'shipment.booked',
    { userId: a.acceptedBy, orgId: a.carrierOrgId },
    { bookingId: booking!.id, totalMinor: a.price.totalMinor },
  );
  await audit(
    tx,
    { userId: a.acceptedBy, orgId: a.carrierOrgId },
    'booking.created',
    { type: 'booking', id: booking!.id },
    { shipmentId: s.id },
  );
  await notifyOrg(tx, s.orgId, 'shipments.view', {
    kind: 'shipment.booked',
    shipmentId: s.id,
    dedupeKey: `booked:${s.id}`,
  });
  await notifyOrg(tx, a.carrierOrgId, 'loads.accept', {
    kind: 'booking.confirmed',
    shipmentId: s.id,
    dedupeKey: `booked:${s.id}`,
  });
  for (const o of losing)
    if (o.carrierOrgId !== a.carrierOrgId)
      await notifyOrg(tx, o.carrierOrgId, 'loads.accept', {
        kind: 'offer.superseded',
        shipmentId: s.id,
        dedupeKey: `superseded:${o.id}`,
      });
  return booking!;
}

/** The customer approves an above-maximum offer. The shipment stays open to others until the difference is paid. */
export async function approveOffer(
  ctx: Ctx,
  actor: Actor & { userId: string; orgId: string },
  shipmentId: string,
  offerId: string,
) {
  return ctx.db.transaction(async (tx) => {
    const s = await lockShipment(tx, shipmentId);
    if (!s || s.orgId !== actor.orgId) throw notFound();
    const [o] = await tx
      .select()
      .from(offers)
      .where(and(eq(offers.id, offerId), eq(offers.shipmentId, s.id)))
      .for('update');
    if (!o) throw notFound();
    const now = ctx.now();
    if (s.status !== 'searching')
      throw conflict(
        'already_assigned',
        'This shipment is no longer open: another carrier was booked, or it was cancelled',
      );
    if (o.status !== 'pending_customer')
      throw conflict('offer_not_pending', `This offer is ${o.status}`);
    if (o.expiresAt <= now) throw conflict('offer_expired', 'This offer has expired');
    const e = await eligibility(tx, s, o.carrierOrgId, o.vehicleId, true, now);
    if (e.blocking.length > 0)
      throw conflict(
        'carrier_not_eligible',
        'The carrier can no longer take this shipment',
        e.blocking,
      );
    // Prices are recalculated from the offer's payout with this shipment's pricing snapshot
    const price = customerPriceForPayout(
      o.payoutMinor,
      s.taxContext as TaxContext,
      s.pricingSnapshot as PricingConfig,
    );
    const topUp = price.totalMinor - s.fundedMinor;
    const payWithin = new Date(now.getTime() + TOP_UP_MINUTES * 60_000);
    await tx
      .update(offers)
      .set({ status: 'approved', decidedBy: actor.userId, decidedAt: now, expiresAt: payWithin })
      .where(eq(offers.id, o.id));
    await enqueue(
      tx,
      'expire_offer',
      { offerId: o.id },
      { runAt: payWithin, dedupeKey: `expire-offer:${o.id}:approved` },
    );
    await shipmentEvent(tx, s.id, 'offer.approved', actor, {
      offerId: o.id,
      totalMinor: price.totalMinor,
      topUpMinor: topUp,
    });
    await audit(
      tx,
      actor,
      'offer.approved',
      { type: 'offer', id: o.id },
      { totalMinor: price.totalMinor },
    );
    if (topUp <= 0) {
      const booking = await finaliseBooking(ctx, tx, s, {
        carrierOrgId: o.carrierOrgId,
        vehicleId: o.vehicleId,
        price,
        offerId: o.id,
        acceptedBy: o.createdBy,
        cabotageConfirmed: false,
      });
      return { result: 'booked' as const, bookingId: booking.id };
    }
    const p = await createPayment(ctx, {
      shipmentId: s.id,
      orgId: s.orgId,
      purpose: 'top_up',
      amountMinor: topUp,
      currency: price.currency,
      offerId: o.id,
    });
    await tx.insert(payments).values(p.row);
    return {
      result: 'payment_required' as const,
      topUpMinor: topUp,
      payment: p.clientAction,
      payWithin,
    };
  });
}

/** Called when the top-up has arrived: book the approved offer if the shipment is still open. */
export async function finaliseApprovedOffer(
  ctx: Ctx,
  tx: Tx,
  shipmentId: string,
  offerId: string,
): Promise<'booked' | 'already_assigned' | 'offer_gone' | 'not_eligible'> {
  const s = (await lockShipment(tx, shipmentId))!;
  const [o] = await tx.select().from(offers).where(eq(offers.id, offerId)).for('update');
  if (s.status !== 'searching') return 'already_assigned';
  if (!o || o.status !== 'approved' || o.expiresAt <= ctx.now()) return 'offer_gone';
  const e = await eligibility(tx, s, o.carrierOrgId, o.vehicleId, true, ctx.now());
  if (e.blocking.length > 0) {
    await tx.update(offers).set({ status: 'expired' }).where(eq(offers.id, o.id));
    return 'not_eligible';
  }
  const price = customerPriceForPayout(
    o.payoutMinor,
    s.taxContext as TaxContext,
    s.pricingSnapshot as PricingConfig,
  );
  if (s.fundedMinor < price.totalMinor) return 'offer_gone';
  await finaliseBooking(ctx, tx, s, {
    carrierOrgId: o.carrierOrgId,
    vehicleId: o.vehicleId,
    price,
    offerId: o.id,
    acceptedBy: o.createdBy,
    cabotageConfirmed: false,
  });
  return 'booked';
}

export async function rejectOffer(
  ctx: Ctx,
  actor: Actor & { userId: string; orgId: string },
  shipmentId: string,
  offerId: string,
) {
  await ctx.db.transaction(async (tx) => {
    const s = await lockShipment(tx, shipmentId);
    if (!s || s.orgId !== actor.orgId) throw notFound();
    const [o] = await tx
      .update(offers)
      .set({ status: 'rejected', decidedBy: actor.userId, decidedAt: ctx.now() })
      .where(
        and(
          eq(offers.id, offerId),
          eq(offers.shipmentId, s.id),
          eq(offers.status, 'pending_customer'),
        ),
      )
      .returning();
    if (!o) throw conflict('offer_not_pending', 'This offer is no longer waiting for a decision');
    await shipmentEvent(tx, s.id, 'offer.rejected', actor, { offerId });
    await notifyOrg(tx, o.carrierOrgId, 'loads.accept', {
      kind: 'offer.rejected',
      shipmentId: s.id,
      dedupeKey: `rejected:${o.id}`,
    });
  });
}

/** A carrier takes back its own pending offer. */
export async function withdrawOffer(ctx: Ctx, actor: Actor & { orgId: string }, offerId: string) {
  const [o] = await ctx.db
    .update(offers)
    .set({ status: 'withdrawn' })
    .where(
      and(
        eq(offers.id, offerId),
        eq(offers.carrierOrgId, actor.orgId),
        eq(offers.status, 'pending_customer'),
      ),
    )
    .returning();
  if (!o) throw conflict('offer_not_pending', 'This offer can no longer be withdrawn');
}

// ---------------------------------------------------------------- background jobs

import { registerJob } from './jobs';

registerJob('expire_offer', async (ctx, payload) => {
  const { offerId } = payload as { offerId: string };
  await ctx.db.transaction(async (tx) => {
    const [o] = await tx.select().from(offers).where(eq(offers.id, offerId)).for('update');
    if (!o || !['pending_customer', 'approved'].includes(o.status) || o.expiresAt > ctx.now())
      return;
    await tx.update(offers).set({ status: 'expired' }).where(eq(offers.id, o.id));
    await tx
      .update(payments)
      .set({ status: 'cancelled', updatedAt: ctx.now() })
      .where(and(eq(payments.offerId, o.id), eq(payments.status, 'pending')));
    await shipmentEvent(tx, o.shipmentId, 'offer.expired', SYSTEM, { offerId: o.id });
    await notifyOrg(tx, o.carrierOrgId, 'loads.accept', {
      kind: 'offer.expired',
      shipmentId: o.shipmentId,
      dedupeKey: `offer-expired:${o.id}`,
    });
  });
});

registerJob('expire_shipment', async (ctx, payload) => {
  const { shipmentId } = payload as { shipmentId: string };
  await ctx.db.transaction(async (tx) => {
    const s = await lockShipment(tx, shipmentId);
    if (!s || s.status !== 'searching' || !s.searchExpiresAt || s.searchExpiresAt > ctx.now())
      return;
    await tx
      .update(shipments)
      .set({ status: 'expired', updatedAt: ctx.now() })
      .where(eq(shipments.id, s.id));
    await tx
      .update(offers)
      .set({ status: 'expired' })
      .where(
        and(eq(offers.shipmentId, s.id), inArray(offers.status, ['pending_customer', 'approved'])),
      );
    await tx
      .update(payments)
      .set({ status: 'cancelled', updatedAt: ctx.now() })
      .where(and(eq(payments.shipmentId, s.id), eq(payments.status, 'pending')));
    await refundAll(tx, s.id, 'expired');
    await shipmentEvent(tx, s.id, 'shipment.expired', SYSTEM);
    await notifyOrg(tx, s.orgId, 'shipments.view', {
      kind: 'shipment.expired',
      shipmentId: s.id,
      dedupeKey: `expired:${s.id}`,
    });
  });
});

/**
 * Finds carriers with a suitable vehicle within the radius of the pickup and tells them. If the
 * shipment is still open later, the radius is widened step by step up to the level's maximum.
 */
registerJob('match_shipment', async (ctx, payload) => {
  const { shipmentId, radiusKm } = payload as { shipmentId: string; radiusKm: number };
  const [s] = await ctx.db.select().from(shipments).where(eq(shipments.id, shipmentId));
  if (!s || s.status !== 'searching') return;
  const m = await matchContext(ctx.db, s);
  const near = await ctx.db.execute<{ vehicle_id: string; org_id: string }>(sql`
    SELECT v.id AS vehicle_id, v.org_id FROM vehicles v
    JOIN organisations o ON o.id = v.org_id AND o.kind = 'carrier' AND o.status = 'verified'
    JOIN shipment_locations p ON p.shipment_id = ${s.id} AND p.kind = 'pickup'
    WHERE v.active AND v.available AND ST_DWithin(v.base_location, p.point, ${radiusKm * 1000})`);
  const onDate = m.pickupWindowEnd.toISOString().slice(0, 10);
  const notified = new Set<string>();
  for (const row of near.rows) {
    if (notified.has(row.org_id)) continue;
    if ((await carrierProblems(ctx.db, row.org_id, onDate)).length > 0) continue;
    const v = await getVehicle(ctx.db, row.org_id, row.vehicle_id);
    const [org] = await ctx.db
      .select({ countries: organisations.operatingCountries })
      .from(organisations)
      .where(eq(organisations.id, row.org_id));
    const problems = v
      ? vehicleProblems(m, v, org?.countries ?? []).filter(
          (p) => p.code !== 'cabotage_confirmation_needed',
        )
      : [{ code: 'x' }];
    if (problems.length > 0) continue;
    notified.add(row.org_id);
    await notifyOrg(ctx.db, row.org_id, 'loads.accept', {
      kind: 'load.matched',
      shipmentId: s.id,
      data: { radiusKm },
      dedupeKey: `match:${s.id}`,
    });
  }
  await shipmentEvent(ctx.db, s.id, 'matching.round', SYSTEM, {
    radiusKm,
    carriersNotified: notified.size,
  });
  const pricing = s.pricingSnapshot as PricingConfig;
  const level = pricing.serviceLevels[s.serviceLevel as ServiceLevel];
  if (radiusKm < level.maxRadiusKm) {
    const next = Math.min(level.maxRadiusKm, radiusKm * 2);
    const waitMinutes = s.serviceLevel === 'express' ? 5 : s.serviceLevel === 'priority' ? 15 : 60;
    await ctx.db.update(shipments).set({ searchRadiusKm: radiusKm }).where(eq(shipments.id, s.id));
    await enqueue(
      ctx.db,
      'match_shipment',
      { shipmentId: s.id, radiusKm: next },
      {
        runAt: new Date(ctx.now().getTime() + waitMinutes * 60_000),
        dedupeKey: `match:${s.id}:${next}`,
      },
    );
  } else
    await ctx.db.update(shipments).set({ searchRadiusKm: radiusKm }).where(eq(shipments.id, s.id));
});

// ---------------------------------------------------------------- carrier views

/**
 * Open loads for a carrier: shipments still searching that at least one of its vehicles can
 * carry. Never shows the customer's maximum, the customer's name or the exact address before booking.
 */
export async function loadBoard(ctx: Ctx, carrierOrgId: string) {
  const [org] = await ctx.db.select().from(organisations).where(eq(organisations.id, carrierOrgId));
  if (!org || org.kind !== 'carrier') throw forbidden('Only carriers see loads');
  const now = ctx.now();
  const open = await ctx.db
    .select()
    .from(shipments)
    .where(
      and(
        eq(shipments.status, 'searching'),
        sql`${shipments.searchExpiresAt} > ${now.toISOString()}`,
      ),
    )
    .limit(500);
  const myVehicles = await ctx.db.execute<{ id: string }>(
    sql`SELECT id FROM vehicles WHERE org_id = ${carrierOrgId} AND active AND available`,
  );
  const vehicles = (
    await Promise.all(myVehicles.rows.map((r) => getVehicle(ctx.db, carrierOrgId, r.id)))
  ).filter((v): v is VehicleRow => !!v);
  const locs = await locationsOf(
    ctx.db,
    open.map((s) => s.id),
  );
  const myOffers = await ctx.db
    .select()
    .from(offers)
    .where(
      and(
        eq(offers.carrierOrgId, carrierOrgId),
        inArray(offers.status, ['pending_customer', 'approved']),
      ),
    );
  const docProblems = await carrierProblems(ctx.db, carrierOrgId, now.toISOString().slice(0, 10));
  const out = [];
  for (const s of open) {
    const l = locs.get(s.id);
    if (!l) continue;
    const m = await matchContext(ctx.db, s);
    const fitting = vehicles
      .map((v) => ({ v, problems: vehicleProblems(m, v, org.operatingCountries) }))
      .filter((x) => x.problems.every((p) => p.code === 'cabotage_confirmation_needed'))
      .map((x) => ({
        id: x.v.id,
        registration: x.v.registration,
        vehicleClass: x.v.vehicleClass,
        cabotageConfirmationNeeded: x.problems.length > 0,
        distanceToPickupKm: Math.round(
          haversine(x.v.baseLat, x.v.baseLng, l.pickup.lat, l.pickup.lng),
        ),
      }))
      .sort((a, b) => a.distanceToPickupKm - b.distanceToPickupKm);
    if (fitting.length === 0) continue;
    const pending = myOffers.find((o) => o.shipmentId === s.id);
    out.push({
      id: s.id,
      number: shipmentNumber(s.number),
      serviceLevel: s.serviceLevel,
      from: {
        city: l.pickup.city,
        postcode: l.pickup.postcode,
        country: l.pickup.country,
        lat: round1(l.pickup.lat),
        lng: round1(l.pickup.lng),
        windowStart: l.pickup.windowStart,
        windowEnd: l.pickup.windowEnd,
      },
      to: {
        city: l.delivery.city,
        postcode: l.delivery.postcode,
        country: l.delivery.country,
        lat: round1(l.delivery.lat),
        lng: round1(l.delivery.lng),
        windowStart: l.delivery.windowStart,
        windowEnd: l.delivery.windowEnd,
      },
      cargo: {
        description: (s.cargo as { description: string }).description,
        weightKg: s.weightKg,
        palletPlaces: s.palletPlaces,
        loadingMetres: s.loadingMetres,
        temperature: (s.cargo as { temperature: unknown }).temperature,
      },
      distanceKm: s.distanceKm,
      routeSource: s.routeSource,
      customs: s.customsResult,
      payoutMinor: s.listedPayoutMinor,
      currency: s.currency,
      guaranteed: true,
      vehicles: fitting,
      myOffer: pending
        ? {
            id: pending.id,
            status: pending.status,
            payoutMinor: pending.payoutMinor,
            expiresAt: pending.expiresAt,
          }
        : null,
      searchExpiresAt: s.searchExpiresAt,
    });
  }
  out.sort((a, b) => a.vehicles[0]!.distanceToPickupKm - b.vehicles[0]!.distanceToPickupKm);
  return {
    loads: out,
    canAccept: docProblems.length === 0 && org.status === 'verified',
    problems: docProblems,
  };
}

function round1(n: number) {
  return Math.round(n * 10) / 10;
}

function haversine(lat1: number, lng1: number, lat2: number, lng2: number) {
  const R = 6371;
  const rad = (d: number) => (d * Math.PI) / 180;
  const h =
    Math.sin(rad(lat2 - lat1) / 2) ** 2 +
    Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(rad(lng2 - lng1) / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

/** The carrier's booked jobs: full addresses and contacts, payout and guarantee. Never the customer's price or maximum. */
export async function carrierBookings(ctx: Ctx, carrierOrgId: string) {
  const rows = await ctx.db
    .select({
      b: bookings,
      s: shipments,
      shipper: organisations.name,
      obligation: carrierObligations,
    })
    .from(bookings)
    .innerJoin(shipments, eq(shipments.id, bookings.shipmentId))
    .innerJoin(organisations, eq(organisations.id, shipments.orgId))
    .leftJoin(carrierObligations, eq(carrierObligations.bookingId, bookings.id))
    .where(eq(bookings.carrierOrgId, carrierOrgId))
    .orderBy(sql`${bookings.createdAt} desc`);
  const locs = await locationsOf(
    ctx.db,
    rows.map((r) => r.s.id),
  );
  return rows.map(({ b, s, shipper, obligation }) => {
    const l = locs.get(s.id)!;
    return {
      bookingId: b.id,
      shipmentId: s.id,
      number: shipmentNumber(s.number),
      status: s.status,
      shipper,
      vehicleId: b.vehicleId,
      driverId: b.driverId,
      pickup: { ...l.pickup, point: undefined },
      delivery: { ...l.delivery, point: undefined },
      cargo: s.cargo,
      weightKg: s.weightKg,
      palletPlaces: s.palletPlaces,
      distanceKm: s.distanceKm,
      customs: { result: s.customsResult, assessment: s.customsAssessment },
      payoutMinor: b.payoutMinor,
      currency: b.currency,
      guarantee: obligation
        ? { status: obligation.status, funded: obligation.funded, terms: obligation.conditions }
        : null,
      bookedAt: b.createdAt,
    };
  });
}

export async function carrierOffers(ctx: Ctx, carrierOrgId: string) {
  return ctx.db
    .select({
      id: offers.id,
      shipmentId: offers.shipmentId,
      status: offers.status,
      payoutMinor: offers.payoutMinor,
      currency: offers.currency,
      expiresAt: offers.expiresAt,
      createdAt: offers.createdAt,
      number: shipments.number,
    })
    .from(offers)
    .innerJoin(shipments, eq(shipments.id, offers.shipmentId))
    .where(eq(offers.carrierOrgId, carrierOrgId))
    .orderBy(sql`${offers.createdAt} desc`)
    .limit(100)
    .then((rows) => rows.map((r) => ({ ...r, number: shipmentNumber(r.number) })));
}
