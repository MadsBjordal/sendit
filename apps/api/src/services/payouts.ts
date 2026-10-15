import { and, desc, eq, inArray } from 'drizzle-orm';
import { z } from 'zod';
import type { Ctx } from '../context';
import type { Tx } from '../db/client';
import { carrierObligations, payoutAccounts, payouts } from '../db/schema';
import { badRequest } from '../lib/errors';
import { audit, type Actor } from './audit';
import { enqueue, registerJob } from './jobs';
import { post } from './ledger';
import { notifyOrg } from './notifications';

/** ISO 13616 IBAN check (mod 97). Does not prove the account exists. */
export function validIban(raw: string): boolean {
  const iban = raw.replace(/\s/g, '').toUpperCase();
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{10,30}$/.test(iban)) return false;
  const moved = iban.slice(4) + iban.slice(0, 4);
  const digits = moved.replace(/[A-Z]/g, (c) => String(c.charCodeAt(0) - 55));
  let rem = 0;
  for (const ch of digits) rem = (rem * 10 + Number(ch)) % 97;
  return rem === 1;
}

export function maskIban(iban: string): string {
  const c = iban.replace(/\s/g, '');
  return `${c.slice(0, 4)} •••• ${c.slice(-4)}`;
}

export const payoutAccountSchema = z.object({
  holderName: z.string().trim().min(2).max(200),
  iban: z.string().trim().min(15).max(42),
  bic: z
    .string()
    .trim()
    .regex(/^[A-Z0-9]{8}([A-Z0-9]{3})?$/i)
    .nullable()
    .optional(),
});

export async function setPayoutAccount(
  ctx: Ctx,
  actor: Actor & { userId: string; orgId: string },
  input: z.infer<typeof payoutAccountSchema>,
) {
  if (!validIban(input.iban)) throw badRequest('bad_iban', 'This IBAN is not valid');
  const iban = input.iban.replace(/\s/g, '').toUpperCase();
  const values = {
    holderName: input.holderName,
    iban,
    bic: input.bic?.toUpperCase() ?? null,
    updatedBy: actor.userId,
    updatedAt: ctx.now(),
  };
  await ctx.db
    .insert(payoutAccounts)
    .values({ orgId: actor.orgId, ...values })
    .onConflictDoUpdate({ target: payoutAccounts.orgId, set: values });
  // Changing where money goes is a fraud target: always audited (never the full IBAN in the log)
  await audit(
    ctx.db,
    actor,
    'payout_account.changed',
    { type: 'organisation', id: actor.orgId },
    { iban: maskIban(iban) },
  );
  // Payouts waiting for bank details can go now
  const waiting = await ctx.db
    .select({ id: carrierObligations.id })
    .from(carrierObligations)
    .where(
      and(
        eq(carrierObligations.carrierOrgId, actor.orgId),
        eq(carrierObligations.status, 'payable'),
      ),
    );
  for (const o of waiting)
    await enqueue(
      ctx.db,
      'carrier_payout',
      { obligationId: o.id },
      { dedupeKey: `payout:${o.id}` },
    );
}

export async function payoutAccountView(ctx: Ctx, orgId: string) {
  const [a] = await ctx.db.select().from(payoutAccounts).where(eq(payoutAccounts.orgId, orgId));
  return a
    ? { holderName: a.holderName, iban: maskIban(a.iban), bic: a.bic, updatedAt: a.updatedAt }
    : null;
}

/**
 * Sends the carrier's money once the obligation is payable (delivery accepted, no dispute).
 * The payout is booked in the ledger when started; the provider later confirms arrival by webhook.
 */
