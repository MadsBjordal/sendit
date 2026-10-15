import { randomUUID } from 'node:crypto';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import {
  assessCustoms,
  cargoTotals,
  estimate,
  maxPayoutWithin,
  suitableClasses,
  type CargoRequirements,
  type PricingConfig,
  type QuoteInput,
  type ServiceLevel,
  type ShipmentInput,
  type TaxContext,
  type VehicleClass,
} from '@freight/shared';
import type { Ctx } from '../context';
import type { DbOrTx, Tx } from '../db/client';
import {
  bookings,
  cargoLines,
  carrierObligations,
  offers,
  organisations,
  payments,
  priceSnapshots,
  shipmentEvents,
  shipmentLocations,
  shipments,
} from '../db/schema';
import { AppError, badRequest, conflict, forbidden, notFound } from '../lib/errors';
import { audit, shipmentEvent, type Actor } from './audit';
import { pointWkt } from './carriers';
import { enqueue } from './jobs';
import { assertRouteOpen, activePricing } from './platformConfig';
import { createPayment } from './payments';
import { touchAddresses } from './addresses';

export function cargoRequirements(
  cargo: Pick<
    ShipmentInput['cargo'],
    'lines' | 'temperature' | 'dangerousGoods' | 'needsTailLiftPickup' | 'needsTailLiftDelivery'
  >,
): CargoRequirements {
  return {
    lines: cargo.lines.map((l) => ({ ...l, stackable: !!l.stackable })),
    temperature: cargo.temperature ?? null,
    dangerousGoods: !!cargo.dangerousGoods,
    needsTailLiftPickup: !!cargo.needsTailLiftPickup,
    needsTailLiftDelivery: !!cargo.needsTailLiftDelivery,
  };
}

/** Price, vehicle and customs for a route and cargo: used by the live estimate and by creating a shipment. */
export async function quote(ctx: Ctx, input: QuoteInput, customerCountry: string) {
  const cargo = cargoRequirements({ ...input, dangerousGoods: false });
  const classes = suitableClasses(cargo);
  if (classes.length === 0)
    throw badRequest(
      'no_vehicle',
      'No vehicle we offer can carry this cargo. Check the sizes and weight, or split it into several shipments.',
    );
  const vehicleClass = classes[0] as VehicleClass;
  const route = await ctx.routing.route(input.pickup, input.delivery);
  const pricing = await activePricing(ctx.db);
  const tax: TaxContext = {
    fromCountry: input.pickup.country,
    toCountry: input.delivery.country,
    customerCountry,
  };
  const est = estimate(
    {
      vehicleClass,
      serviceLevel: input.serviceLevel as ServiceLevel,
      distanceKm: route.distanceKm,
      fromCountry: input.pickup.country,
      toCountry: input.delivery.country,
    },
    tax,
    pricing,
  );
  const customs = assessCustoms({
    from: { country: input.pickup.country, postcode: input.pickup.postcode },
    to: { country: input.delivery.country, postcode: input.delivery.postcode },
    transitCountries: route.transitCountries,
    goodsStatus: input.goodsStatus,
  });
  return {
    vehicleClass,
    suitableClasses: classes,
    route,
    estimate: est,
    customs,
    totals: cargoTotals(cargo.lines),
    pricing,
    tax,
  };
}

export function shipmentNumber(n: number) {
  return `PF-${String(n).padStart(6, '0')}`;
}

async function shipperActor(
  ctx: Ctx,
  actor: Actor & { orgId: string; userId: string },
  emailVerified: boolean,
) {
  const [org] = await ctx.db.select().from(organisations).where(eq(organisations.id, actor.orgId));
  if (!org || org.kind !== 'shipper')
    throw forbidden('Only shipper companies can request transport');
  if (org.status !== 'verified') throw forbidden('Your company is not verified yet');
  if (!emailVerified)
    throw new AppError(
      403,
      'email_not_verified',
      'Confirm your email address first (see the link we sent you)',
    );
  return org;
}

