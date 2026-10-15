import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import type { PaymentPurpose } from '@freight/shared';
import type { Ctx } from '../context';
import type { Tx } from '../db/client';
import { offers, payments, paymentProviderEvents, refunds, shipments } from '../db/schema';
import { badRequest } from '../lib/errors';
import { shipmentEvent } from './audit';
import { enqueue, registerJob } from './jobs';
import { post } from './ledger';
import { notifyOrg } from './notifications';
import { payoutEvent } from './payouts';
import { chargebackEvent } from './chargebacks';
import { customsPaymentReceived } from './customs';
import { checkFailedPayments } from './fraud';

const SYSTEM = { userId: null, orgId: null };

export async function createPayment(
  ctx: Ctx,
  input: {
    shipmentId: string;
    orgId: string;
    purpose: PaymentPurpose;
    amountMinor: number;
    currency: string;
    offerId?: string;
  },
) {
  const res = await ctx.payments.createPayment({
    amountMinor: input.amountMinor,
    currency: input.currency,
    description: `Transport ${input.shipmentId} (${input.purpose})`,
    idempotencyKey: `${input.shipmentId}:${input.purpose}:${input.offerId ?? ''}:${Date.now()}`,
  });
  return {
    row: {
      shipmentId: input.shipmentId,
      orgId: input.orgId,
      purpose: input.purpose,
      offerId: input.offerId ?? null,
      amountMinor: input.amountMinor,
      currency: input.currency,
      provider: ctx.payments.name,
      providerRef: res.providerRef,
      status: 'pending',
    },
    clientAction: res.clientAction,
  };
}

/**
 * A provider webhook. Signature checked; each provider event is processed once (a repeat is
 * recognised by its event id and answered "duplicate"); payment rows are locked while changed.
 */
export async function handleWebhook(
  ctx: Ctx,
  rawBody: string,
  signature: string | undefined,
): Promise<{ result: string }> {
  const event = ctx.payments.parseWebhook(rawBody, signature);
  if (!event) throw badRequest('bad_signature', 'Webhook signature is not valid');
  return ctx.db.transaction(async (tx) => {
    const [stored] = await tx
      .insert(paymentProviderEvents)
      .values({
        provider: ctx.payments.name,
        providerEventId: event.id,
        type: event.type,
        payload: event,
      })
      .onConflictDoNothing()
      .returning({ id: paymentProviderEvents.id });
    if (!stored) return { result: 'duplicate' };
    const result = await processEvent(ctx, tx, event);
    await tx
      .update(paymentProviderEvents)
      .set({ result, processedAt: ctx.now() })
      .where(eq(paymentProviderEvents.id, stored.id));
    return { result };
  });
}

async function processEvent(
  ctx: Ctx,
  tx: Tx,
  event: {
    type: string;
    data: { providerRef: string; amountMinor: number; currency: string; reason?: string };
  },
): Promise<string> {
  if (event.type === 'refund.succeeded') return 'ignored';
  if (event.type === 'payout.paid' || event.type === 'payout.failed')
    return payoutEvent(ctx, tx, event.type, event.data.providerRef, event.data.reason);
  if (event.type === 'dispute.created' || event.type === 'dispute.closed')
    return chargebackEvent(ctx, tx, event.type, event.data);
  const [payment] = await tx
    .select()
    .from(payments)
    .where(
      and(
        eq(payments.provider, ctx.payments.name),
        eq(payments.providerRef, event.data.providerRef),
      ),
    )
    .for('update');
  if (!payment) return 'unknown_payment';
  // Lock order everywhere: shipment first is not possible here (we find it through the payment),
  // so the shipment is locked straight after; booking code locks the shipment and never the payment.
  const [shipment] = await tx
    .select()
    .from(shipments)
    .where(eq(shipments.id, payment.shipmentId))
    .for('update');
  if (!shipment) return 'unknown_shipment';
  const now = ctx.now();

  if (event.type === 'payment.failed') {
    if (payment.status !== 'pending') return `ignored_${payment.status}`;
    await tx
      .update(payments)
      .set({ status: 'failed', failureReason: event.data.reason ?? 'declined', updatedAt: now })
      .where(eq(payments.id, payment.id));
    await checkFailedPayments(tx, payment.orgId, now);
    if (payment.offerId)
      await tx
        .update(offers)
        .set({ status: 'pending_customer' })
        .where(and(eq(offers.id, payment.offerId), eq(offers.status, 'approved')));
    await shipmentEvent(tx, shipment.id, 'payment.failed', SYSTEM, {
      purpose: payment.purpose,
      reason: event.data.reason ?? 'declined',
    });
    await notifyOrg(tx, shipment.orgId, 'shipments.view', {
      kind: 'payment.failed',
      shipmentId: shipment.id,
      dedupeKey: `payment-failed:${payment.id}`,
    });
    return 'failed';
  }

  if (event.type !== 'payment.succeeded') return 'ignored';
  if (payment.status === 'succeeded') return 'already_succeeded';
  // Money that arrives for a payment we cancelled (or saw fail) is still money received:
  // it is recorded and then given back below, never ignored.
  if (event.data.amountMinor !== payment.amountMinor || event.data.currency !== payment.currency) {
    await shipmentEvent(tx, shipment.id, 'payment.amount_mismatch', SYSTEM, {
      expected: payment.amountMinor,
      got: event.data.amountMinor,
    });
    return 'amount_mismatch';
  }
  await tx
    .update(payments)
    .set({ status: 'succeeded', updatedAt: now })
    .where(eq(payments.id, payment.id));
  // Customs service payments belong to their customs job, not to the transport
  if (payment.customsJobId) return customsPaymentReceived(ctx, tx, payment);
  await post(
    tx,
    {
      kind: 'payment_received',
      refType: 'payment',
      refId: payment.id,
      idempotencyKey: `payment:${payment.id}:received`,
      currency: payment.currency,
    },
    [
      { account: 'psp_clearing', amountMinor: payment.amountMinor },
      { account: 'customer_funds', orgId: payment.orgId, amountMinor: -payment.amountMinor },
    ],
  );
  await tx
    .update(shipments)
    .set({ fundedMinor: sql`${shipments.fundedMinor} + ${payment.amountMinor}`, updatedAt: now })
    .where(eq(shipments.id, shipment.id));
  await shipmentEvent(tx, shipment.id, 'payment.succeeded', SYSTEM, {
    purpose: payment.purpose,
    amountMinor: payment.amountMinor,
  });

  if (payment.purpose === 'prepayment') {
    if (shipment.status !== 'awaiting_payment') {
      // Paid after cancelling, or a second payment: give it back
      await enqueue(
        tx,
        'refund_excess',
        {
          shipmentId: shipment.id,
          keepMinor:
            shipment.status === 'searching'
              ? shipment.maxPriceMinor
              : await keepFor(tx, shipment.id),
          reason: `late:${payment.id}`,
        },
        { dedupeKey: `refund:${shipment.id}:late:${payment.id}` },
      );
      return 'refund_queued';
    }
    const { publish } = await import('./booking');
    await publish(ctx, tx, shipment.id);
    return 'published';
  }
  // Top-up for an approved above-maximum offer
  const { finaliseApprovedOffer } = await import('./booking');
  const outcome = await finaliseApprovedOffer(ctx, tx, shipment.id, payment.offerId!);
  if (outcome !== 'booked')
    await enqueue(
      tx,
      'refund_excess',
      {
        shipmentId: shipment.id,
        keepMinor: await keepFor(
          tx,
          shipment.id,
          shipment.status === 'searching' ? shipment.maxPriceMinor : 0,
        ),
        reason: `topup:${payment.id}`,
      },
      { dedupeKey: `refund:${shipment.id}:topup:${payment.id}` },
    );
  return outcome === 'booked' ? 'booked' : `refund_queued_${outcome}`;
}

