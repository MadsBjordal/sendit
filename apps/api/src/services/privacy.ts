import { randomBytes } from 'node:crypto';
import { desc, eq, or, sql } from 'drizzle-orm';
import type { Ctx } from '../context';
import {
  auditLogs,
  memberships,
  messages,
  notifications,
  organisations,
  privacyRequests,
  sessions,
  supportMessages,
  users,
} from '../db/schema';
import { conflict, notFound } from '../lib/errors';
import { audit, type Actor } from './audit';
import { hashPassword, type SessionInfo } from './auth';

import { enqueue, registerJob } from './jobs';

/**
 * GDPR requests. A copy of one's personal data is produced at once (JSON file). Erasure is checked
 * by a person first: records the law requires us to keep (invoices, payments, the ledger, proofs of
 * delivery) stay, but the person's name, email and login are removed from them.
 */
export async function requestExport(ctx: Ctx, session: SessionInfo) {
  const uid = session.user.id;
  const [u] = await ctx.db.select().from(users).where(eq(users.id, uid));
  const data = {
    generatedAt: ctx.now().toISOString(),
    user: {
      id: u!.id,
      name: u!.name,
      email: u!.email,
      locale: u!.locale,
      createdAt: u!.createdAt,
      emailVerifiedAt: u!.emailVerifiedAt,
      notificationPrefs: u!.notificationPrefs,
    },
    memberships: await ctx.db
      .select({ org: organisations.name, role: memberships.role, since: memberships.createdAt })
      .from(memberships)
      .innerJoin(organisations, eq(organisations.id, memberships.orgId))
      .where(eq(memberships.userId, uid)),
    sessions: await ctx.db
      .select({
        createdAt: sessions.createdAt,
        lastSeenAt: sessions.lastSeenAt,
        ip: sessions.ip,
        userAgent: sessions.userAgent,
      })
      .from(sessions)
      .where(eq(sessions.userId, uid)),
    notifications: await ctx.db
      .select({ kind: notifications.kind, createdAt: notifications.createdAt })
      .from(notifications)
      .where(eq(notifications.userId, uid)),
    messages: await ctx.db
      .select({
        shipmentId: messages.shipmentId,
        body: messages.body,
        createdAt: messages.createdAt,
      })
      .from(messages)
      .where(eq(messages.senderUserId, uid)),
    supportMessages: await ctx.db
      .select({ body: supportMessages.body, createdAt: supportMessages.createdAt })
      .from(supportMessages)
      .where(eq(supportMessages.userId, uid)),
    activity: await ctx.db
      .select({ action: auditLogs.action, at: auditLogs.createdAt, ip: auditLogs.ip })
      .from(auditLogs)
      .where(eq(auditLogs.actorUserId, uid))
      .orderBy(desc(auditLogs.id))
      .limit(1000),
  };
  await ctx.db
    .insert(privacyRequests)
    .values({ userId: uid, kind: 'export', status: 'completed', completedAt: ctx.now() });
  await audit(ctx.db, { userId: uid }, 'privacy.export');
  return data;
}

export async function requestErasure(ctx: Ctx, session: SessionInfo, note: string | null) {
  const [open] = await ctx.db
    .select()
    .from(privacyRequests)
    .where(
      sql`${privacyRequests.userId} = ${session.user.id} AND ${privacyRequests.kind} = 'erase' AND ${privacyRequests.status} = 'pending'`,
    );
  if (open) throw conflict('already_requested', 'Your request is already being handled');
  const [r] = await ctx.db
    .insert(privacyRequests)
    .values({ userId: session.user.id, kind: 'erase', status: 'pending', note })
    .returning();
  await audit(ctx.db, { userId: session.user.id }, 'privacy.erase_requested', {
    type: 'privacy_request',
    id: r!.id,
  });
  return r!;
}

export async function listPrivacyRequests(ctx: Ctx) {
  return ctx.db
    .select({ r: privacyRequests, email: users.email, name: users.name })
    .from(privacyRequests)
    .innerJoin(users, eq(users.id, privacyRequests.userId))
    .orderBy(desc(privacyRequests.createdAt))
    .limit(200)
    .then((rows) => rows.map((x) => ({ ...x.r, email: x.email, name: x.name })));
}

/** Staff carry out (or refuse, with a reason) an erasure request. */
export async function handleErasure(
  ctx: Ctx,
  actor: Actor & { userId: string },
  requestId: string,
  decision: 'completed' | 'rejected',
  note: string | null,
) {
  await ctx.db.transaction(async (tx) => {
    const [r] = await tx
      .select()
      .from(privacyRequests)
      .where(eq(privacyRequests.id, requestId))
      .for('update');
    if (!r || r.kind !== 'erase') throw notFound();
    if (r.status !== 'pending') throw conflict('already_handled', `Already ${r.status}`);
    if (decision === 'completed') {
      await tx
        .update(users)
        .set({
          name: 'Deleted user',
          email: `deleted-${r.userId}@invalid.example`,
          passwordHash: await hashPassword(randomBytes(32).toString('hex')),
          mfaSecret: null,
          mfaEnabled: false,
          active: false,
          notificationPrefs: {},
        })
        .where(eq(users.id, r.userId));
      await tx
        .update(sessions)
        .set({ revokedAt: ctx.now(), ip: null, userAgent: null })
        .where(eq(sessions.userId, r.userId));
      await tx.update(memberships).set({ active: false }).where(eq(memberships.userId, r.userId));
      await tx.delete(notifications).where(eq(notifications.userId, r.userId));
    }
    await tx
      .update(privacyRequests)
      .set({
        status: decision,
        note: note ?? r.note,
        handledBy: actor.userId,
        completedAt: ctx.now(),
      })
      .where(eq(privacyRequests.id, r.id));
    await audit(tx, actor, `privacy.erase_${decision}`, { type: 'privacy_request', id: r.id });
  });
}

/** Keeps data only as long as needed. Runs daily. */
registerJob('retention', async (ctx) => {
  const days = (n: number) => new Date(ctx.now().getTime() - n * 86_400_000).toISOString();
  await ctx.db
    .delete(sessions)
    .where(or(sql`${sessions.expiresAt} < ${days(30)}`, sql`${sessions.revokedAt} < ${days(30)}`)!);
  await ctx.db.execute(sql`DELETE FROM email_outbox WHERE created_at < ${days(90)}`);
  await ctx.db.delete(notifications).where(sql`${notifications.createdAt} < ${days(365)}`);
  await enqueue(
    ctx.db,
    'retention',
    {},
    { runAt: new Date(ctx.now().getTime() + 86_400_000), dedupeKey: 'retention' },
  );
});