export async function createShipment(
  ctx: Ctx,
  actor: Actor & { orgId: string; userId: string },
  emailVerified: boolean,
  input: ShipmentInput,
) {
  const org = await shipperActor(ctx, actor, emailVerified);
  if (input.cargo.dangerousGoods)
    throw badRequest('dangerous_goods_not_supported', 'Dangerous goods cannot be booked yet');
  await assertRouteOpen(ctx.db, input.pickup.country, input.delivery.country);

  const q = await quote(
    ctx,
    {
      ...input.cargo,
      pickup: input.pickup,
      delivery: input.delivery,
      serviceLevel: input.serviceLevel,
    },
    org.country,
  );
  const level = q.pricing.serviceLevels[input.serviceLevel as ServiceLevel];
  const now = ctx.now();
  const earliest = new Date(now.getTime() + level.pickupLeadMinutes * 60_000);
  if (new Date(input.pickup.windowEnd) < earliest)
    throw badRequest(
      'pickup_too_soon',
      `${input.serviceLevel} needs the pickup window to stay open until at least ${earliest.toISOString()}`,
      { earliest },
    );

  const listedPayout =
    q.estimate.customer.totalMinor <= input.maxPriceMinor
      ? q.estimate.carrier.totalMinor
      : maxPayoutWithin(input.maxPriceMinor, q.tax, q.pricing);
  if (listedPayout <= 0)
    throw badRequest('max_too_low', 'Your maximum does not cover even the platform fee. Raise it.');

  const id = randomUUID();
  // The provider call happens before the transaction, with an idempotency key, so a database
  // failure never leaves money taken without a record (the payment would just be unused).
  const payment = await createPayment(ctx, {
    shipmentId: id,
    orgId: actor.orgId,
    purpose: 'prepayment',
    amountMinor: input.maxPriceMinor,
    currency: q.pricing.currency,
  });

  await ctx.db.transaction(async (tx) => {
    await tx.insert(shipments).values({
      id,
      orgId: actor.orgId,
      createdBy: actor.userId,
      reference: input.reference ?? null,
      status: 'awaiting_payment',
      serviceLevel: input.serviceLevel,
      cargo: {
        description: input.cargo.description,
        category: input.cargo.category,
        fragile: input.cargo.fragile,
        declaredValueMinor: input.cargo.declaredValueMinor ?? null,
        temperature: input.cargo.temperature ?? null,
        dangerousGoods: false,
        needsTailLiftPickup: input.cargo.needsTailLiftPickup,
        needsTailLiftDelivery: input.cargo.needsTailLiftDelivery,
        goodsStatus: input.cargo.goodsStatus,
        hsCode: input.cargo.hsCode ?? null,
      },
      weightKg: q.totals.weightKg,
      palletPlaces: q.totals.palletPlaces,
      loadingMetres: q.totals.loadingMetres,
      volumeM3: q.totals.volumeM3,
      vehicleClass: q.vehicleClass,
      suitableClasses: q.suitableClasses,
      distanceKm: q.route.distanceKm,
      durationMinutes: q.route.durationMinutes,
      routeSource: q.route.source,
      currency: q.pricing.currency,
      pricingVersion: q.pricing.version,
      pricingSnapshot: q.pricing,
      taxContext: q.tax,
      estimatedPayoutMinor: q.estimate.carrier.totalMinor,
      estimatedTotalMinor: q.estimate.customer.totalMinor,
      listedPayoutMinor: listedPayout,
      maxPriceMinor: input.maxPriceMinor,
      customsResult: q.customs.result,
      customsAssessment: q.customs,
      searchRadiusKm: level.initialRadiusKm,
    });
    for (const [kind, p] of [
      ['pickup', input.pickup],
      ['delivery', input.delivery],
    ] as const) {
      await tx.insert(shipmentLocations).values({
        shipmentId: id,
        kind,
        addressLine: p.addressLine,
        postcode: p.postcode,
        city: p.city,
        country: p.country,
        point: pointWkt(p.lat, p.lng),
        lat: p.lat,
        lng: p.lng,
        contactName: p.contactName ?? null,
        contactPhone: p.contactPhone ?? null,
        windowStart: new Date(p.windowStart),
        windowEnd: new Date(p.windowEnd),
        hasForklift: p.hasForklift,
        hasLoadingDock: p.hasLoadingDock,
        instructions: p.instructions ?? null,
      });
    }
    await tx.insert(cargoLines).values(
      input.cargo.lines.map((l, position) => ({
        ...l,
        shipmentId: id,
        position,
        description: l.description ?? null,
      })),
    );
    await tx.insert(priceSnapshots).values({
      shipmentId: id,
      kind: 'estimate',
      pricingVersion: q.pricing.version,
      breakdown: q.estimate,
    });
    await tx.insert(payments).values(payment.row);
    await shipmentEvent(tx, id, 'shipment.created', actor, {
      serviceLevel: input.serviceLevel,
      customs: q.customs.result,
    });
    await audit(tx, actor, 'shipment.created', { type: 'shipment', id });
  });
  await touchAddresses(ctx, actor.orgId, [input.pickup, input.delivery]);
  return { id, payment: payment.clientAction, estimate: q.estimate, customs: q.customs };
}

