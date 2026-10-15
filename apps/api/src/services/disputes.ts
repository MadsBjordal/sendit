import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { Ctx } from '../context';
import {
  bookings,
  carrierObligations,
  disputes,
  files,
  organisations,
  payments,
  refunds,
  shipments,
} from '../db/schema';
import { badRequest, conflict, notFound } from '../lib/errors';
import { audit, shipmentEvent, type Actor } from './audit';
import type { SessionInfo } from './auth';
import { shipmentAccess } from './access';
import { post } from './ledger';
import { notifyOrg } from './notifications';
import { lockShipment } from './shipments';
import { complete } from './trips';

export const openDisputeSchema = z.object({
  kind: z.enum(['damage', 'shortage', 'not_delivered', 'late', 'other']),
  description: z.string().trim().min(10).max(4000),
  evidenceFileIds: z.array(z.string().uuid()).max(20).default([]),
});

/**
 * The customer reports a problem with a delivery before accepting it. The shipment is not completed
 * and the carrier's payout is held until support decides.
 */
export async function openDispute(
  ctx: Ctx,
  session: SessionInfo,
  shipmentId: string,
  input: z.infer<typeof openDisputeSchema>,
) {
  const { role } = await shipmentAccess(ctx, session, shipmentId);
  if (role !== 'shipper') throw notFound();
  return ctx.db.transaction(async (tx) => {
    const s = (await lockShipment(tx, shipmentId))!;
    if (s.status !== 'delivered')
      throw conflict(
        'cannot_dispute',
        'A problem can be reported after delivery and before the delivery is accepted',
      );
    if (input.evidenceFileIds.length) {
      const found = await tx
        .select({ id: files.id })
        .from(files)
        .where(and(inArray(files.id, input.evidenceFileIds), eq(files.shipmentId, shipmentId)));
      if (found.length !== new Set(input.evidenceFileIds).size)
        throw badRequest('file_not_found', 'A photo was not uploaded for this shipment');
    }
    const [d] = await tx
      .insert(disputes)
      .values({
        shipmentId,
        openedByOrgId: s.orgId,
        openedBy: session.user.id,
        kind: input.kind,
        description: input.description,
        evidenceFileIds: input.evidenceFileIds,
        status: 'open',
      })
      .returning();
    await tx
      .update(shipments)
      .set({ status: 'disputed', updatedAt: ctx.now() })
      .where(eq(shipments.id, shipmentId));
    const [b] = await tx.select().from(bookings).where(eq(bookings.shipmentId, shipmentId));
    await tx
      .update(carrierObligations)
      .set({ status: 'disputed' })
      .where(
        and(eq(carrierObligations.bookingId, b!.id), eq(carrierObligations.status, 'committed')),
      );
    await shipmentEvent(
      tx,
      shipmentId,
      'dispute.opened',
      { userId: session.user.id, orgId: session.org?.id },
      { kind: input.kind },
    );
    await notifyOrg(tx, b!.carrierOrgId, 'loads.accept', {
      kind: 'dispute.opened',
      shipmentId,
      dedupeKey: `dispute:${d!.id}`,
    });
    return d!;
  });
}

export const resolveDisputeSchema = z.object({
  decision: z.enum(['rejected', 'resolved']),
  /** Given back to the customer */
  customerRefundMinor: z.number().int().min(0).default(0),
  /** Taken off the carrier's payout (part of the refund the carrier bears) */
  carrierDeductionMinor: z.number().int().min(0).default(0),
  note: z.string().trim().min(3).max(4000),
});

/**
 * Support decides. The refund to the customer is paid partly by the carrier (deduction from its
 * payout) and the rest by the platform (from its fee). Then the shipment completes and the
 * remaining payout goes out.
 */
