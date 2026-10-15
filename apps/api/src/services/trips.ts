import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import { z } from 'zod';
import type { Ctx } from '../context';
import type { Tx } from '../db/client';
import {
  bookings,
  cargoLines,
  carrierObligations,
  files,
  organisations,
  shipmentLocations,
  shipments,
  trackingPositions,
  tripEvents,
} from '../db/schema';
import { badRequest, conflict, forbidden, notFound } from '../lib/errors';
import { shipmentEvent, type Actor } from './audit';
import type { SessionInfo } from './auth';
import { shipmentAccess } from './access';
import { driverOf } from './drivers';
import { saveFile } from './files';
import { enqueue, registerJob } from './jobs';
import { post } from './ledger';
import { notifyOrg } from './notifications';
import { lockShipment, shipmentNumber } from './shipments';

export const TRIP_ACTIONS = [
  'pickup.arrived',
  'pickup.loaded',
  'pickup.departed',
  'border.crossed',
  'delay.reported',
  'delivery.arrived',
  'delivery.delivered',
  'note',
] as const;
export type TripAction = (typeof TRIP_ACTIONS)[number];

export const tripEventSchema = z.object({
  /** Made by the app when the action happens, so a resend after a lost connection is recognised */
  clientEventId: z.string().min(8).max(100),
  action: z.enum(TRIP_ACTIONS),
  occurredAt: z.string().datetime({ offset: true }),
  lat: z.number().min(-90).max(90).nullable().optional(),
  lng: z.number().min(-180).max(180).nullable().optional(),
  countedUnits: z.number().int().min(0).max(100_000).nullable().optional(),
  discrepancy: z.string().trim().max(2000).nullable().optional(),
  damage: z.boolean().default(false),
  damageNote: z.string().trim().max(2000).nullable().optional(),
  recipientName: z.string().trim().max(200).nullable().optional(),
  signatureFileId: z.string().uuid().nullable().optional(),
  photoFileIds: z.array(z.string().uuid()).max(20).default([]),
  delayMinutes: z
    .number()
    .int()
    .min(1)
    .max(7 * 24 * 60)
    .nullable()
    .optional(),
  note: z.string().trim().max(2000).nullable().optional(),
  country: z
    .string()
    .regex(/^[A-Z]{2}$/)
    .nullable()
    .optional(),
});
export type TripEventInput = z.infer<typeof tripEventSchema>;

/** Who may record on the road: the assigned driver, or the carrier's own staff on their behalf. */
async function tripActor(ctx: Ctx, session: SessionInfo, shipmentId: string) {
  const access = await shipmentAccess(ctx, session, shipmentId);
  if (access.role === 'driver') return { ...access, recordedAs: 'driver' as const };
  if (
    access.role === 'carrier' &&
    session.role &&
    ['owner', 'admin', 'dispatcher'].includes(session.role)
  )
    return { ...access, recordedAs: 'dispatcher' as const };
  throw forbidden('Only the assigned driver or the carrier’s dispatcher can record this');
}

const ACTIVE = ['booked', 'in_transit'];

/**
 * Records one thing that happened on the road. Repeating the same client event id returns the first
 * record (safe offline retries). Checks the order of events and what each one needs.
 */
