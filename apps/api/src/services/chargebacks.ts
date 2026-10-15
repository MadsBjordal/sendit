import { and, eq } from 'drizzle-orm';
import type { Ctx } from '../context';
import type { Tx } from '../db/client';
import { payments } from '../db/schema';
import { audit, shipmentEvent } from './audit';
import { post } from './ledger';

/**
 * A customer's bank or card scheme pulls money back (chargeback). The carrier guarantee does not
 * change: the carrier is still paid. The platform carries the loss and recovers it from the
 * customer (receivable), which is why bookings are prepaid and why fraud checks matter.
 */
export async function chargebackEvent(
  ctx: Ctx,
  tx: Tx,
  type: 'dispute.created' | 'dispute.closed',
  data: { providerRef: string; amountMinor: number; currency: string; reason?: string },
): Promise<string> {
  const [p] = await tx
    .select()
    .from(payments)
    .where(
      and(eq(payments.provider, ctx.payments.name), eq(payments.providerRef, data.providerRef)),
    );
  if (!p) return 'unknown_payment';
  const key = `chargeback:${p.id}:${type}`;
  if (type === 'dispute.created') {
    await post(
      tx,
      {
        kind: 'chargeback',
        refType: 'payment',
        refId: p.id,
        idempotencyKey: key,
        currency: data.currency,
      },
      [
        { account: 'chargeback_receivable', orgId: p.orgId, amountMinor: data.amountMinor },
        { account: 'psp_clearing', amountMinor: -data.amountMinor },
      ],
    );
    await shipmentEvent(
      tx,
      p.shipmentId,
      'payment.chargeback',
      { userId: null, orgId: null },
      { amountMinor: data.amountMinor, reason: data.reason },
    );
    await audit(
      tx,
      { userId: null, orgId: p.orgId },
      'payment.chargeback_opened',
      { type: 'payment', id: p.id },
      { amountMinor: data.amountMinor, reason: data.reason },
    );
    return 'chargeback_recorded';
  }
  // Closed in our favour: the money comes back
  if (data.reason === 'won') {
    await post(
      tx,
      {
        kind: 'chargeback_won',
        refType: 'payment',
        refId: p.id,
        idempotencyKey: key,
        currency: data.currency,
      },
      [
        { account: 'psp_clearing', amountMinor: data.amountMinor },
        { account: 'chargeback_receivable', orgId: p.orgId, amountMinor: -data.amountMinor },
      ],
    );
    return 'chargeback_won';
  }
  await audit(
    tx,
    { userId: null, orgId: p.orgId },
    'payment.chargeback_lost',
    { type: 'payment', id: p.id },
    { amountMinor: data.amountMinor },
  );
  return 'chargeback_lost';
}