/** A new prepayment after a failed one. */
export async function retryPayment(ctx: Ctx, actor: Actor & { orgId: string }, shipmentId: string) {
  const [s] = await ctx.db
    .select()
    .from(shipments)
    .where(and(eq(shipments.id, shipmentId), eq(shipments.orgId, actor.orgId)));
  if (!s) throw notFound();
  if (s.status !== 'awaiting_payment')
    throw conflict('not_awaiting_payment', 'This shipment is not waiting for payment');
  const pending = await ctx.db
    .select()
    .from(payments)
    .where(
      and(
        eq(payments.shipmentId, s.id),
        eq(payments.purpose, 'prepayment'),
        eq(payments.status, 'pending'),
      ),
    );
  if (pending[0]) return { kind: 'test_checkout' as const, paymentRef: pending[0].providerRef };
  const p = await createPayment(ctx, {
    shipmentId: s.id,
    orgId: s.orgId,
    purpose: 'prepayment',
    amountMinor: s.maxPriceMinor,
    currency: s.currency,
  });
  await ctx.db.insert(payments).values(p.row);
  return p.clientAction;
}

export type ShipmentRow = typeof shipments.$inferSelect;

/** Locks the shipment row for the rest of the transaction: the heart of first-acceptance-wins. */
export async function lockShipment(tx: Tx, shipmentId: string): Promise<ShipmentRow | null> {
  const [row] = await tx.select().from(shipments).where(eq(shipments.id, shipmentId)).for('update');
  return row ?? null;
}

export async function locationsOf(db: DbOrTx, shipmentIds: string[]) {
  if (shipmentIds.length === 0)
    return new Map<
      string,
      {
        pickup: typeof shipmentLocations.$inferSelect;
        delivery: typeof shipmentLocations.$inferSelect;
      }
    >();
  const rows = await db
    .select()
    .from(shipmentLocations)
    .where(inArray(shipmentLocations.shipmentId, shipmentIds));
  const map = new Map<
    string,
    {
      pickup: typeof shipmentLocations.$inferSelect;
      delivery: typeof shipmentLocations.$inferSelect;
    }
  >();
  for (const id of shipmentIds) {
    const pickup = rows.find((r) => r.shipmentId === id && r.kind === 'pickup');
    const delivery = rows.find((r) => r.shipmentId === id && r.kind === 'delivery');
    if (pickup && delivery) map.set(id, { pickup, delivery });
  }
  return map;
}

function placeView(p: typeof shipmentLocations.$inferSelect, full: boolean) {
  return {
    city: p.city,
    postcode: p.postcode,
    country: p.country,
    lat: full ? p.lat : Math.round(p.lat * 10) / 10,
    lng: full ? p.lng : Math.round(p.lng * 10) / 10,
    windowStart: p.windowStart,
    windowEnd: p.windowEnd,
    hasForklift: p.hasForklift,
    hasLoadingDock: p.hasLoadingDock,
    ...(full
      ? {
          addressLine: p.addressLine,
          contactName: p.contactName,
          contactPhone: p.contactPhone,
          instructions: p.instructions,
        }
      : {}),
  };
}

