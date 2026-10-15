import { and, eq, inArray } from 'drizzle-orm';
import { ROLE_PERMISSIONS, type MemberRole } from '@freight/shared';
import type { DbOrTx } from '../db/client';
import { memberships, notifications, users } from '../db/schema';
import { enqueue, registerJob } from './jobs';

/**
 * Notifications: always in-app; the important kinds also by email (a job after commit, once per
 * notification, unless the person turned that kind off). Push and SMS plug in at the same place.
 * Each notification has a dedupe key per person, so a retried job never notifies twice.
 */
export async function notifyUser(
  db: DbOrTx,
  userId: string,
  n: {
    kind: string;
    orgId?: string | null;
    shipmentId?: string | null;
    data?: object;
    dedupeKey: string;
  },
) {
  const [row] = await db
    .insert(notifications)
    .values({
      userId,
      kind: n.kind,
      orgId: n.orgId ?? null,
      shipmentId: n.shipmentId ?? null,
      data: n.data ?? {},
      dedupeKey: n.dedupeKey,
    })
    .onConflictDoNothing()
    .returning({ id: notifications.id });
  if (row && EMAIL_KINDS[n.kind])
    await enqueue(
      db,
      'notification_email',
      { notificationId: row.id },
      { dedupeKey: `notif-email:${row.id}` },
    );
}

/** Notifies every active member of an organisation whose role has the permission. */
export async function notifyOrg(
  db: DbOrTx,
  orgId: string,
  permission: string,
  n: { kind: string; shipmentId?: string | null; data?: object; dedupeKey: string },
) {
  const roles = (Object.keys(ROLE_PERMISSIONS) as MemberRole[]).filter((r) =>
    ROLE_PERMISSIONS[r].includes(permission),
  );
  const members = await db
    .select({ userId: memberships.userId })
    .from(memberships)
    .where(
      and(
        eq(memberships.orgId, orgId),
        eq(memberships.active, true),
        inArray(memberships.role, roles),
      ),
    );
  for (const m of members) await notifyUser(db, m.userId, { ...n, orgId });
}

/** Notifications that also go by email, with their subject (English; localised email templates are a later step). */
export const EMAIL_KINDS: Record<string, string> = {
  'shipment.booked': 'A carrier has been booked for your shipment',
  'offer.above_max': 'A carrier asks for more than your maximum',
  'payment.failed': 'Your payment failed',
  'shipment.expired': 'No carrier was found for your shipment',
  'booking.confirmed': 'You have a new job',
  'driver.assigned': 'You have been assigned a job',
  'shipment.collected': 'Your shipment has been collected',
  'shipment.delivered': 'Your shipment has been delivered',
  'payout.sent': 'Your payout has been sent',
  'customs.action_needed': 'Customs: action needed',
  'customs.job_matched': 'New customs job available',
  'dispute.opened': 'A dispute was opened',
};

registerJob('notification_email', async (ctx, payload) => {
  const { notificationId } = payload as { notificationId: string };
  const [n] = await ctx.db.select().from(notifications).where(eq(notifications.id, notificationId));
  if (!n) return;
  const [u] = await ctx.db.select().from(users).where(eq(users.id, n.userId));
  if (!u || !u.active) return;
  const prefs = (u.notificationPrefs ?? {}) as Record<string, { email?: boolean }>;
  if (prefs[n.kind]?.email === false) return;
  const link = n.shipmentId
    ? `${ctx.config.publicUrl}/go/${n.shipmentId}`
    : `${ctx.config.publicUrl}/notifications`;
  const subject = EMAIL_KINDS[n.kind] ?? 'There is an update for you';
  await ctx.email.send(ctx.db, {
    to: u.email,
    template: `notification:${n.kind}`,
    subject: `${subject} · ${ctx.config.brand.name}`,
    body: `Hello ${u.name},\n\n${subject}.\n\nOpen: ${link}\n\nYou can choose which emails you receive under Settings.`,
  });
});
