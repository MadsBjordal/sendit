import { and, eq } from 'drizzle-orm';
import type { Ctx } from '../context';
import { bookings, drivers, shipments } from '../db/schema';
import { notFound } from '../lib/errors';
import { platformCan } from './admin';
import type { SessionInfo } from './auth';

export type ShipmentRole = 'shipper' | 'carrier' | 'driver' | 'customs' | 'platform';

/** Extra ways to reach a shipment (customs brokers register one in the customs module). */
type Resolver = (
  ctx: Ctx,
  session: SessionInfo,
  shipmentId: string,
) => Promise<ShipmentRole | null>;
const extraResolvers: Resolver[] = [];
export function addShipmentAccessResolver(r: Resolver) {
  extraResolvers.push(r);
}

/**
 * Who may see a shipment, and as what. Everyone else gets 404 (never "forbidden", which would
 * reveal that the shipment exists).
 */
export async function shipmentAccess(ctx: Ctx, session: SessionInfo | null, shipmentId: string) {
  if (!session) throw notFound();
  const [s] = await ctx.db.select().from(shipments).where(eq(shipments.id, shipmentId));
  if (!s) throw notFound();
  const [b] = await ctx.db.select().from(bookings).where(eq(bookings.shipmentId, shipmentId));
  let role: ShipmentRole | null = null;
  if (
    session.user.platformRole &&
    session.mfaPassed &&
    platformCan(session.user.platformRole, 'shipments.view')
  )
    role = 'platform';
  else if (session.org && s.orgId === session.org.id) role = 'shipper';
  else if (session.org && b && b.carrierOrgId === session.org.id) {
    if (session.role === 'driver') {
      const [d] = b.driverId
        ? await ctx.db
            .select()
            .from(drivers)
            .where(and(eq(drivers.id, b.driverId), eq(drivers.userId, session.user.id)))
        : [];
      role = d ? 'driver' : null;
    } else role = 'carrier';
  }
  if (!role) for (const r of extraResolvers) if ((role = await r(ctx, session, shipmentId))) break;
  if (!role) throw notFound();
  return { role, shipment: s, booking: b ?? null };
}