/** The customer's view of their own shipment. 404 for anyone else's. */
export async function customerShipment(ctx: Ctx, orgId: string, shipmentId: string) {
  const [s] = await ctx.db
    .select()
    .from(shipments)
    .where(and(eq(shipments.id, shipmentId), eq(shipments.orgId, orgId)));
  if (!s) throw notFound();
  const locs = (await locationsOf(ctx.db, [s.id])).get(s.id)!;
  const lines = await ctx.db
    .select()
    .from(cargoLines)
    .where(eq(cargoLines.shipmentId, s.id))
    .orderBy(cargoLines.position);
  const offerRows = await ctx.db
    .select({ o: offers, carrierName: organisations.name })
    .from(offers)
    .innerJoin(organisations, eq(organisations.id, offers.carrierOrgId))
    .where(eq(offers.shipmentId, s.id))
    .orderBy(desc(offers.createdAt));
  const [booking] = await ctx.db
    .select({ b: bookings, carrierName: organisations.name })
    .from(bookings)
    .innerJoin(organisations, eq(organisations.id, bookings.carrierOrgId))
    .where(eq(bookings.shipmentId, s.id));
  const pays = await ctx.db
    .select()
    .from(payments)
    .where(eq(payments.shipmentId, s.id))
    .orderBy(payments.createdAt);
  const events = await ctx.db
    .select()
    .from(shipmentEvents)
    .where(eq(shipmentEvents.shipmentId, s.id))
    .orderBy(shipmentEvents.id);
  return {
    id: s.id,
    number: shipmentNumber(s.number),
    reference: s.reference,
    status: s.status,
    serviceLevel: s.serviceLevel,
    cargo: s.cargo,
    lines,
    totals: {
      weightKg: s.weightKg,
      palletPlaces: s.palletPlaces,
      loadingMetres: s.loadingMetres,
      volumeM3: s.volumeM3,
    },
    vehicleClass: s.vehicleClass,
    route: { distanceKm: s.distanceKm, durationMinutes: s.durationMinutes, source: s.routeSource },
    pickup: placeView(locs.pickup, true),
    delivery: placeView(locs.delivery, true),
    currency: s.currency,
    estimatedTotalMinor: s.estimatedTotalMinor,
    maxPriceMinor: s.maxPriceMinor,
    fundedMinor: s.fundedMinor,
    customs: { result: s.customsResult, assessment: s.customsAssessment },
    search: {
      radiusKm: s.searchRadiusKm,
      publishedAt: s.publishedAt,
      expiresAt: s.searchExpiresAt,
    },
    offers: offerRows.map(({ o, carrierName }) => ({
      id: o.id,
      carrierName,
      status: o.status,
      totalMinor: o.totalMinor,
      vatMinor: o.vatMinor,
      overMaxMinor: o.totalMinor - s.maxPriceMinor,
      expiresAt: o.expiresAt,
      createdAt: o.createdAt,
    })),
    booking: booking
      ? {
          id: booking.b.id,
          carrierName: booking.carrierName,
          netMinor: booking.b.netMinor,
          vatMinor: booking.b.vatMinor,
          totalMinor: booking.b.totalMinor,
          bookedAt: booking.b.createdAt,
        }
      : null,
    payments: pays.map((p) => ({
      id: p.id,
      purpose: p.purpose,
      amountMinor: p.amountMinor,
      status: p.status,
      providerRef: p.providerRef,
      failureReason: p.failureReason,
      provider: p.provider,
    })),
    events: events.map((e) => ({ kind: e.kind, at: e.createdAt, data: e.data })),
    createdAt: s.createdAt,
  };
}

export async function customerShipments(ctx: Ctx, orgId: string) {
  const rows = await ctx.db
    .select()
    .from(shipments)
    .where(eq(shipments.orgId, orgId))
    .orderBy(desc(shipments.createdAt))
    .limit(200);
  const locs = await locationsOf(
    ctx.db,
    rows.map((r) => r.id),
  );
  const pendingOffers = await ctx.db
    .select({ shipmentId: offers.shipmentId, n: sql<number>`count(*)::int` })
    .from(offers)
    .where(
      and(
        inArray(
          offers.shipmentId,
          rows.length ? rows.map((r) => r.id) : ['00000000-0000-0000-0000-000000000000'],
        ),
        eq(offers.status, 'pending_customer'),
      ),
    )
    .groupBy(offers.shipmentId);
  return rows.map((s) => {
    const l = locs.get(s.id)!;
    return {
      id: s.id,
      number: shipmentNumber(s.number),
      reference: s.reference,
      status: s.status,
      serviceLevel: s.serviceLevel,
      from: { city: l.pickup.city, country: l.pickup.country, windowStart: l.pickup.windowStart },
      to: { city: l.delivery.city, country: l.delivery.country },
      maxPriceMinor: s.maxPriceMinor,
      estimatedTotalMinor: s.estimatedTotalMinor,
      currency: s.currency,
      pendingOffers: pendingOffers.find((p) => p.shipmentId === s.id)?.n ?? 0,
      createdAt: s.createdAt,
    };
  });
}