export async function recordTripEvent(
  ctx: Ctx,
  session: SessionInfo,
  shipmentId: string,
  input: TripEventInput,
) {
  const who = await tripActor(ctx, session, shipmentId);
  return ctx.db.transaction(async (tx) => {
    const [dup] = await tx
      .select()
      .from(tripEvents)
      .where(
        and(
          eq(tripEvents.shipmentId, shipmentId),
          eq(tripEvents.clientEventId, input.clientEventId),
        ),
      );
    if (dup) return { duplicate: true, event: dup };
    const s = (await lockShipment(tx, shipmentId))!;
    const now = ctx.now();
    const at = new Date(input.occurredAt);
    if (at.getTime() > now.getTime() + 5 * 60_000)
      throw badRequest('time_in_future', 'The time is in the future: check the phone’s clock');
    if (s.bookedAt && at.getTime() < s.bookedAt.getTime() - 60 * 60_000)
      throw badRequest('time_before_booking', 'The time is before the job was booked');
    if (!ACTIVE.includes(s.status))
      throw conflict('trip_closed', `This job is ${s.status}: nothing more can be recorded`);
    const done = await tx
      .select({ action: tripEvents.action })
      .from(tripEvents)
      .where(eq(tripEvents.shipmentId, shipmentId));
    const has = (a: TripAction) => done.some((d) => d.action === a);

    // Files must be this shipment's
    const fileIds = [
      ...input.photoFileIds,
      ...(input.signatureFileId ? [input.signatureFileId] : []),
    ];
    if (fileIds.length) {
      const found = await tx
        .select({ id: files.id })
        .from(files)
        .where(and(inArray(files.id, fileIds), eq(files.shipmentId, shipmentId)));
      if (found.length !== new Set(fileIds).size)
        throw badRequest('file_not_found', 'A photo or signature was not uploaded for this job');
    }
    const lines = await tx.select().from(cargoLines).where(eq(cargoLines.shipmentId, shipmentId));
    const expectedUnits = lines.reduce((n, l) => n + l.quantity, 0);

    switch (input.action) {
      case 'pickup.loaded':
        if (has('pickup.loaded')) throw conflict('already_loaded', 'Loading was already confirmed');
        if (input.countedUnits == null)
          throw badRequest('count_required', 'Count the units loaded');
        if (input.countedUnits !== expectedUnits && !input.discrepancy)
          throw badRequest(
            'discrepancy_required',
            `Expected ${expectedUnits} units: describe the difference`,
            { expectedUnits },
          );
        break;
      case 'pickup.departed':
        if (!has('pickup.loaded')) throw conflict('not_loaded', 'Confirm loading first');
        break;
      case 'delivery.arrived':
        if (!has('pickup.loaded')) throw conflict('not_loaded', 'Confirm loading first');
        break;
      case 'delivery.delivered':
        if (!has('pickup.loaded')) throw conflict('not_loaded', 'Confirm loading first');
        if (input.countedUnits == null)
          throw badRequest('count_required', 'Count the units delivered');
        if (!input.recipientName)
          throw badRequest(
            'recipient_required',
            'Enter the name of the person receiving the goods',
          );
        if (!input.signatureFileId && input.photoFileIds.length === 0)
          throw badRequest(
            'evidence_required',
            'Add the recipient’s signature or a photo of the delivered goods',
          );
        if (input.damage && !input.damageNote)
          throw badRequest('damage_note_required', 'Describe the damage');
        break;
      case 'delay.reported':
        if (!input.delayMinutes) throw badRequest('delay_required', 'How long is the delay?');
        break;
      case 'border.crossed':
        if (!input.country) throw badRequest('country_required', 'Which country was entered?');
        break;
    }

    const [ev] = await tx
      .insert(tripEvents)
      .values({
        shipmentId,
        clientEventId: input.clientEventId,
        action: input.action,
        occurredAt: at,
        lat: input.lat ?? null,
        lng: input.lng ?? null,
        countedUnits: input.countedUnits ?? null,
        discrepancy: input.discrepancy ?? null,
        damage: input.damage,
        damageNote: input.damageNote ?? null,
        recipientName: input.recipientName ?? null,
        signatureFileId: input.signatureFileId ?? null,
        photoFileIds: input.photoFileIds,
        delayMinutes: input.delayMinutes ?? null,
        note: input.note ?? null,
        country: input.country ?? null,
        recordedBy: session.user.id,
        recordedAs: who.recordedAs,
      })
      .returning();
    const actor: Actor = { userId: session.user.id, orgId: session.org?.id };
    await shipmentEvent(tx, shipmentId, `trip.${input.action}`, actor, {
      countedUnits: input.countedUnits ?? undefined,
      damage: input.damage || undefined,
      delayMinutes: input.delayMinutes ?? undefined,
      country: input.country ?? undefined,
    });

    if (input.action === 'pickup.loaded') {
      await tx
        .update(shipments)
        .set({ status: 'in_transit', collectedAt: at, updatedAt: now })
        .where(eq(shipments.id, shipmentId));
      await notifyOrg(tx, s.orgId, 'shipments.view', {
        kind: 'shipment.collected',
        shipmentId,
        dedupeKey: `collected:${shipmentId}`,
      });
    }
    if (input.action === 'delivery.delivered') {
      await tx
        .update(shipments)
        .set({ status: 'delivered', deliveredAt: at, updatedAt: now })
        .where(eq(shipments.id, shipmentId));
      await enqueue(tx, 'generate_pod', { shipmentId }, { dedupeKey: `pod:${shipmentId}` });
      await enqueue(
        tx,
        'auto_accept_delivery',
        { shipmentId },
        {
          runAt: new Date(now.getTime() + ctx.config.deliveryAcceptHours * 3_600_000),
          dedupeKey: `auto-accept:${shipmentId}`,
        },
      );
      await notifyOrg(tx, s.orgId, 'shipments.view', {
        kind: 'shipment.delivered',
        shipmentId,
        dedupeKey: `delivered:${shipmentId}`,
      });
    }
    return { duplicate: false, event: ev! };
  });
}

