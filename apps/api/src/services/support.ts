import { and, asc, desc, eq } from 'drizzle-orm';
import { z } from 'zod';
import type { Ctx } from '../context';
import { organisations, supportMessages, supportTickets, users } from '../db/schema';
import { notFound } from '../lib/errors';
import type { SessionInfo } from './auth';
import { shipmentAccess } from './access';
import { notifyUser } from './notifications';

export const ticketSchema = z.object({
  subject: z.string().trim().min(3).max(200),
  body: z.string().trim().min(3).max(8000),
  shipmentId: z.string().uuid().nullable().optional(),
});

export async function createTicket(
  ctx: Ctx,
  session: SessionInfo,
  input: z.infer<typeof ticketSchema>,
) {
  if (input.shipmentId) await shipmentAccess(ctx, session, input.shipmentId);
  return ctx.db.transaction(async (tx) => {
    const [t] = await tx
      .insert(supportTickets)
      .values({
        orgId: session.org?.id ?? null,
        userId: session.user.id,
        shipmentId: input.shipmentId ?? null,
        subject: input.subject,
        status: 'open',
      })
      .returning();
    await tx
      .insert(supportMessages)
      .values({ ticketId: t!.id, userId: session.user.id, fromStaff: false, body: input.body });
    return t!;
  });
}

const isStaff = (s: SessionInfo) => !!s.user.platformRole && s.mfaPassed;

/** A person sees the tickets of their organisation; support staff see all. */
async function ticketFor(ctx: Ctx, session: SessionInfo, id: string) {
  const [t] = await ctx.db.select().from(supportTickets).where(eq(supportTickets.id, id));
  if (!t) throw notFound();
  if (
    !isStaff(session) &&
    !(t.orgId && t.orgId === session.org?.id) &&
    t.userId !== session.user.id
  )
    throw notFound();
  return t;
}

export async function listTickets(ctx: Ctx, session: SessionInfo, status?: string) {
  const where = isStaff(session)
    ? status
      ? eq(supportTickets.status, status)
      : undefined
    : session.org
      ? eq(supportTickets.orgId, session.org.id)
      : eq(supportTickets.userId, session.user.id);
  return ctx.db
    .select({ t: supportTickets, org: organisations.name })
    .from(supportTickets)
    .leftJoin(organisations, eq(organisations.id, supportTickets.orgId))
    .where(
      where
        ? status && !isStaff(session)
          ? and(where, eq(supportTickets.status, status))
          : where
        : undefined,
    )
    .orderBy(desc(supportTickets.updatedAt))
    .limit(200)
    .then((rows) => rows.map((r) => ({ ...r.t, org: r.org })));
}

export async function ticketDetail(ctx: Ctx, session: SessionInfo, id: string) {
  const t = await ticketFor(ctx, session, id);
  const msgs = await ctx.db
    .select({ m: supportMessages, name: users.name })
    .from(supportMessages)
    .innerJoin(users, eq(users.id, supportMessages.userId))
    .where(eq(supportMessages.ticketId, id))
    .orderBy(asc(supportMessages.createdAt));
  return {
    ...t,
    messages: msgs.map((r) => ({
      id: r.m.id,
      body: r.m.body,
      fromStaff: r.m.fromStaff,
      name: r.m.fromStaff ? 'Support' : r.name,
      createdAt: r.m.createdAt,
    })),
  };
}

export async function replyTicket(
  ctx: Ctx,
  session: SessionInfo,
  id: string,
  body: string,
  close = false,
) {
  const t = await ticketFor(ctx, session, id);
  const staff = isStaff(session);
  await ctx.db
    .insert(supportMessages)
    .values({ ticketId: id, userId: session.user.id, fromStaff: staff, body });
  await ctx.db
    .update(supportTickets)
    .set({ status: close ? 'closed' : staff ? 'answered' : 'open', updatedAt: ctx.now() })
    .where(eq(supportTickets.id, id));
  if (staff)
    await notifyUser(ctx.db, t.userId, {
      kind: 'support.answered',
      orgId: t.orgId,
      shipmentId: t.shipmentId,
      dedupeKey: `support:${id}:${ctx.now().toISOString()}`,
    });
}