registerJob('carrier_payout', async (ctx, payload) => {
  const { obligationId } = payload as { obligationId: string };
  await ctx.db.transaction(async (tx) => {
    const [o] = await tx
      .select()
      .from(carrierObligations)
      .where(eq(carrierObligations.id, obligationId))
      .for('update');
    if (!o || o.status !== 'payable') return;
    const [existing] = await tx
      .select()
      .from(payouts)
      .where(and(eq(payouts.obligationId, o.id), inArray(payouts.status, ['pending', 'paid'])));
    if (existing) return;
    const failedBefore = (
      await tx
        .select({ id: payouts.id })
        .from(payouts)
        .where(and(eq(payouts.obligationId, o.id), eq(payouts.status, 'failed')))
    ).length;
    const [account] = await tx
      .select()
      .from(payoutAccounts)
      .where(eq(payoutAccounts.orgId, o.carrierOrgId));
    if (!account) {
      await notifyOrg(tx, o.carrierOrgId, 'finance.view', {
        kind: 'payout.account_missing',
        dedupeKey: `payout-account:${o.carrierOrgId}`,
      });
      return; // runs again when bank details are added
    }
    const res = await ctx.payouts.createPayout({
      amountMinor: o.amountMinor,
      currency: o.currency,
      iban: account.iban,
      holderName: account.holderName,
      reference: `Payout ${o.id.slice(0, 8)}`,
      // A new key after a failed attempt, the same key when this job is retried
      idempotencyKey: `payout:${o.id}:${failedBefore}`,
    });
    const [p] = await tx
      .insert(payouts)
      .values({
        obligationId: o.id,
        orgId: o.carrierOrgId,
        amountMinor: o.amountMinor,
        currency: o.currency,
        provider: ctx.payouts.name,
        providerRef: res.payoutRef,
        status: res.status,
        ibanMasked: maskIban(account.iban),
        initiatedAt: ctx.now(),
        paidAt: res.status === 'paid' ? ctx.now() : null,
      })
      .returning();
    await post(
      tx,
      {
        kind: 'payout',
        refType: 'payout',
        refId: p!.id,
        idempotencyKey: `payout:${p!.id}`,
        currency: o.currency,
      },
      [
        { account: 'carrier_payable', orgId: o.carrierOrgId, amountMinor: o.amountMinor },
        { account: 'psp_clearing', amountMinor: -o.amountMinor },
      ],
    );
    if (res.status === 'paid')
      await tx
        .update(carrierObligations)
        .set({ status: 'paid', paidAt: ctx.now() })
        .where(eq(carrierObligations.id, o.id));
    await enqueue(
      tx,
      'issue_carrier_statement',
      { obligationId: o.id },
      { dedupeKey: `statement:${o.id}` },
    );
    await notifyOrg(tx, o.carrierOrgId, 'finance.view', {
      kind: 'payout.sent',
      data: { amountMinor: o.amountMinor },
      dedupeKey: `payout-sent:${o.id}`,
    });
  });
});

/** Provider says the payout arrived or failed (called from the payments webhook). */
export async function payoutEvent(
  ctx: Ctx,
  tx: Tx,
  type: 'payout.paid' | 'payout.failed',
  providerRef: string,
  reason?: string,
): Promise<string> {
  const [p] = await tx
    .select()
    .from(payouts)
    .where(eq(payouts.providerRef, providerRef))
    .for('update');
  if (!p) return 'unknown_payout';
  if (p.status !== 'pending') return `ignored_${p.status}`;
  if (type === 'payout.paid') {
    await tx.update(payouts).set({ status: 'paid', paidAt: ctx.now() }).where(eq(payouts.id, p.id));
    await tx
      .update(carrierObligations)
      .set({ status: 'paid', paidAt: ctx.now() })
      .where(eq(carrierObligations.id, p.obligationId));
    return 'paid';
  }
  await tx
    .update(payouts)
    .set({ status: 'failed', failureReason: reason ?? 'failed' })
    .where(eq(payouts.id, p.id));
  // The money is back: we owe the carrier again, and they need to check their bank details
  await post(
    tx,
    {
      kind: 'payout_failed',
      refType: 'payout',
      refId: p.id,
      idempotencyKey: `payout-failed:${p.id}`,
      currency: p.currency,
    },
    [
      { account: 'psp_clearing', amountMinor: p.amountMinor },
      { account: 'carrier_payable', orgId: p.orgId, amountMinor: -p.amountMinor },
    ],
  );
  await tx
    .update(carrierObligations)
    .set({ status: 'on_hold' })
    .where(eq(carrierObligations.id, p.obligationId));
  await notifyOrg(tx, p.orgId, 'finance.view', {
    kind: 'payout.failed',
    dedupeKey: `payout-failed:${p.id}`,
  });
  return 'failed';
}

/** Retry after a failed payout (new bank details). The failed payout stays as history. */
export async function retryFailedPayouts(ctx: Ctx, orgId: string) {
  const held = await ctx.db
    .select()
    .from(carrierObligations)
    .where(
      and(eq(carrierObligations.carrierOrgId, orgId), eq(carrierObligations.status, 'on_hold')),
    );
  for (const o of held) {
    await ctx.db
      .update(carrierObligations)
      .set({ status: 'payable' })
      .where(eq(carrierObligations.id, o.id));
    await enqueue(
      ctx.db,
      'carrier_payout',
      { obligationId: o.id },
      { dedupeKey: `payout:${o.id}:retry` },
    );
  }
}

export async function carrierEarnings(ctx: Ctx, orgId: string) {
  const obligations = await ctx.db
    .select()
    .from(carrierObligations)
    .where(eq(carrierObligations.carrierOrgId, orgId))
    .orderBy(desc(carrierObligations.createdAt))
    .limit(500);
  const list = await ctx.db
    .select()
    .from(payouts)
    .where(eq(payouts.orgId, orgId))
    .orderBy(desc(payouts.createdAt))
    .limit(500);
  const sum = (st: string[]) =>
    obligations.filter((o) => st.includes(o.status)).reduce((n, o) => n + o.amountMinor, 0);
  return {
    totals: {
      upcomingMinor: sum(['committed']),
      payableMinor: sum(['payable', 'on_hold']),
      paidMinor: sum(['paid']),
      heldMinor: sum(['disputed']),
    },
    obligations,
    payouts: list,
    account: await payoutAccountView(ctx, orgId),
  };
}