export const positionsSchema = z.object({
  positions: z
    .array(
      z.object({
        at: z.string().datetime({ offset: true }),
        lat: z.number().min(-90).max(90),
        lng: z.number().min(-180).max(180),
        accuracyM: z.number().min(0).max(100_000).nullable().optional(),
        speedKmh: z.number().min(0).max(300).nullable().optional(),
      }),
    )
    .min(1)
    .max(500),
});

/**
 * Positions from the driver app, sent in batches (also after being offline). Accepted only from the
 * assigned driver and only while the job is active: no tracking outside a job.
 */
export async function recordPositions(
  ctx: Ctx,
  session: SessionInfo,
  shipmentId: string,
  input: z.infer<typeof positionsSchema>,
) {
  const access = await shipmentAccess(ctx, session, shipmentId);
  if (access.role !== 'driver') throw forbidden('Only the assigned driver’s app sends positions');
  if (!ACTIVE.includes(access.shipment.status))
    throw conflict('trip_closed', 'Tracking stopped: the job is finished');
  const driver = await driverOf(ctx, session.org!.id, session.user.id);
  const now = ctx.now().getTime();
  const rows = input.positions
    .filter(
      (p) =>
        new Date(p.at).getTime() <= now + 5 * 60_000 &&
        new Date(p.at).getTime() >= now - 7 * 86_400_000,
    )
    .map((p) => ({
      shipmentId,
      driverId: driver!.id,
      at: new Date(p.at),
      lat: p.lat,
      lng: p.lng,
      accuracyM: p.accuracyM ?? null,
      speedKmh: p.speedKmh ?? null,
    }));
  if (rows.length) await ctx.db.insert(trackingPositions).values(rows);
  return { accepted: rows.length };
}

