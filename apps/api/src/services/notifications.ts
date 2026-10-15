import { and, eq, inArray } from 'drizzle-orm';
import type { DbOrTx } from '../db/client';
import { memberships, notifications } from '../db/schema';
import { ROLE_PERMISSIONS, type MemberRole } from '@freight/shared';

/**
 * In-app notifications (push, email and SMS channels plug in here later). Each notification has a
 * dedupe key per person, so a retried job never notifies twice.
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
  await db
    .insert(notifications)
    .values({
      userId,
      kind: n.kind,
      orgId: n.orgId ?? null,
      shipmentId: n.shipmentId ?? null,
      data: n.data ?? {},
      dedupeKey: n.dedupeKey,
    })
    .onConflictDoNothing();
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
