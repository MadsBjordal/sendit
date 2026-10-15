import { and, asc, eq } from 'drizzle-orm';
import type { Ctx } from '../context';
import { files, messageReads, messages, users } from '../db/schema';
import { badRequest } from '../lib/errors';
import { shipmentAccess } from './access';
import type { SessionInfo } from './auth';
import { notifyOrg } from './notifications';

/** Messages on a shipment. Everyone with access to the shipment sees them; names are shown as first names only. */
export async function listMessages(ctx: Ctx, session: SessionInfo, shipmentId: string) {
  await shipmentAccess(ctx, session, shipmentId);
  const rows = await ctx.db
    .select({ m: messages, name: users.name })
    .from(messages)
    .innerJoin(users, eq(users.id, messages.senderUserId))
    .where(eq(messages.shipmentId, shipmentId))
    .orderBy(asc(messages.createdAt))
    .limit(500);
  await ctx.db
    .insert(messageReads)
    .values({ shipmentId, userId: session.user.id, lastReadAt: ctx.now() })
    .onConflictDoUpdate({
      target: [messageReads.shipmentId, messageReads.userId],
      set: { lastReadAt: ctx.now() },
    });
  return rows.map(({ m, name }) => ({
    id: m.id,
    body: m.body,
    fileId: m.fileId,
    senderRole: m.senderRole,
    senderName: name.split(' ')[0],
    mine: m.senderUserId === session.user.id,
    createdAt: m.createdAt,
  }));
}

export async function sendMessage(
  ctx: Ctx,
  session: SessionInfo,
  shipmentId: string,
  input: { body: string; fileId?: string | null },
) {
  const { role, shipment, booking } = await shipmentAccess(ctx, session, shipmentId);
  if (input.fileId) {
    const [f] = await ctx.db
      .select()
      .from(files)
      .where(and(eq(files.id, input.fileId), eq(files.shipmentId, shipmentId)));
    if (!f) throw badRequest('file_not_found', 'The attachment was not uploaded for this shipment');
  }
  const [m] = await ctx.db
    .insert(messages)
    .values({
      shipmentId,
      senderUserId: session.user.id,
      senderOrgId: session.org?.id ?? null,
      senderRole: role,
      body: input.body,
      fileId: input.fileId ?? null,
    })
    .returning();
  // Tell the other side (one notification per shipment until they read it)
  const n = {
    kind: 'message.new',
    shipmentId,
    dedupeKey: `msg:${shipmentId}:${m!.createdAt.toISOString().slice(0, 13)}`,
  };
  if (role !== 'shipper') await notifyOrg(ctx.db, shipment.orgId, 'shipments.view', n);
  if (booking && role !== 'carrier' && role !== 'driver')
    await notifyOrg(ctx.db, booking.carrierOrgId, 'loads.accept', n);
  return m!;
}