export async function resolveDispute(
  ctx: Ctx,
  actor: Actor & { userId: string },
  disputeId: string,
  input: z.infer<typeof resolveDisputeSchema>,
) {
  await ctx.db.transaction(async (tx) => {
    const [d] = await tx.select().from(disputes).where(eq(disputes.id, disputeId)).for('update');
    if (!d) throw notFound();
    if (d.status !== 'open') throw conflict('already_resolved', `Already ${d.status}`);
    const [b] = await tx.select().from(bookings).where(eq(bookings.shipmentId, d.shipmentId));
    const refund = input.decision === 'resolved' ? input.customerRefundMinor : 0;
    const deduction = input.decision === 'resolved' ? input.carrierDeductionMinor : 0;
    if (refund > b!.totalMinor)
      throw badRequest('refund_too_high', 'The refund cannot be more than the customer paid');
    if (deduction > refund)
      throw badRequest('deduction_too_high', 'The carrier cannot bear more than the refund');
    if (deduction > b!.payoutMinor)
      throw badRequest('deduction_too_high', 'The deduction cannot be more than the payout');
    await lockShipment(tx, d.shipmentId);
    if (refund > 0) {
      await post(
        tx,
        {
          kind: 'dispute_settlement',
          refType: 'dispute',
          refId: d.id,
          idempotencyKey: `dispute:${d.id}`,
          currency: b!.currency,
        },
        [
          { account: 'carrier_payable', orgId: b!.carrierOrgId, amountMinor: deduction },
          { account: 'platform_revenue_deferred', amountMinor: refund - deduction },
          { account: 'customer_funds', orgId: d.openedByOrgId, amountMinor: -refund },
        ],
      );
      if (deduction > 0)
        await tx
          .update(carrierObligations)
          .set({ amountMinor: sql`${carrierObligations.amountMinor} - ${deduction}` })
          .where(eq(carrierObligations.bookingId, b!.id));
      // Pay the refund back through the provider, against the shipment's own payments
      const paid = await tx
        .select()
        .from(payments)
        .where(
          and(
            eq(payments.shipmentId, d.shipmentId),
            eq(payments.status, 'succeeded'),
            inArray(payments.purpose, ['prepayment', 'top_up']),
          ),
        );
      let left = refund;
      for (const p of paid) {
        if (left <= 0) break;
        const done = await tx.execute<{ v: number }>(
          sql`SELECT coalesce(sum(amount_minor),0)::bigint AS v FROM refunds WHERE payment_id = ${p.id} AND status <> 'failed'`,
        );
        const amount = Math.min(p.amountMinor - Number(done.rows[0]!.v), left);
        if (amount <= 0) continue;
        const key = `dispute:${d.id}:${p.id}`;
        const r = await ctx.payments.refund({
          providerRef: p.providerRef,
          amountMinor: amount,
          currency: p.currency,
          idempotencyKey: key,
        });
        const [row] = await tx
          .insert(refunds)
          .values({
            paymentId: p.id,
            shipmentId: d.shipmentId,
            amountMinor: amount,
            currency: p.currency,
            reason: 'dispute',
            status: r.status,
            providerRef: r.refundRef,
          })
          .returning();
        await post(
          tx,
          {
            kind: 'refund',
            refType: 'refund',
            refId: row!.id,
            idempotencyKey: `refund:${key}`,
            currency: p.currency,
          },
          [
            { account: 'customer_funds', orgId: p.orgId, amountMinor: amount },
            { account: 'psp_clearing', amountMinor: -amount },
          ],
        );
        left -= amount;
      }
      if (left > 0) throw new Error('not enough paid to refund');
    }
    await tx
      .update(disputes)
      .set({
        status: input.decision,
        resolution: input.note,
        customerRefundMinor: refund,
        carrierDeductionMinor: deduction,
        resolvedBy: actor.userId,
        resolvedAt: ctx.now(),
      })
      .where(eq(disputes.id, d.id));
    await complete(ctx, tx, d.shipmentId, 'dispute_resolution', actor, refund - deduction);
    await shipmentEvent(tx, d.shipmentId, 'dispute.resolved', actor, {
      decision: input.decision,
      customerRefundMinor: refund,
    });
    await audit(
      tx,
      actor,
      `dispute.${input.decision}`,
      { type: 'dispute', id: d.id },
      { refund, deduction },
    );
    await notifyOrg(tx, d.openedByOrgId, 'shipments.view', {
      kind: 'dispute.resolved',
      shipmentId: d.shipmentId,
      dedupeKey: `dispute-resolved:${d.id}`,
    });
    await notifyOrg(tx, b!.carrierOrgId, 'loads.accept', {
      kind: 'dispute.resolved',
      shipmentId: d.shipmentId,
      dedupeKey: `dispute-resolved:${d.id}`,
    });
  });
}

export async function listDisputes(ctx: Ctx, status?: string) {
  return ctx.db
    .select({
      d: disputes,
      shipper: organisations.name,
      number: shipments.number,
      totalMinor: bookings.totalMinor,
      payoutMinor: bookings.payoutMinor,
    })
    .from(disputes)
    .innerJoin(shipments, eq(shipments.id, disputes.shipmentId))
    .innerJoin(organisations, eq(organisations.id, disputes.openedByOrgId))
    .innerJoin(bookings, eq(bookings.shipmentId, disputes.shipmentId))
    .where(status ? eq(disputes.status, status) : sql`true`)
    .orderBy(desc(disputes.createdAt))
    .limit(200)
    .then((rows) =>
      rows.map((r) => ({
        ...r.d,
        shipper: r.shipper,
        number: r.number,
        totalMinor: r.totalMinor,
        payoutMinor: r.payoutMinor,
      })),
    );
}

export async function disputesOf(ctx: Ctx, session: SessionInfo, shipmentId: string) {
  await shipmentAccess(ctx, session, shipmentId);
  return ctx.db
    .select()
    .from(disputes)
    .where(eq(disputes.shipmentId, shipmentId))
    .orderBy(desc(disputes.createdAt));
}