/** What must stay held for a shipment: its booking total, else `fallback`. */
async function keepFor(tx: Tx, shipmentId: string, fallback = 0): Promise<number> {
  const res = await tx.execute<{ total: number | null }>(
    sql`SELECT total_minor AS total FROM bookings WHERE shipment_id = ${shipmentId}`,
  );
  return Number(res.rows[0]?.total ?? fallback);
}

/**
 * Gives back everything held for a shipment above `keepMinor`, newest payment first.
 * The provider is called with a stable idempotency key, so a retried job cannot refund twice.
 */
registerJob('refund_excess', async (ctx, payload) => {
  const { shipmentId, keepMinor, reason } = payload as {
    shipmentId: string;
    keepMinor: number;
    reason: string;
  };
  await ctx.db.transaction(async (tx) => {
    const [s] = await tx.select().from(shipments).where(eq(shipments.id, shipmentId)).for('update');
    if (!s) return;
    const bookedTotal = await keepFor(tx, shipmentId, 0);
    let toRefund = s.fundedMinor - Math.max(keepMinor, bookedTotal);
    if (toRefund <= 0) return;
    const paid = await tx
      .select()
      .from(payments)
      .where(
        and(
          eq(payments.shipmentId, shipmentId),
          eq(payments.status, 'succeeded'),
          inArray(payments.purpose, ['prepayment', 'top_up']),
        ),
      )
      .orderBy(desc(payments.createdAt));
    for (const p of paid) {
      if (toRefund <= 0) break;
      const [{ refunded }] = (
        await tx.execute<{ refunded: number }>(
          sql`SELECT coalesce(sum(amount_minor), 0)::bigint AS refunded FROM refunds WHERE payment_id = ${p.id} AND status <> 'failed'`,
        )
      ).rows as [{ refunded: number }];
      const available = p.amountMinor - Number(refunded);
      const amount = Math.min(available, toRefund);
      if (amount <= 0) continue;
      const key = `${shipmentId}:${reason}:${p.id}`;
      const r = await ctx.payments.refund({
        providerRef: p.providerRef,
        amountMinor: amount,
        currency: p.currency,
        idempotencyKey: key,
      });
      const [refund] = await tx
        .insert(refunds)
        .values({
          paymentId: p.id,
          shipmentId,
          amountMinor: amount,
          currency: p.currency,
          reason,
          status: r.status,
          providerRef: r.refundRef,
        })
        .returning();
      await post(
        tx,
        {
          kind: 'refund',
          refType: 'refund',
          refId: refund!.id,
          idempotencyKey: `refund:${key}`,
          currency: p.currency,
        },
        [
          { account: 'customer_funds', orgId: p.orgId, amountMinor: amount },
          { account: 'psp_clearing', amountMinor: -amount },
        ],
      );
      await tx
        .update(shipments)
        .set({ fundedMinor: sql`${shipments.fundedMinor} - ${amount}` })
        .where(eq(shipments.id, shipmentId));
      await shipmentEvent(tx, shipmentId, 'payment.refunded', SYSTEM, {
        amountMinor: amount,
        reason,
      });
      toRefund -= amount;
    }
  });
});
