import { and, desc, eq, ne, sql } from 'drizzle-orm';
import type { Ctx } from '../context';
import type { DbOrTx } from '../db/client';
import { carrierObligations, fraudAlerts, organisations, payoutAccounts } from '../db/schema';
import { conflict, notFound } from '../lib/errors';
import { audit, type Actor } from './audit';
import { enqueue } from './jobs';

/**
 * Simple, explainable fraud rules. Each alert is for a person to review; the payout-account rule
 * also holds the money until reviewed (changing bank details just before a payout is a classic
 * account-takeover pattern).
 */
export async function raiseAlert(
  db: DbOrTx,
  a: {
    kind: string;
    severity: 'low' | 'medium' | 'high';
    orgId?: string | null;
    shipmentId?: string | null;
    refType?: string;
    refId?: string;
    details?: object;
    dedupeKey: string;
  },
) {
  await db
    .insert(fraudAlerts)
    .values({
      kind: a.kind,
      severity: a.severity,
      orgId: a.orgId ?? null,
      shipmentId: a.shipmentId ?? null,
      refType: a.refType ?? null,
      refId: a.refId ?? null,
      details: a.details ?? {},
      dedupeKey: a.dedupeKey,
    })
    .onConflictDoNothing();
}

export const PAYOUT_ACCOUNT_COOLDOWN_HOURS = 48;

/** Should this payout wait for a review? True when the bank details changed recently and nobody has cleared it. */
export async function payoutNeedsReview(
  db: DbOrTx,
  obligationId: string,
  orgId: string,
  now: Date,
): Promise<boolean> {
  const [acc] = await db.select().from(payoutAccounts).where(eq(payoutAccounts.orgId, orgId));
  if (!acc || acc.updatedAt.getTime() < now.getTime() - PAYOUT_ACCOUNT_COOLDOWN_HOURS * 3_600_000)
    return false;
  const [cleared] = await db
    .select({ id: fraudAlerts.id })
    .from(fraudAlerts)
    .where(
      and(
        eq(fraudAlerts.refType, 'obligation'),
        eq(fraudAlerts.refId, obligationId),
        eq(fraudAlerts.status, 'dismissed'),
        sql`${fraudAlerts.reviewedAt} >= ${acc.updatedAt.toISOString()}`,
      ),
    );
  return !cleared;
}

/** The same bank account on two different companies. */
export async function checkSharedIban(db: DbOrTx, orgId: string, iban: string) {
  const others = await db
    .select({ orgId: payoutAccounts.orgId })
    .from(payoutAccounts)
    .where(and(eq(payoutAccounts.iban, iban), ne(payoutAccounts.orgId, orgId)));
  if (others.length)
    await raiseAlert(db, {
      kind: 'shared_payout_account',
      severity: 'medium',
      orgId,
      details: { otherOrgIds: others.map((o) => o.orgId) },
      dedupeKey: `shared-iban:${orgId}:${others
        .map((o) => o.orgId)
        .sort()
        .join(',')}`,
    });
}

export async function listAlerts(ctx: Ctx, status = 'open') {
  return ctx.db
    .select({ a: fraudAlerts, orgName: organisations.name })
    .from(fraudAlerts)
    .leftJoin(organisations, eq(organisations.id, fraudAlerts.orgId))
    .where(eq(fraudAlerts.status, status))
    .orderBy(desc(fraudAlerts.createdAt))
    .limit(200)
    .then((rows) => rows.map((r) => ({ ...r.a, orgName: r.orgName })));
}

/**
 * Review an alert. Dismissed = fine (held money is released); confirmed = fraud (optionally the
 * company is suspended; held money stays held).
 */
export async function reviewAlert(
  ctx: Ctx,
  actor: Actor & { userId: string },
  alertId: string,
  decision: 'dismissed' | 'confirmed',
  note: string | null,
  suspend: boolean,
) {
  await ctx.db.transaction(async (tx) => {
    const [a] = await tx
      .select()
      .from(fraudAlerts)
      .where(eq(fraudAlerts.id, alertId))
      .for('update');
    if (!a) throw notFound();
    if (a.status !== 'open') throw conflict('already_reviewed', `Already ${a.status}`);
    await tx
      .update(fraudAlerts)
      .set({ status: decision, reviewedBy: actor.userId, reviewedAt: ctx.now(), reviewNote: note })
      .where(eq(fraudAlerts.id, a.id));
    if (decision === 'dismissed' && a.refType === 'obligation' && a.refId) {
      const [o] = await tx
        .update(carrierObligations)
        .set({ status: 'payable' })
        .where(and(eq(carrierObligations.id, a.refId), eq(carrierObligations.status, 'on_hold')))
        .returning();
      if (o)
        await enqueue(
          tx,
          'carrier_payout',
          { obligationId: o.id },
          { dedupeKey: `payout:${o.id}:released:${a.id}` },
        );
    }
    if (decision === 'confirmed' && suspend && a.orgId)
      await tx
        .update(organisations)
        .set({ status: 'suspended', statusNote: 'Suspended after a fraud review' })
        .where(eq(organisations.id, a.orgId));
    await audit(
      tx,
      actor,
      `fraud.${decision}`,
      { type: 'fraud_alert', id: a.id },
      { note, suspend },
    );
  });
}

/** Several failed payments from one company in a day */
export async function checkFailedPayments(db: DbOrTx, orgId: string, now: Date) {
  const res = await db.execute<{ n: number }>(
    sql`SELECT count(*)::int AS n FROM payments WHERE org_id = ${orgId} AND status = 'failed' AND updated_at > ${new Date(now.getTime() - 86_400_000).toISOString()}`,
  );
  if (Number(res.rows[0]?.n ?? 0) >= 3)
    await raiseAlert(db, {
      kind: 'repeated_failed_payments',
      severity: 'medium',
      orgId,
      details: { last24h: res.rows[0]!.n },
      dedupeKey: `failed-payments:${orgId}:${now.toISOString().slice(0, 10)}`,
    });
}