/** Cancel before a carrier is booked: everything paid is refunded. */
export async function cancelShipment(
  ctx: Ctx,
  actor: Actor & { orgId: string },
  shipmentId: string,
  reason: string,
) {
  await ctx.db.transaction(async (tx) => {
    const s = await lockShipment(tx, shipmentId);
    if (!s || s.orgId !== actor.orgId) throw notFound();
    if (!['draft', 'awaiting_payment', 'searching'].includes(s.status))
      throw conflict(
        'cannot_cancel',
        s.status === 'booked'
          ? 'A booked shipment cannot be cancelled online yet. Contact support.'
          : 'This shipment cannot be cancelled',
      );
    await tx
      .update(shipments)
      .set({
        status: 'cancelled',
        cancelledAt: ctx.now(),
        cancelReason: reason,
        updatedAt: ctx.now(),
      })
      .where(eq(shipments.id, s.id));
    await tx
      .update(offers)
      .set({ status: 'superseded' })
      .where(
        and(eq(offers.shipmentId, s.id), inArray(offers.status, ['pending_customer', 'approved'])),
      );
    await tx
      .update(payments)
      .set({ status: 'cancelled', updatedAt: ctx.now() })
      .where(and(eq(payments.shipmentId, s.id), eq(payments.status, 'pending')));
    await refundAll(tx, s.id, 'cancelled');
    await shipmentEvent(tx, s.id, 'shipment.cancelled', actor, { reason });
    await audit(tx, actor, 'shipment.cancelled', { type: 'shipment', id: s.id });
  });
}

/** Queues refunds of everything held for a shipment (each payment, minus what was refunded). */
export async function refundAll(tx: DbOrTx, shipmentId: string, reason: string) {
  await enqueue(
    tx,
    'refund_excess',
    { shipmentId, keepMinor: 0, reason },
    { dedupeKey: `refund:${shipmentId}:${reason}` },
  );
}

export async function obligationFor(db: DbOrTx, bookingId: string) {
  const [o] = await db
    .select()
    .from(carrierObligations)
    .where(eq(carrierObligations.bookingId, bookingId));
  return o ?? null;
}

export type { PricingConfig };

/** What is needed to book the same transport again (dates are chosen anew). */
export async function shipmentTemplate(ctx: Ctx, orgId: string, shipmentId: string) {
  const [s] = await ctx.db
    .select()
    .from(shipments)
    .where(and(eq(shipments.id, shipmentId), eq(shipments.orgId, orgId)));
  if (!s) throw notFound();
  const locs = (await locationsOf(ctx.db, [s.id])).get(s.id)!;
  const lines = await ctx.db
    .select()
    .from(cargoLines)
    .where(eq(cargoLines.shipmentId, s.id))
    .orderBy(cargoLines.position);
  const place = (p: typeof shipmentLocations.$inferSelect) => ({
    label: `${p.addressLine}, ${p.postcode} ${p.city}, ${p.country}`,
    addressLine: p.addressLine,
    postcode: p.postcode,
    city: p.city,
    country: p.country,
    lat: p.lat,
    lng: p.lng,
    contactName: p.contactName,
    contactPhone: p.contactPhone,
    hasForklift: p.hasForklift,
    hasLoadingDock: p.hasLoadingDock,
    instructions: p.instructions,
    // Time of day only; the dates are chosen again
    fromTime: p.windowStart.toISOString().slice(11, 16),
    toTime: p.windowEnd.toISOString().slice(11, 16),
  });
  const cargo = s.cargo as Record<string, unknown>;
  return {
    pickup: place(locs.pickup),
    delivery: place(locs.delivery),
    cargo: {
      ...cargo,
      lines: lines.map(
        ({ quantity, kind, lengthCm, widthCm, heightCm, weightKg, stackable, description }) => ({
          quantity,
          kind,
          lengthCm,
          widthCm,
          heightCm,
          weightKg,
          stackable,
          description,
        }),
      ),
    },
    serviceLevel: s.serviceLevel,
    maxPriceMinor: s.maxPriceMinor,
    reference: s.reference,
  };
}