const ROAD_FACTOR = 1.25;
const KMH = 65;
function haversineKm(a: { lat: number; lng: number }, b: { lat: number; lng: number }) {
  const R = 6371;
  const rad = (d: number) => (d * Math.PI) / 180;
  const h =
    Math.sin(rad(b.lat - a.lat) / 2) ** 2 +
    Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(rad(b.lng - a.lng) / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

/**
 * The trip as the person asking may see it. Shippers see progress, the last position while the goods
 * are on board, an estimated arrival and the evidence, but never who the driver is.
 */
export async function tripView(ctx: Ctx, session: SessionInfo, shipmentId: string) {
  const { role, shipment: s, booking } = await shipmentAccess(ctx, session, shipmentId);
  const events = await ctx.db
    .select()
    .from(tripEvents)
    .where(eq(tripEvents.shipmentId, shipmentId))
    .orderBy(asc(tripEvents.occurredAt));
  const [last] = await ctx.db
    .select()
    .from(trackingPositions)
    .where(eq(trackingPositions.shipmentId, shipmentId))
    .orderBy(desc(trackingPositions.at))
    .limit(1);
  const [delivery] = await ctx.db
    .select()
    .from(shipmentLocations)
    .where(
      and(eq(shipmentLocations.shipmentId, shipmentId), eq(shipmentLocations.kind, 'delivery')),
    );
  const showPosition = s.status === 'in_transit' || (role !== 'shipper' && s.status === 'booked');
  let eta: { at: string; remainingKm: number; source: 'straight_line_estimate' } | null = null;
  if (last && s.status === 'in_transit') {
    const km = Math.round(haversineKm(last, delivery!) * ROAD_FACTOR);
    const delays = events
      .filter((e) => e.action === 'delay.reported')
      .reduce((n, e) => n + (e.delayMinutes ?? 0), 0);
    eta = {
      at: new Date(
        Math.max(ctx.now().getTime(), last.at.getTime()) + ((km / KMH) * 60 + delays) * 60_000,
      ).toISOString(),
      remainingKm: km,
      source: 'straight_line_estimate',
    };
  }
  return {
    role,
    status: s.status,
    driverAssigned: !!booking?.driverId,
    collectedAt: s.collectedAt,
    deliveredAt: s.deliveredAt,
    completedAt: s.completedAt,
    podFileId: s.podFileId,
    position: showPosition && last ? { lat: last.lat, lng: last.lng, at: last.at } : null,
    eta,
    events: events.map((e) => ({
      action: e.action,
      occurredAt: e.occurredAt,
      countedUnits: e.countedUnits,
      discrepancy: e.discrepancy,
      damage: e.damage,
      damageNote: e.damageNote,
      recipientName: e.recipientName,
      signatureFileId: e.signatureFileId,
      photoFileIds: e.photoFileIds,
      delayMinutes: e.delayMinutes,
      note: e.note,
      country: e.country,
      ...(role === 'shipper' ? {} : { recordedAs: e.recordedAs }),
    })),
    acceptDeadline:
      s.deliveredAt && s.status === 'delivered'
        ? new Date(s.deliveredAt.getTime() + ctx.config.deliveryAcceptHours * 3_600_000)
        : null,
  };
}

// ---------------------------------------------------------------- proof of delivery

registerJob('generate_pod', async (ctx, payload) => {
  const { shipmentId } = payload as { shipmentId: string };
  const [s] = await ctx.db.select().from(shipments).where(eq(shipments.id, shipmentId));
  if (!s || s.podFileId) return;
  const [b] = await ctx.db.select().from(bookings).where(eq(bookings.shipmentId, shipmentId));
  const [shipper] = await ctx.db.select().from(organisations).where(eq(organisations.id, s.orgId));
  const [carrier] = await ctx.db
    .select()
    .from(organisations)
    .where(eq(organisations.id, b!.carrierOrgId));
  const locs = await ctx.db
    .select()
    .from(shipmentLocations)
    .where(eq(shipmentLocations.shipmentId, shipmentId));
  const events = await ctx.db
    .select()
    .from(tripEvents)
    .where(eq(tripEvents.shipmentId, shipmentId))
    .orderBy(asc(tripEvents.occurredAt));
  const lines = await ctx.db.select().from(cargoLines).where(eq(cargoLines.shipmentId, shipmentId));
  const loaded = events.find((e) => e.action === 'pickup.loaded');
  const delivered = events.find((e) => e.action === 'delivery.delivered');
  if (!delivered) return;

  const pdf = await PDFDocument.create();
  pdf.setTitle(`Proof of delivery ${shipmentNumber(s.number)}`);
  const page = pdf.addPage([595, 842]);
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  let y = 800;
  // Standard PDF fonts cover Western European characters only; anything else is replaced
  const safe = (t: string) => t.replace(/[^\x20-\x7E\xA0-\xFF]/g, '?');
  const line = (text: string, opts: { size?: number; font?: typeof font; gap?: number } = {}) => {
    page.drawText(safe(text), {
      x: 50,
      y,
      size: opts.size ?? 10,
      font: opts.font ?? font,
      color: rgb(0.1, 0.1, 0.15),
    });
    y -= opts.gap ?? 15;
  };
  line(ctx.config.brand.name, { size: 12, font: bold, gap: 26 });
  line(`Proof of delivery  ${shipmentNumber(s.number)}`, { size: 18, font: bold, gap: 26 });
  line(`Shipper: ${shipper!.name}${s.reference ? `   Reference: ${s.reference}` : ''}`);
  line(`Carrier: ${carrier!.name}`, { gap: 22 });
  for (const kind of ['pickup', 'delivery'] as const) {
    const l = locs.find((x) => x.kind === kind)!;
    line(kind === 'pickup' ? 'Collected from' : 'Delivered to', { font: bold });
    line(`${l.addressLine}, ${l.postcode} ${l.city}, ${l.country}`);
    const e = kind === 'pickup' ? loaded : delivered;
    line(
      e
        ? `${e.occurredAt.toISOString().replace('T', ' ').slice(0, 16)} UTC   units counted: ${e.countedUnits ?? '-'}`
        : 'not recorded',
      { gap: 20 },
    );
  }
  line('Goods', { font: bold });
  line(
    `${(s.cargo as { description: string }).description}: ${lines.reduce((n, l) => n + l.quantity, 0)} units, ${s.weightKg} kg`,
    { gap: 20 },
  );
  if (loaded?.discrepancy) line(`Discrepancy at pickup: ${loaded.discrepancy}`);
  if (delivered.discrepancy) line(`Discrepancy at delivery: ${delivered.discrepancy}`);
  line(`Damage reported: ${delivered.damage ? `YES - ${delivered.damageNote}` : 'no'}`, {
    gap: 20,
  });
  line(`Received by: ${delivered.recipientName}`, { font: bold });
  line(
    `Photos: ${delivered.photoFileIds.length + (loaded?.photoFileIds.length ?? 0)} (kept with the shipment)`,
  );
  if (delivered.signatureFileId) {
    const [f] = await ctx.db.select().from(files).where(eq(files.id, delivered.signatureFileId));
    if (f && (f.contentType === 'image/png' || f.contentType === 'image/jpeg')) {
      const data = await ctx.storage.get(f.storageKey);
      const img =
        f.contentType === 'image/png' ? await pdf.embedPng(data) : await pdf.embedJpg(data);
      const scale = Math.min(200 / img.width, 80 / img.height, 1);
      y -= 85;
      page.drawImage(img, { x: 50, y, width: img.width * scale, height: img.height * scale });
      y -= 15;
      line('Signature of the recipient');
    }
  }
  y = 60;
  line(
    `Generated ${ctx.now().toISOString().replace('T', ' ').slice(0, 16)} UTC from the records made at pickup and delivery. Times are UTC.`,
    { size: 8 },
  );
  const bytes = Buffer.from(await pdf.save());
  await ctx.db.transaction(async (tx) => {
    const file = await saveFile(ctx, tx, {
      orgId: s.orgId,
      shipmentId,
      kind: 'pod',
      contentType: 'application/pdf',
      data: bytes,
      fileName: `POD-${shipmentNumber(s.number)}.pdf`,
      uploadedBy: null,
    });
    await tx.update(shipments).set({ podFileId: file.id }).where(eq(shipments.id, shipmentId));
  });
});

// ---------------------------------------------------------------- acceptance and completion

/**
 * Delivery accepted (by the customer, or automatically after the acceptance period): the transport
 * contract is complete, our fee is earned and the carrier's payout becomes due.
 */
async function complete(
  ctx: Ctx,
  tx: Tx,
  shipmentId: string,
  how: 'customer' | 'automatic',
  actor: Actor,
) {
  const s = (await lockShipment(tx, shipmentId))!;
  if (s.status !== 'delivered') return false;
  const now = ctx.now();
  await tx
    .update(shipments)
    .set({ status: 'completed', completedAt: now, updatedAt: now })
    .where(eq(shipments.id, shipmentId));
  const [b] = await tx.select().from(bookings).where(eq(bookings.shipmentId, shipmentId));
  await post(
    tx,
    {
      kind: 'revenue_recognised',
      refType: 'booking',
      refId: b!.id,
      idempotencyKey: `revenue:${b!.id}`,
      currency: b!.currency,
    },
    [
      { account: 'platform_revenue_deferred', amountMinor: b!.platformFeeMinor },
      { account: 'platform_revenue', amountMinor: -b!.platformFeeMinor },
    ],
  );
  const [o] = await tx
    .update(carrierObligations)
    .set({ status: 'payable', payableAt: now })
    .where(and(eq(carrierObligations.bookingId, b!.id), eq(carrierObligations.status, 'committed')))
    .returning();
  if (o)
    await enqueue(tx, 'carrier_payout', { obligationId: o.id }, { dedupeKey: `payout:${o.id}` });
  await shipmentEvent(tx, shipmentId, 'shipment.completed', actor, { how });
  return true;
}

export async function confirmDelivery(ctx: Ctx, session: SessionInfo, shipmentId: string) {
  const { role } = await shipmentAccess(ctx, session, shipmentId);
  if (role !== 'shipper') throw notFound();
  const ok = await ctx.db.transaction((tx) =>
    complete(ctx, tx, shipmentId, 'customer', { userId: session.user.id, orgId: session.org?.id }),
  );
  if (!ok) throw conflict('not_delivered', 'Only a delivered shipment can be confirmed');
}

registerJob('auto_accept_delivery', async (ctx, payload) => {
  const { shipmentId } = payload as { shipmentId: string };
  await ctx.db.transaction((tx) =>
    complete(ctx, tx, shipmentId, 'automatic', { userId: null, orgId: null }),
  );
});

/** Deletes positions older than the retention period (privacy). Runs daily. */
registerJob('purge_tracking', async (ctx) => {
  const cutoff = new Date(ctx.now().getTime() - ctx.config.trackingRetentionDays * 86_400_000);
  await ctx.db
    .delete(trackingPositions)
    .where(sql`${trackingPositions.at} < ${cutoff.toISOString()}`);
  await enqueue(
    ctx.db,
    'purge_tracking',
    {},
    { runAt: new Date(ctx.now().getTime() + 86_400_000), dedupeKey: 'purge_tracking' },
  );
});

/** Everything the assigned driver needs for their jobs (full addresses and contacts, no prices of the customer). */
export async function driverJobs(ctx: Ctx, session: SessionInfo) {
  if (session.role !== 'driver' || !session.org) throw forbidden('This is for drivers');
  const d = await driverOf(ctx, session.org.id, session.user.id);
  if (!d) return [];
  const rows = await ctx.db
    .select({ b: bookings, s: shipments })
    .from(bookings)
    .innerJoin(shipments, eq(shipments.id, bookings.shipmentId))
    .where(eq(bookings.driverId, d.id))
    .orderBy(desc(bookings.assignedAt))
    .limit(100);
  const locs = rows.length
    ? await ctx.db
        .select()
        .from(shipmentLocations)
        .where(
          inArray(
            shipmentLocations.shipmentId,
            rows.map((r) => r.s.id),
          ),
        )
    : [];
  const lines = rows.length
    ? await ctx.db
        .select()
        .from(cargoLines)
        .where(
          inArray(
            cargoLines.shipmentId,
            rows.map((r) => r.s.id),
          ),
        )
    : [];
  const evs = rows.length
    ? await ctx.db
        .select({ shipmentId: tripEvents.shipmentId, action: tripEvents.action })
        .from(tripEvents)
        .where(
          inArray(
            tripEvents.shipmentId,
            rows.map((r) => r.s.id),
          ),
        )
    : [];
  const place = (l: typeof shipmentLocations.$inferSelect) => ({
    addressLine: l.addressLine,
    postcode: l.postcode,
    city: l.city,
    country: l.country,
    lat: l.lat,
    lng: l.lng,
    windowStart: l.windowStart,
    windowEnd: l.windowEnd,
    contactName: l.contactName,
    contactPhone: l.contactPhone,
    hasForklift: l.hasForklift,
    hasLoadingDock: l.hasLoadingDock,
    instructions: l.instructions,
  });
  return rows.map(({ s }) => {
    const p = locs.find((l) => l.shipmentId === s.id && l.kind === 'pickup')!;
    const dl = locs.find((l) => l.shipmentId === s.id && l.kind === 'delivery')!;
    const myLines = lines.filter((l) => l.shipmentId === s.id);
    return {
      shipmentId: s.id,
      number: shipmentNumber(s.number),
      status: s.status,
      pickup: place(p),
      delivery: place(dl),
      cargo: {
        description: (s.cargo as { description: string }).description,
        units: myLines.reduce((n, l) => n + l.quantity, 0),
        weightKg: s.weightKg,
        lines: myLines.map(
          ({ quantity, kind, lengthCm, widthCm, heightCm, weightKg, stackable }) => ({
            quantity,
            kind,
            lengthCm,
            widthCm,
            heightCm,
            weightKg,
            stackable,
          }),
        ),
        temperature: (s.cargo as { temperature: unknown }).temperature,
      },
      customs: s.customsResult,
      done: evs.filter((e) => e.shipmentId === s.id).map((e) => e.action),
    };
  });
}
